// Captures Google's OAuth redirect automatically instead of requiring the
// user to copy the final URL out of the browser's address bar: a tiny local
// HTTP server binds to the configured redirect URI and resolves as soon as
// that exact path is requested.
import { createServer, type Server } from "node:http";

export interface OAuthCallbackResult {
	code?: string;
	state?: string;
	error?: string;
}

export interface CallbackListener {
	/**
	 * Resolves with the parsed query params once the browser hits the
	 * callback URL, or `null` if the port could not be bound (e.g. already in
	 * use) or nothing arrived within the timeout -- callers should fall back
	 * to asking the user to paste the URL manually in either case.
	 */
	promise: Promise<OAuthCallbackResult | null>;
	/** Stop listening. Safe to call more than once, and after settling. */
	close: () => void;
}

const CALLBACK_PAGE = (body: string) =>
	`<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:32rem;margin:15vh auto;text-align:center;">${body}<p>You can close this tab and return to the terminal.</p></body></html>`;

export function startCallbackListener(
	redirectUri: string,
	timeoutMs = 5 * 60 * 1000,
): CallbackListener {
	const target = new URL(redirectUri);
	let server: Server | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let settled = false;

	const promise = new Promise<OAuthCallbackResult | null>((resolve) => {
		const finish = (value: OAuthCallbackResult | null) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(value);
		};

		server = createServer((req, res) => {
			const url = new URL(req.url || "/", `http://${target.host}`);
			if (url.pathname !== target.pathname) {
				res.writeHead(404, { Connection: "close" }).end();
				return;
			}

			const result: OAuthCallbackResult = {
				code: url.searchParams.get("code") ?? undefined,
				state: url.searchParams.get("state") ?? undefined,
				error: url.searchParams.get("error") ?? undefined,
			};

			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				Connection: "close",
			});
			res.end(
				CALLBACK_PAGE(
					result.error
						? `<h1>Sign-in cancelled</h1><p>${result.error}</p>`
						: `<h1>Signed in</h1>`,
				),
			);
			finish(result);
		});

		server.on("error", () => finish(null));
		server.listen(Number(target.port) || 80, "127.0.0.1");

		timer = setTimeout(() => finish(null), timeoutMs);
		if (timer.unref) timer.unref();
	});

	return {
		promise,
		close: () => {
			if (timer) clearTimeout(timer);
			server?.closeAllConnections?.();
			try {
				server?.close();
			} catch {
				// already closed
			}
		},
	};
}
