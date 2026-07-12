import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startCallbackListener } from "../src/oauth-callback-listener.js";

const PORT = 51199; // distinct from the real 51121 default so tests can't collide with a live login
const REDIRECT_URI = `http://localhost:${PORT}/oauth-callback`;

describe("oauth callback listener", () => {
	it("resolves with the code and state from a matching request", async () => {
		const listener = startCallbackListener(REDIRECT_URI);
		try {
			const res = await fetch(`${REDIRECT_URI}?code=abc123&state=xyz`);
			assert.equal(res.status, 200);
			const body = await res.text();
			assert.match(body, /Signed in/);

			const result = await listener.promise;
			assert.deepEqual(result, { code: "abc123", state: "xyz", error: undefined });
		} finally {
			listener.close();
		}
	});

	it("surfaces an error param without a code", async () => {
		const listener = startCallbackListener(REDIRECT_URI);
		try {
			const res = await fetch(`${REDIRECT_URI}?error=access_denied&state=xyz`);
			const body = await res.text();
			assert.match(body, /cancelled/i);

			const result = await listener.promise;
			assert.deepEqual(result, { code: undefined, state: "xyz", error: "access_denied" });
		} finally {
			listener.close();
		}
	});

	it("ignores requests to unrelated paths and keeps waiting", async () => {
		const listener = startCallbackListener(REDIRECT_URI);
		try {
			const res = await fetch(`http://localhost:${PORT}/favicon.ico`);
			assert.equal(res.status, 404);

			const raceResult = await Promise.race([
				listener.promise.then(() => "resolved"),
				new Promise((resolve) => setTimeout(() => resolve("still-waiting"), 200)),
			]);
			assert.equal(raceResult, "still-waiting");
		} finally {
			listener.close();
		}
	});

	it("resolves null if the port is already taken", async () => {
		const first = startCallbackListener(REDIRECT_URI);
		// give the first listener a moment to actually bind before starting a second
		await new Promise((resolve) => setTimeout(resolve, 50));
		const second = startCallbackListener(REDIRECT_URI);
		try {
			const result = await second.promise;
			assert.equal(result, null);
		} finally {
			first.close();
			second.close();
		}
	});

	it("resolves null after the timeout elapses with no request", async () => {
		const listener = startCallbackListener(REDIRECT_URI, 50);
		try {
			const result = await listener.promise;
			assert.equal(result, null);
		} finally {
			listener.close();
		}
	});
});
