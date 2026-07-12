// Launches a real browser window pre-configured to use a specific proxy, so
// the one-time OAuth consent (login.ts) exits through the same address as the
// account's --proxy, instead of the device's default network route.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
 * Resolve a DISPLAY value for the child process. If the current shell
 * already exports one, use it untouched. Otherwise, on Linux/Android
 * (Termux), look for a live X11 socket directly -- an X server (e.g.
 * termux-x11) can be running as its own app/process without ever exporting
 * DISPLAY into unrelated shell sessions, so `process.env.DISPLAY` being
 * unset does not mean no display exists.
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
 * Resolve which browser binary to launch. Honors the widely-used `BROWSER`
 * env var override first (same convention as Create React App, xdg-open
 * wrappers, etc.), then falls back to common per-platform binary names.
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

export interface ProxyBrowserLaunch {
	binary: string;
	proxyServerArg: string;
	authNote?: string;
}

/**
 * Rewrite the account's proxy URL into a Chromium --proxy-server value.
 *
 * Chromium has no way to supply SOCKS5 username/password authentication
 * (no command-line flag and no auth-dialog fallback the way it has for
 * HTTP CONNECT proxies), so an authenticated socks5/socks5h URL is rewritten
 * to an http:// proxy pointed at the same host/port. This works whenever the
 * upstream proxy is dual-protocol (accepts HTTP CONNECT on the same port as
 * SOCKS5), which is common for commercial proxy providers but not guaranteed
 * -- if the provider is SOCKS5-only, the browser's native proxy-auth prompt
 * will fail and the user should fall back to the manual URL + system VPN.
 */
export function buildProxyServerArg(proxyUrl: string): { arg: string; credentialNote?: string } {
	const parsed = new URL(proxyUrl);
	const isSocks = parsed.protocol === "socks5:" || parsed.protocol === "socks5h:";
	const scheme = isSocks ? "http" : parsed.protocol.replace(":", "");
	const arg = `${scheme}://${parsed.hostname}:${parsed.port}`;

	if (!parsed.username) return { arg };

	const username = decodeURIComponent(parsed.username);
	const password = parsed.password ? decodeURIComponent(parsed.password) : "";
	const note =
		`Chromium cannot embed proxy credentials -- if it prompts for proxy authentication, enter:\n` +
		`    username: ${username}\n` +
		`    password: ${password}` +
		(isSocks
			? `\n(Rewrote ${parsed.protocol}//${parsed.hostname}:${parsed.port} to ${arg} because Chromium does not support SOCKS5 auth; this requires the proxy to also accept HTTP CONNECT on the same port.)`
			: "");

	return { arg, credentialNote: note };
}

export interface BrowserLaunchResult {
	ok: boolean;
	credentialNote?: string;
	/** Set when ok is false and a binary was found but exited immediately (e.g. no display). */
	failureReason?: string;
	/** Present when ok is true: terminates the launched browser window. */
	close?: () => void;
}

/**
 * Launch a browser window in an isolated temporary profile, routed through
 * the given proxy, pointed at the given URL. Never throws: returns
 * `{ ok: false }` if no usable browser binary was found, or if the process
 * launched but exited within the grace window (e.g. no X server/DISPLAY on
 * Termux), so callers can fall back to printing the URL for manual use.
 */
export async function launchProxiedBrowser(
	url: string,
	proxyUrl: string,
): Promise<BrowserLaunchResult> {
	const binary = resolveBrowserBinary();
	if (!binary) return { ok: false };

	const { arg: proxyServerArg, credentialNote } = buildProxyServerArg(proxyUrl);
	const profileDir = mkdtempSync(join(tmpdir(), "pi-rotator-login-"));
	const display = resolveDisplay();

	const child = spawn(
		binary,
		[
			`--user-data-dir=${profileDir}`,
			`--proxy-server=${proxyServerArg}`,
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
		return {
			ok: false,
			failureReason: stderr.trim() || `${binary} exited immediately (no display/X server available?)`,
		};
	}

	// The browser window is intentionally left running past this point (the
	// user still needs to complete sign-in in it), but its stderr pipe was
	// only needed to detect the immediate-crash case above. A long-lived pipe
	// with an active listener keeps Node's event loop alive even after
	// child.unref(), which would otherwise leave the CLI hanging until the
	// browser is closed by hand -- so stop reading it now.
	child.stderr?.destroy();
	child.unref();
	return {
		ok: true,
		credentialNote,
		close: () => {
			try {
				child.kill();
			} catch {
				// already exited
			}
		},
	};
}
