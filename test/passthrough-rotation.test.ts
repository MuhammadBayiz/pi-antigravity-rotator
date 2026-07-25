import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withPassthroughRotation } from "../src/proxy.js";
import type { AccountRotator } from "../src/rotator.js";
import type { AccountRuntime } from "../src/types.js";

function acct(email: string): AccountRuntime {
  return { config: { email } } as unknown as AccountRuntime;
}

/**
 * Minimal AccountRotator stub. Hands out accounts in order: getActiveAccount()
 * returns sequence[0]; each rotateToNext() returns the next entry (null when
 * exhausted). Records the accounting calls withPassthroughRotation makes.
 */
function makeRotator(sequence: (AccountRuntime | null)[], accountCount?: number) {
  const calls = {
    getActive: 0,
    rotateToNext: 0,
    recordRequest: 0,
    finishRequest: 0,
    markError: [] as string[],
  };
  let idx = 0;
  const rotator = {
    getAccountCount: () =>
      accountCount ?? sequence.filter(Boolean).length ?? 1,
    getActiveAccount: async () => {
      calls.getActive++;
      return sequence[0] ?? null;
    },
    rotateToNext: async () => {
      calls.rotateToNext++;
      idx++;
      return sequence[idx] ?? null;
    },
    recordRequest: (_a: AccountRuntime) => {
      calls.recordRequest++;
      return false;
    },
    markError: (_a: AccountRuntime, msg: string) => {
      calls.markError.push(msg);
    },
    finishRequest: (_a: AccountRuntime) => {
      calls.finishRequest++;
    },
  } as unknown as AccountRotator;
  return { rotator, calls };
}

const OK = { status: 200 } as unknown as Response;
function attemptRejecting(rejectEmails: Set<string>) {
  return (account: AccountRuntime) =>
    rejectEmails.has(account.config.email)
      ? Promise.reject(new TypeError("fetch failed"))
      : Promise.resolve(OK);
}

describe("withPassthroughRotation", () => {
  it("returns immediately on first-account success (no rotation)", async () => {
    const A = acct("a");
    const { rotator, calls } = makeRotator([A], 1);
    const r = await withPassthroughRotation(rotator, attemptRejecting(new Set()));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.res, OK);
    assert.equal(calls.rotateToNext, 0);
    assert.equal(calls.markError.length, 0);
    assert.equal(calls.recordRequest, 1);
    assert.equal(calls.finishRequest, 1); // balances the startRequest getActiveAccount did
  });

  it("rotates past a flaky proxy and succeeds on the next account", async () => {
    const A = acct("a");
    const B = acct("b");
    const { rotator, calls } = makeRotator([A, B], 2);
    const r = await withPassthroughRotation(rotator, attemptRejecting(new Set(["a"])));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.res, OK);
    assert.equal(calls.rotateToNext, 1); // rotated A -> B once
    assert.equal(calls.markError.length, 1); // A penalized
    assert.equal(calls.recordRequest, 1); // B recorded success
    assert.equal(calls.finishRequest, 2); // both accounts balanced
  });

  it("returns upstream-failed (not no-account) when every account's proxy fails", async () => {
    const A = acct("a");
    const B = acct("b");
    const C = acct("c");
    const { rotator, calls } = makeRotator([A, B, C], 3);
    const r = await withPassthroughRotation(
      rotator,
      attemptRejecting(new Set(["a", "b", "c"])),
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.noAccount, false);
    assert.equal(calls.markError.length, 3);
    assert.equal(calls.finishRequest, 3);
    assert.equal(calls.recordRequest, 0);
  });

  it("reports noAccount when the pool is empty", async () => {
    const { rotator, calls } = makeRotator([null], 1);
    const r = await withPassthroughRotation(rotator, attemptRejecting(new Set()));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.noAccount, true);
    assert.equal(calls.markError.length, 0);
    assert.equal(calls.finishRequest, 0);
    assert.equal(calls.recordRequest, 0);
  });

  it("does not exceed the account count in attempts", async () => {
    const A = acct("a");
    const B = acct("b");
    // 5 in sequence but only 2 accounts -> at most 2 attempts
    const { rotator, calls } = makeRotator([A, B, A, B, A], 2);
    const r = await withPassthroughRotation(
      rotator,
      attemptRejecting(new Set(["a", "b"])),
    );
    assert.equal(r.ok, false);
    assert.equal(calls.markError.length, 2); // capped at accountCount
  });
});
