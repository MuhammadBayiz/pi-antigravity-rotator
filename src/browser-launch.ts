// Launches a real browser window whose traffic exits through a specific
// account's proxy, so the one-time OAuth consent (login.ts) leaves from the
// same residential IP the account uses at runtime -- never the device's IP.
//
// Approach (based on the proven month-stable ~/gemini_cookie_harvest.js):
// Chromium cannot embed proxy credentials (no SOCKS5 auth flag; the HTTP
// proxy-auth dialog is unusable for automation). So instead of pointing
// Chromium at the authenticated upstream proxy directly, we stand up a tiny
// LOCAL proxy on 127.0.0.1 that Chromium talks to with NO auth, and that local
// proxy forwards every connection to the upstream proxy WITH the credentials
// injected. Works for HTTP(S) upstreams (CONNECT + Proxy-Authorization) and
// SOCKS5 upstreams (via the `socks` client). DNS is resolved at the upstream
// proxy in both cases, so there is no DNS leak.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SocksClient } from "socks";

function commandExists(name: string): boolean {
	try {
		const checker = process.platform === "win32" ? "where" : "which";
		execFileSync(checker, [name], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve a DISPLAY value for the child process. If the current shell already
 * exports one, use it untouched. Otherwise, on Linux/Android (Termux) look for
 * a live X11 socket directly -- Termux-X11 can run as its own app/process
 * without exporting DISPLAY into unrelated shells.
 */
function resolveDisplay(): string | undefined {
	if (process.env.DISPLAY) return process.env.DISPLAY;
	if (process.platform === "darwin" || process.platform === "win32") return undefined;

	const socketDirs = ["/tmp/.X11-unix", `${process.env.PREFIX ?? ""}/tmp/.X11-unix`].filter(Boolean);
	for (const dir of socketDirs) {
		for (let n = 0; n <= 3; n++) {
			if (existsSync(join(dir, `X${n}`))) return `:${n}`;
		}
	}
	return undefined;
}

/**
 * Resolve which browser binary to launch. Honors the `BROWSER` env var override
 * first (same convention as xdg-open wrappers), then common per-platform names.
 */
function resolveBrowserBinary(): string | undefined {
	const override = process.env.BROWSER;
	if (override) return override;

	const candidates =
		process.platform === "darwin"
			? [
					"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
					"/Applications/Chromium.app/Contents/MacOS/Chromium",
				]
			: process.platform === "win32"
				? ["chrome", "chrome.exe", "msedge", "msedge.exe"]
				: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"];

	for (const candidate of candidates) {
		if (candidate.includes("/")) {
			if (existsSync(candidate)) return candidate;
			continue;
		}
		if (commandExists(candidate)) return candidate;
	}
	return undefined;
}

interface ParsedUpstream {
	kind: "socks" | "http";
	host: string;
	port: number;
	username?: string;
	password?: string;
}

function parseUpstream(proxyUrl: string): ParsedUpstream {
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

export interface LocalAuthProxy {
	port: number;
	close: () => void;
}

/**
 * Start a local, credential-free proxy on 127.0.0.1 that forwards to the
 * authenticated upstream. Chromium points at this with `--proxy-server` and
 * never sees credentials. Returns the chosen ephemeral port.
 */
export function startLocalAuthProxy(proxyUrl: string): Promise<LocalAuthProxy> {
	const up = parseUpstream(proxyUrl);
	const basicAuth =
		up.username !== undefined
			? "Basic " + Buffer.from(`${up.username}:${up.password ?? ""}`).toString("base64")
			: undefined;

	// Open a tunnel to `${host}:${port}` through the upstream and hand back the
	// established socket (already past the proxy handshake).
	function openUpstreamTunnel(
		host: string,
		port: number,
		onReady: (sock: Socket) => void,
		onError: (err: Error) => void,
	): void {
		if (up.kind === "socks") {
			SocksClient.createConnection({
				proxy: {
					host: up.host,
					port: up.port,
					type: 5,
					userId: up.username,
					password: up.password,
				},
				command: "connect",
				// Pass the hostname unresolved so the SOCKS server does DNS (no leak).
				destination: { host, port },
			})
				.then(({ socket }) => onReady(socket as Socket))
				.catch(onError);
			return;
		}
		// HTTP upstream: CONNECT with injected Proxy-Authorization.
		const sock = netConnect(up.port, up.host, () => {
			let head =
				`CONNECT ${host}:${port} HTTP/1.1\r\n` + `Host: ${host}:${port}\r\n`;
			if (basicAuth) head += `Proxy-Authorization: ${basicAuth}\r\n`;
			head += "\r\n";
			sock.write(head);
		});
		let established = false;
		const onData = (chunk: Buffer): void => {
			if (established) return;
			const text = chunk.toString("latin1");
			const status = text.slice(0, text.indexOf("\r\n"));
			if (/^HTTP\/1\.[01] 2\d\d/.test(status)) {
				established = true;
				sock.removeListener("data", onData);
				onReady(sock);
			} else {
				sock.destroy();
				onError(new Error(`Upstream proxy refused CONNECT: ${status || "no response"}`));
			}
		};
		sock.on("data", onData);
		sock.once("error", onError);
	}

	return new Promise((resolve) => {
		const server: Server = createServer();

		// HTTPS (and WebSocket) CONNECT tunneling -- the overwhelming majority of
		// browser traffic to Google.
		server.on("connect", (req, clientSocket, head) => {
			const [host, portStr] = (req.url ?? "").split(":");
			const port = parseInt(portStr, 10) || 443;
			if (!host) {
				clientSocket.destroy();
				return;
			}
			openUpstreamTunnel(
				host,
				port,
				(upstream) => {
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
				},
				() => clientSocket.destroy(),
			);
		});

		// Plain HTTP (rare for Google, but handle it via the same upstream).
		server.on("request", (creq, cres) => {
			let target: URL;
			try {
				target = new URL(creq.url ?? "");
			} catch {
				cres.writeHead(400).end();
				return;
			}
			const port = parseInt(target.port, 10) || 80;
			if (up.kind === "http") {
				const proxied = httpRequest(
					{
						host: up.host,
						port: up.port,
						method: creq.method,
						path: creq.url,
						headers: {
							...creq.headers,
							...(basicAuth ? { "Proxy-Authorization": basicAuth } : {}),
						},
					},
					(pres) => {
						cres.writeHead(pres.statusCode ?? 502, pres.headers);
						pres.pipe(cres);
					},
				);
				proxied.on("error", () => cres.destroy());
				creq.pipe(proxied);
			} else {
				openUpstreamTunnel(
					target.hostname,
					port,
					(upstream) => {
						upstream.write(
							`${creq.method} ${target.pathname}${target.search} HTTP/1.1\r\n` +
								`Host: ${target.host}\r\n` +
								"Connection: close\r\n\r\n",
						);
						upstream.pipe(cres.socket!);
						creq.pipe(upstream);
					},
					() => cres.destroy(),
				);
			}
		});

		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			resolve({ port, close: () => server.close() });
		});
	});
}

export interface BrowserLaunchResult {
	ok: boolean;
	/** Kept for API compatibility; unused now that credentials are auto-injected. */
	credentialNote?: string;
	/** Set when ok is false and a binary was found but exited immediately (e.g. no display). */
	failureReason?: string;
	/** Present when ok is true: terminates the launched browser window + local proxy. */
	close?: () => void;
}

/**
 * Launch a browser window in an isolated temporary profile, routed through the
 * account's proxy via a local auth-injecting forwarder, pointed at `url`.
 * WebRTC/QUIC are disabled so the real IP cannot leak over UDP. Never throws:
 * returns `{ ok: false }` if no usable browser binary was found or it exited
 * immediately (e.g. no X server), so callers can fall back to a manual URL.
 */
export async function launchProxiedBrowser(
	url: string,
	proxyUrl: string,
): Promise<BrowserLaunchResult> {
	const binary = resolveBrowserBinary();
	if (!binary) return { ok: false };

	const localProxy = await startLocalAuthProxy(proxyUrl);
	const profileDir = mkdtempSync(join(tmpdir(), "pi-rotator-login-"));
	const display = resolveDisplay();

	let child: ChildProcess;
	try {
		child = spawn(
			binary,
			[
				`--user-data-dir=${profileDir}`,
				`--proxy-server=http://127.0.0.1:${localProxy.port}`,
				// Do NOT bypass loopback: default keeps localhost (the OAuth callback
				// listener on 127.0.0.1:51121) direct while everything else proxies.
				// Leak hardening: keep all real-IP-revealing UDP off.
				"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
				"--webrtc-ip-handling-policy=disable_non_proxied_udp",
				"--disable-quic",
				// Stealth: reduce "this browser may not be secure" blocks.
				"--disable-blink-features=AutomationControlled",
				"--disable-infobars",
				"--no-sandbox",
				"--disable-gpu",
				"--no-first-run",
				"--no-default-browser-check",
				url,
			],
			{
				detached: true,
				stdio: ["ignore", "ignore", "pipe"],
				env: display ? { ...process.env, DISPLAY: display } : process.env,
			},
		);
	} catch {
		localProxy.close();
		return { ok: false };
	}

	let stderr = "";
	child.stderr?.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	const crashed = await new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), 1500);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve(true);
		});
		child.once("error", () => {
			clearTimeout(timer);
			resolve(true);
		});
	});

	if (crashed) {
		localProxy.close();
		return {
			ok: false,
			failureReason: stderr.trim() || `${binary} exited immediately (no display/X server available?)`,
		};
	}

	// Stop reading stderr so the pipe can't keep Node's event loop alive after
	// unref() -- the browser stays up for the user to complete sign-in.
	child.stderr?.destroy();
	child.unref();
	return {
		ok: true,
		close: () => {
			try {
				child.kill();
			} catch {
				// already exited
			}
			localProxy.close();
		},
	};
}
