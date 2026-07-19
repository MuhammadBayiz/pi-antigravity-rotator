// Standalone OAuth login helper (fully automated)
// Usage: npm run login
// 1. Opens OAuth URL -> user pastes redirect URL
// 2. Automatically adds account to accounts.json
// 3. Automatically configures ~/.pi/agent/models.json and ~/.pi/agent/auth.json

import { createInterface } from "node:readline";
import { addAccountToConfig, ensurePiAuthConfig, ensurePiModelsConfig, loadOrCreateAccountsConfig } from "./account-store.js";
import { buildAuthUrl, discoverProject, exchangeAuthorizationCode, generatePkce, generateState, getOAuthClientConfig, getUserEmail } from "./oauth.js";
import { launchProxiedBrowser } from "./browser-launch.js";
import { startCallbackListener } from "./oauth-callback-listener.js";
import type { AccountConfig } from "./types.js";
import { getAccountsPath } from "./paths.js";

const ACCOUNTS_FILE = getAccountsPath();

function parseRedirectUrl(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};
	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		return {};
	}
}

function askQuestion(prompt: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(prompt, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

/** Same as askQuestion, but exposes `cancel` so a competing async source (the
 * auto-detected redirect) can shut the prompt down instead of leaving it
 * dangling on stdin, which would keep the process alive indefinitely. */
function askQuestionCancelable(prompt: string): { promise: Promise<string>; cancel: () => void } {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const promise = new Promise<string>((resolve) => {
		rl.question(prompt, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
	return { promise, cancel: () => rl.close() };
}

export async function runLogin(proxyUrl?: string, withBrowser?: boolean, autoGrab?: boolean): Promise<void> {
	console.log("=== Pi Antigravity Rotator - Add Account ===");
	console.log();
	if (proxyUrl) {
		console.log(`Routing login through proxy: ${proxyUrl}`);
		console.log();
	}

	const oauth = getOAuthClientConfig();
	const { verifier, challenge } = generatePkce();
	const state = generateState();
	const authUrl = buildAuthUrl(state, challenge);

	// When we launched the browser ourselves, auto-detecting the redirect and
	// closing the window afterward is opt-in via --auto-grab -- otherwise the
	// user drives both the paste and the browser lifecycle by hand. This gate
	// only applies when we opened the browser: without --with-browser at all,
	// auto-detection still runs as before (there's no window of ours to close).
	const shouldAutoGrab = !withBrowser || autoGrab;

	let opened = false;
	let browserLaunch: Awaited<ReturnType<typeof launchProxiedBrowser>> | undefined;
	if (withBrowser) {
		if (!proxyUrl) {
			console.error("--with-browser requires --proxy <url> so the browser matches the account's proxy.");
			process.exit(1);
		}
		browserLaunch = await launchProxiedBrowser(authUrl, proxyUrl);
		if (browserLaunch.ok) {
			opened = true;
			console.log("Opened a browser window through the proxy in a fresh, isolated profile.");
			if (browserLaunch.credentialNote) {
				console.log(browserLaunch.credentialNote);
			}
			if (!autoGrab) {
				console.log("Auto-grab is off: paste the redirect URL below when ready, and close the browser window yourself when done.");
			}
			console.log();
		} else if (browserLaunch.failureReason) {
			console.log(`Browser launch failed: ${browserLaunch.failureReason}`);
			console.log("Falling back to manual URL.");
			console.log();
		} else {
			console.log("Could not find a browser binary to launch (set the BROWSER env var to its path). Falling back to manual URL.");
			console.log();
		}
	}

	if (!opened) {
		console.log("1. Open this URL in your browser:");
		console.log();
		console.log(authUrl);
		console.log();
	}
	console.log("2. Complete the Google sign-in.");
	console.log(`3. The redirect to ${oauth.redirectUri} is detected automatically -- or paste the full URL below if it doesn't.`);
	console.log();

	let parsed: { code?: string; state?: string };

	if (shouldAutoGrab) {
		// Bind a throwaway local server on the redirect URI so Google's final
		// redirect is captured directly, instead of requiring the user to copy it
		// out of the browser's address bar. Races that against the manual paste
		// prompt so either path works: whichever resolves first wins, and the
		// loser is cancelled so it can't leak a dangling readline/socket.
		const callbackListener = startCallbackListener(oauth.redirectUri);

		for (;;) {
			const manual = askQuestionCancelable("Paste the redirect URL (leave blank to keep waiting): ");
			const race = await Promise.race([
				callbackListener.promise.then((v) => ({ source: "auto" as const, v })),
				manual.promise.then((v) => ({ source: "manual" as const, v })),
			]);

			if (race.source === "auto") {
				manual.cancel();
				if (race.v?.code) {
					callbackListener.close();
					console.log("Detected the redirect automatically.");
					console.log();
					parsed = race.v;
					break;
				}
				// Auto-detection gave up (port already in use, or timed out): fall
				// back to a single manual prompt with no more racing.
				const redirectUrl = await askQuestion("Paste the redirect URL: ");
				if (!redirectUrl) {
					console.error("No URL provided.");
					process.exit(1);
				}
				parsed = parseRedirectUrl(redirectUrl);
				break;
			}

			if (!race.v) continue; // blank Enter: keep waiting for auto-detection
			callbackListener.close();
			parsed = parseRedirectUrl(race.v);
			break;
		}
	} else {
		// Auto-grab is off: no local listener, just repeated manual paste prompts.
		for (;;) {
			const redirectUrl = await askQuestion("Paste the redirect URL: ");
			if (!redirectUrl) {
				console.error("No URL provided.");
				process.exit(1);
			}
			parsed = parseRedirectUrl(redirectUrl);
			if (parsed.code) break;
			console.error("Could not extract an authorization code from that URL, try again.");
		}
	}

	if (!parsed.code) {
		console.error("Could not extract authorization code from the URL.");
		process.exit(1);
	}

	if (parsed.state !== state) {
		console.error("State mismatch - the URL does not match this login session.");
		process.exit(1);
	}

	// The browser has done its job the moment we have a valid code -- close
	// it now rather than leaving the window (and its process) running, which
	// was also what kept the CLI itself from exiting afterward. Skipped when
	// --with-browser was used without --auto-grab: the user drives the
	// browser's lifecycle themselves in that mode.
	if (shouldAutoGrab) {
		browserLaunch?.close?.();
	}

	console.log();
	console.log("Exchanging code for tokens...");
	const tokenData = await exchangeAuthorizationCode(parsed.code, verifier, proxyUrl);

	console.log("Getting user info...");
	const email = await getUserEmail(tokenData.accessToken, proxyUrl);

	console.log("Discovering project...");
	const project = await discoverProject(tokenData.accessToken, proxyUrl);

	const label = email ? email.split("@")[0] : "Account";
	const entry: AccountConfig = {
		email: email || "unknown@gmail.com",
		refreshToken: tokenData.refreshToken,
		projectId: project.projectId,
		projectSource: project.source,
		label,
		...(proxyUrl ? { proxy: proxyUrl } : {}),
	};

	console.log();
	const { isNew } = addAccountToConfig(entry);
	console.log(`  ${isNew ? "Added" : "Updated"} ${entry.email} in ${ACCOUNTS_FILE}`);
	console.log(`  projectId=${project.projectId} (source=${project.source})`);

	ensurePiModelsConfig();
	ensurePiAuthConfig();

	const config = loadOrCreateAccountsConfig();
	console.log();
	console.log(`Done. ${config.accounts.length} account(s) configured:`);
	for (const a of config.accounts) {
		console.log(`  ${a.label || a.email} (${a.email})`);
	}
	console.log();
	console.log("Run 'npm start' to start the proxy.");
}

function readProxyArg(): string | undefined {
	const idx = process.argv.indexOf("--proxy");
	return idx !== -1 ? process.argv[idx + 1] : undefined;
}

if (process.argv[1]?.includes("login")) {
	runLogin(readProxyArg(), process.argv.includes("--with-browser"), process.argv.includes("--auto-grab"))
		.then(() => process.exit(0))
		.catch((err) => {
			console.error("Login failed:", err);
			process.exit(1);
		});
}
