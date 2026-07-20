// `browse` command: open a URL in a real browser routed through a specific
// account's proxy, and keep the proxy alive until the window is closed.
//
// Purpose: when agy (or Google) hands back a "verify your account" URL AFTER
// login, the login browser's ephemeral proxy is already gone. This reopens a
// browser through the SAME account's residential proxy so the verification (or
// any manual step) exits from the same IP the account was created on.
//
// Usage:
//   pi-antigravity-rotator browse --account <email> <url>
//   pi-antigravity-rotator browse --proxy <proxy-url> <url>

import { loadOrCreateAccountsConfig } from "./account-store.js";
import { launchProxiedBrowser } from "./browser-launch.js";
import { verifyProxyEgress } from "./proxy-agent.js";

function argValue(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	return idx !== -1 ? args[idx + 1] : undefined;
}

export async function runBrowse(args: string[]): Promise<void> {
	const email = argValue(args, "--account");
	let proxyUrl = argValue(args, "--proxy");
	// The target URL is the http(s) argument (the proxy is socks5h:// or http
	// proxy host:port, but we match the target as a full http(s) URL that is not
	// the --proxy value).
	const url = args.find((a) => /^https?:\/\//i.test(a) && a !== proxyUrl);

	if (!url) {
		console.error("Usage: pi-antigravity-rotator browse (--account <email> | --proxy <url>) <https-url>");
		process.exit(1);
	}

	if (!proxyUrl && email) {
		const config = loadOrCreateAccountsConfig();
		const account = config.accounts.find((a) => a.email === email);
		if (!account) {
			console.error(`No account "${email}" found. Known accounts:`);
			for (const a of config.accounts) console.error(`  ${a.email}`);
			process.exit(1);
		}
		if (!account.proxy) {
			console.error(`Account "${email}" has no proxy configured.`);
			process.exit(1);
		}
		proxyUrl = account.proxy;
	}

	if (!proxyUrl) {
		console.error("Provide --account <email> or --proxy <url> so the browser routes through that IP.");
		process.exit(1);
	}

	console.log(`Verifying proxy...`);
	const egress = await verifyProxyEgress(proxyUrl);
	if (!egress) {
		console.error("Proxy is unreachable — refusing to open the browser (fail-closed, would use the real IP).");
		process.exit(1);
	}
	console.log(`Proxy OK — the browser will appear at egress IP: ${egress}`);

	const launch = await launchProxiedBrowser(url, proxyUrl);
	if (!launch.ok) {
		console.error(`Could not launch a browser: ${launch.failureReason ?? "no browser binary / no X display"}`);
		console.error("Start Termux-X11 (termux-x11 :0 &) or set DISPLAY, then retry. To do it by hand, open");
		console.error(`this URL through a browser pointed at your proxy:\n  ${url}`);
		process.exit(1);
	}

	console.log("Browser open through the account's proxy. Complete the flow, then close the window");
	console.log("(or press Ctrl+C here) to shut the proxy down.");

	await new Promise<void>((resolve) => {
		let done = false;
		const finish = (): void => {
			if (done) return;
			done = true;
			resolve();
		};
		void launch.whenClosed?.then(finish);
		process.once("SIGINT", finish);
		process.once("SIGTERM", finish);
	});

	launch.close?.();
	console.log("Closed. Proxy shut down.");
}
