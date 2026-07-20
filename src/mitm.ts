// MITM forward-proxy mode.
//
// Some clients (notably the Antigravity CLI `agy`) can only be pointed at Google
// via the standard HTTPS_PROXY env var -- they have no base-URL override. A
// plain CONNECT tunnel would be opaque, so the rotator could neither rotate the
// account nor hide the device IP (the tunnel would exit from the real IP). This
// module makes the rotator a *terminating* forward proxy for the Code Assist
// hosts: it answers CONNECT, presents a certificate signed by a local CA the
// client trusts, decrypts the request, and feeds it straight back into the
// rotator's own HTTP handler -- which already rotates the account and forwards
// through that account's per-account proxy. Every other host is blind-tunnelled
// through a per-account proxy so nothing ever leaves on the device's real IP.
//
// The CA private key never leaves the config dir (0600). Enable with
// PI_ROTATOR_MITM=on (or config.enableMitm); it forces a loopback bind.

import { execFileSync } from "node:child_process";
import { connect as netConnect, type Socket } from "node:net";
import * as tls from "node:tls";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import { SocksClient } from "socks";
import { logger } from "./logger.js";

const mitmLogger = logger.child("mitm");

// Hosts whose TLS we terminate + route through the rotator (account rotation).
// Everything else is blind-tunnelled (no termination, no rotation, no leak).
export const MITM_TERMINATE_HOSTS = new Set([
	"cloudcode-pa.googleapis.com",
	"daily-cloudcode-pa.googleapis.com",
	"daily-cloudcode-pa.sandbox.googleapis.com",
]);

// Hosts we drop entirely (fail-closed, no leak): agy's own telemetry. Blocking
// beats tunnelling it -- there's nothing to gain from sending it.
export const MITM_BLOCK_HOSTS = new Set([
	"play.googleapis.com",
]);

function openssl(args: string[], input?: string): void {
	execFileSync("openssl", args, {
		input,
		stdio: input ? ["pipe", "ignore", "pipe"] : ["ignore", "ignore", "pipe"],
	});
}

interface CaFiles {
	caCertPath: string;
	caKeyPath: string;
	caCertPem: string;
}

/** Load the local MITM CA, generating it once if absent. */
export function ensureCa(certDir: string): CaFiles {
	mkdirSync(certDir, { recursive: true });
	const caKeyPath = join(certDir, "ca.key");
	const caCertPath = join(certDir, "ca.crt");
	if (!existsSync(caKeyPath) || !existsSync(caCertPath)) {
		mitmLogger.log("info", "Generating local MITM CA (one-time)...");
		openssl([
			"req", "-x509", "-newkey", "rsa:2048",
			"-keyout", caKeyPath, "-out", caCertPath,
			"-days", "3650", "-nodes",
			"-subj", "/CN=pi-antigravity-rotator local MITM CA",
			"-addext", "basicConstraints=critical,CA:TRUE",
			"-addext", "keyUsage=critical,keyCertSign,cRLSign",
		]);
		chmodSync(caKeyPath, 0o600);
		chmodSync(caCertPath, 0o644);
	}
	return { caCertPath, caKeyPath, caCertPem: readFileSync(caCertPath, "utf8") };
}

/** Per-host leaf certificate, cached on disk + in memory as a SecureContext. */
class LeafStore {
	private readonly ctxCache = new Map<string, tls.SecureContext>();
	constructor(
		private readonly certDir: string,
		private readonly ca: CaFiles,
	) {}

	private sanitize(host: string): string {
		return host.replace(/[^a-zA-Z0-9._-]/g, "_");
	}

	getContext(host: string): tls.SecureContext {
		const cached = this.ctxCache.get(host);
		if (cached) return cached;

		const base = join(this.certDir, this.sanitize(host));
		const keyPath = `${base}.key`;
		const certPath = `${base}.crt`;
		if (!existsSync(keyPath) || !existsSync(certPath)) {
			this.mint(host, keyPath, certPath);
		}
		const ctx = tls.createSecureContext({
			key: readFileSync(keyPath),
			cert: readFileSync(certPath),
			ca: this.ca.caCertPem,
		});
		this.ctxCache.set(host, ctx);
		return ctx;
	}

	private mint(host: string, keyPath: string, certPath: string): void {
		const csrPath = `${keyPath}.csr`;
		const extPath = `${keyPath}.ext`;
		openssl(["genrsa", "-out", keyPath, "2048"]);
		chmodSync(keyPath, 0o600);
		openssl(["req", "-new", "-key", keyPath, "-out", csrPath, "-subj", `/CN=${host}`]);
		writeFileSync(
			extPath,
			`subjectAltName=DNS:${host}\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\n`,
		);
		openssl([
			"x509", "-req", "-in", csrPath,
			"-CA", this.ca.caCertPath, "-CAkey", this.ca.caKeyPath, "-CAcreateserial",
			"-out", certPath, "-days", "825", "-extfile", extPath,
		]);
	}
}

interface Upstream {
	kind: "socks" | "http";
	host: string;
	port: number;
	username?: string;
	password?: string;
}

function parseUpstream(proxyUrl: string): Upstream {
	const u = new URL(proxyUrl);
	const isSocks = u.protocol === "socks5:" || u.protocol === "socks5h:";
	return {
		kind: isSocks ? "socks" : "http",
		host: u.hostname,
		port: parseInt(u.port, 10) || (isSocks ? 1080 : 8080),
		username: u.username ? decodeURIComponent(u.username) : undefined,
		password: u.password ? decodeURIComponent(u.password) : undefined,
	};
}

/** Open a raw tunnel to host:port through the given proxy; pipe both ways. */
function blindTunnel(
	host: string,
	port: number,
	clientSocket: Socket,
	head: Buffer,
	proxyUrl: string | undefined,
): void {
	// Fail-closed: with no proxy we must NOT dial out on the real IP.
	if (!proxyUrl) {
		clientSocket.destroy();
		return;
	}
	const up = parseUpstream(proxyUrl);
	const onReady = (upstream: Socket): void => {
		clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		if (head && head.length) upstream.write(head);
		upstream.pipe(clientSocket);
		clientSocket.pipe(upstream);
		const kill = (): void => {
			upstream.destroy();
			clientSocket.destroy();
		};
		upstream.once("error", kill);
		clientSocket.once("error", kill);
	};

	if (up.kind === "socks") {
		SocksClient.createConnection({
			proxy: { host: up.host, port: up.port, type: 5, userId: up.username, password: up.password },
			command: "connect",
			destination: { host, port },
		})
			.then(({ socket }) => onReady(socket as Socket))
			.catch(() => clientSocket.destroy());
		return;
	}
	// HTTP upstream: CONNECT with injected Proxy-Authorization.
	const basicAuth =
		up.username !== undefined
			? "Basic " + Buffer.from(`${up.username}:${up.password ?? ""}`).toString("base64")
			: undefined;
	const sock = netConnect(up.port, up.host, () => {
		let h = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`;
		if (basicAuth) h += `Proxy-Authorization: ${basicAuth}\r\n`;
		sock.write(h + "\r\n");
	});
	let established = false;
	const onData = (chunk: Buffer): void => {
		if (established) return;
		if (/^HTTP\/1\.[01] 2\d\d/.test(chunk.toString("latin1"))) {
			established = true;
			sock.removeListener("data", onData);
			onReady(sock);
		} else {
			sock.destroy();
			clientSocket.destroy();
		}
	};
	sock.on("data", onData);
	sock.once("error", () => clientSocket.destroy());
}

export interface MitmOptions {
	certDir: string;
	/** Proxy used to blind-tunnel non-terminated hosts (agy's own oauth/telemetry). */
	getBlindTunnelProxy: () => string | undefined;
	/**
	 * Optional gate on the CONNECT itself. Given the request's Proxy-Authorization
	 * header, return false to reject with 407. This is the wall for the forward-proxy
	 * (agy) path when the rotator is exposed as a shared service: agy's MITM traffic
	 * is exempt from the HTTP client-key guard (client-auth.ts), so without this the
	 * forward proxy would be an open relay to the account pool. Returns true (open)
	 * when no client keys are configured, mirroring the HTTP guard's local default.
	 */
	authorizeConnect?: (proxyAuthorization: string | undefined) => boolean;
}

/**
 * Attach MITM CONNECT handling to the rotator's HTTP server. Terminated Code
 * Assist hosts are decrypted and re-emitted as plaintext connections on the
 * same server (so the existing v1internal route rotates + proxies them); all
 * other hosts are blind-tunnelled through a per-account proxy.
 */
export function attachMitm(server: Server, opts: MitmOptions): CaFiles {
	const ca = ensureCa(opts.certDir);
	const leaves = new LeafStore(opts.certDir, ca);
	// Warm the known hosts so the first request isn't slowed by cert minting.
	for (const host of MITM_TERMINATE_HOSTS) {
		try {
			leaves.getContext(host);
		} catch (err) {
			mitmLogger.log("warn", `Could not pre-generate cert for ${host}: ${err}`);
		}
	}

	server.on("connect", (req, clientSocket, head) => {
		const [host, portStr] = (req.url ?? "").split(":");
		const port = parseInt(portStr, 10) || 443;
		if (!host) {
			clientSocket.destroy();
			return;
		}
		clientSocket.on("error", () => clientSocket.destroy());

		// Gate the forward-proxy path: agy must present a valid client key as
		// Proxy-Authorization (HTTPS_PROXY=http://<key>@host:port). Without this,
		// the MITM path -- which is exempt from the HTTP client-key guard -- would
		// be an open relay to the Google account pool once exposed.
		if (opts.authorizeConnect && !opts.authorizeConnect(req.headers["proxy-authorization"])) {
			clientSocket.write(
				"HTTP/1.1 407 Proxy Authentication Required\r\n" +
					'Proxy-Authenticate: Basic realm="pi-antigravity-rotator"\r\n' +
					"Connection: close\r\n\r\n",
			);
			clientSocket.destroy();
			return;
		}

		if (MITM_BLOCK_HOSTS.has(host)) {
			// Silently drop (agy telemetry). Fire-and-forget on agy's side.
			clientSocket.destroy();
			return;
		}

		if (MITM_TERMINATE_HOSTS.has(host)) {
			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			// Any bytes already read past the CONNECT line belong to the TLS
			// ClientHello -- put them back so the TLS socket sees them.
			if (head && head.length) clientSocket.unshift(head);
			let tlsSocket: tls.TLSSocket;
			try {
				tlsSocket = new tls.TLSSocket(clientSocket, {
					isServer: true,
					secureContext: leaves.getContext(host),
					SNICallback: (servername, cb) => {
						try {
							cb(null, leaves.getContext(servername || host));
						} catch (err) {
							cb(err as Error);
						}
					},
				});
			} catch (err) {
				mitmLogger.log("error", `TLS termination failed for ${host}: ${err}`);
				clientSocket.destroy();
				return;
			}
			tlsSocket.on("error", () => tlsSocket.destroy());
			// Mark the terminated socket as MITM-authorized: requests arriving on
			// it are agy's own forward-proxy traffic (the client already
			// authenticated to reach the rotator via loopback / SSH tunnel, and
			// agy speaks Google's protocol with a Google token -- it cannot
			// present our client key). client-auth.ts's requireClientKey bypasses
			// the client-key guard for these sockets.
			(tlsSocket as unknown as { __mitmAuthorized?: boolean }).__mitmAuthorized = true;
			// Feed the decrypted connection back into the rotator's HTTP server:
			// agy's `POST /v1internal:streamGenerateContent` then hits the normal
			// route -> account rotation + per-account outbound proxy.
			server.emit("connection", tlsSocket);
			return;
		}

		// Not a Code Assist host: blind-tunnel through a per-account proxy so the
		// real IP is never exposed (agy's own token refresh / telemetry / etc.).
		blindTunnel(host, port, clientSocket as Socket, head, opts.getBlindTunnelProxy());
	});

	mitmLogger.log("info", `MITM forward-proxy active (terminating: ${[...MITM_TERMINATE_HOSTS].join(", ")})`);
	return ca;
}
