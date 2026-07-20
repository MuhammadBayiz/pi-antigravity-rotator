import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import { connect as netConnect } from "node:net";
import * as tls from "node:tls";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachMitm } from "../src/mitm.js";

const certDir = mkdtempSync(join(tmpdir(), "pi-mitm-test-"));
let server: Server;
let port: number;
let caPem: Buffer;

before(async () => {
	server = createServer((req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				ok: true,
				host: req.headers.host,
				url: req.url,
				// Set by mitm.ts on the terminated socket so client-auth's guard can
				// exempt agy's forward-proxy traffic.
				mitmAuthorized:
					(req.socket as unknown as { __mitmAuthorized?: boolean })
						.__mitmAuthorized === true,
			}),
		);
	});
	attachMitm(server, { certDir, getBlindTunnelProxy: () => undefined });
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	port = (server.address() as { port: number }).port;
	caPem = readFileSync(join(certDir, "ca.crt"));
});

after(() => server.close());

function connectThenTls(host: string): Promise<{ authorized: boolean; body: string }> {
	return new Promise((resolve, reject) => {
		const raw = netConnect(port, "127.0.0.1", () => {
			raw.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
		});
		let established = false;
		raw.on("data", (chunk) => {
			if (established) return;
			if (!/^HTTP\/1\.[01] 200/.test(chunk.toString())) return;
			established = true;
			const sock = tls.connect({ socket: raw, servername: host, ca: caPem }, () => {
				sock.write(
					`POST /v1internal:loadCodeAssist HTTP/1.1\r\nHost: ${host}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
				);
			});
			let body = "";
			sock.on("data", (d) => (body += d.toString()));
			sock.on("end", () => resolve({ authorized: sock.authorized, body }));
			sock.on("error", reject);
		});
		raw.on("error", reject);
		setTimeout(() => reject(new Error("timeout")), 12_000);
	});
}

describe("MITM forward proxy", () => {
	it("terminates a Code Assist host with a CA-trusted cert and routes the decrypted request", async () => {
		const { authorized, body } = await connectThenTls("cloudcode-pa.googleapis.com");
		// The client trusted our leaf cert via the local CA (no cert override).
		assert.equal(authorized, true);
		// The decrypted request reached the server's normal handler.
		assert.match(body, /"ok":true/);
		assert.match(body, /v1internal:loadCodeAssist/);
	});

	it("tags the terminated socket as __mitmAuthorized so the client-key guard exempts it", async () => {
		const { body } = await connectThenTls("cloudcode-pa.googleapis.com");
		assert.match(body, /"mitmAuthorized":true/);
	});

	it("drops a blocked telemetry host (fail-closed, no tunnel)", async () => {
		await assert.rejects(connectThenTls("play.googleapis.com"));
	});
});

describe("MITM CONNECT authorization (forward-proxy client key)", () => {
	let authServer: Server;
	let authPort: number;
	const GOOD = "Basic " + Buffer.from("secret-key:").toString("base64");

	before(async () => {
		authServer = createServer((req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
		attachMitm(authServer, {
			certDir,
			getBlindTunnelProxy: () => undefined,
			// Accept only the CONNECT whose Proxy-Authorization carries "secret-key".
			authorizeConnect: (pa) =>
				!!pa && pa === GOOD,
		});
		await new Promise<void>((r) => authServer.listen(0, "127.0.0.1", () => r()));
		authPort = (authServer.address() as { port: number }).port;
	});
	after(() => authServer.close());

	// Send a CONNECT with an optional Proxy-Authorization header; resolve the raw
	// status line so we can distinguish 407 from 200.
	function connectStatus(proxyAuth?: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const raw = netConnect(authPort, "127.0.0.1", () => {
				let head = "CONNECT cloudcode-pa.googleapis.com:443 HTTP/1.1\r\nHost: cloudcode-pa.googleapis.com:443\r\n";
				if (proxyAuth) head += `Proxy-Authorization: ${proxyAuth}\r\n`;
				raw.write(head + "\r\n");
			});
			raw.once("data", (chunk) => {
				const line = chunk.toString().split("\r\n")[0];
				raw.destroy();
				resolve(line);
			});
			raw.on("error", reject);
			setTimeout(() => reject(new Error("timeout")), 8_000);
		});
	}

	it("rejects a CONNECT with no client key (407)", async () => {
		assert.match(await connectStatus(), /407/);
	});
	it("rejects a CONNECT with a wrong client key (407)", async () => {
		assert.match(await connectStatus("Basic " + Buffer.from("nope:").toString("base64")), /407/);
	});
	it("accepts a CONNECT carrying the correct client key (200)", async () => {
		assert.match(await connectStatus(GOOD), /200/);
	});
});
