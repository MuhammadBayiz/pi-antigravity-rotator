// Minimal local HTTP proxy for tests. Forwards each request directly to the
// target it names (no upstream, no auth), so tests can point an account's
// `proxy` at it and exercise the REAL per-account dispatcher path (undici
// ProxyAgent) against a local mock upstream. This mirrors production, where
// every account MUST route through a proxy (fail-closed).

import { createServer, request as httpRequest, type Server } from "node:http";
import { connect as netConnect } from "node:net";

export interface TestProxy {
	url: string;
	port: number;
	close: () => Promise<void>;
}

export async function startDirectProxy(): Promise<TestProxy> {
	const server: Server = createServer((creq, cres) => {
		// undici sends proxied HTTP requests in absolute-form (req.url is a full URL).
		let target: URL;
		try {
			target = new URL(creq.url ?? "");
		} catch {
			cres.writeHead(400).end();
			return;
		}
		const proxied = httpRequest(
			{
				host: target.hostname,
				port: target.port || 80,
				method: creq.method,
				path: `${target.pathname}${target.search}`,
				headers: { ...creq.headers },
			},
			(pres) => {
				cres.writeHead(pres.statusCode ?? 502, pres.headers);
				// Flush headers immediately so a streaming upstream that only sent
				// headers (no body yet) still reaches the client -- otherwise
				// client-abort-before-first-chunk tests deadlock.
				cres.flushHeaders?.();
				pres.pipe(cres);
			},
		);
		proxied.on("error", () => {
			try {
				cres.writeHead(502).end();
			} catch {
				/* already closed */
			}
		});
		// Propagate a client disconnect straight to the upstream so in-flight
		// requests are released promptly (mirrors a real proxy).
		const abortUpstream = (): void => {
			proxied.destroy();
		};
		creq.on("aborted", abortUpstream);
		cres.on("close", () => {
			if (!cres.writableEnded) abortUpstream();
		});
		creq.pipe(proxied);
	});

	// HTTPS targets arrive as CONNECT; tunnel straight through.
	server.on("connect", (req, clientSocket, head) => {
		const [host, portStr] = (req.url ?? "").split(":");
		const upstream = netConnect(parseInt(portStr, 10) || 443, host, () => {
			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head && head.length) upstream.write(head);
			upstream.pipe(clientSocket);
			clientSocket.pipe(upstream);
		});
		upstream.on("error", () => clientSocket.destroy());
		clientSocket.on("error", () => upstream.destroy());
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	return {
		url: `http://127.0.0.1:${port}`,
		port,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((err) => (err ? reject(err) : resolve())),
			),
	};
}
