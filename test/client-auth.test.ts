import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  getConfiguredClientKeys,
  getRequestClientKey,
  clientKeyValueOk,
  isClientAuthorized,
} from "../src/client-auth.js";
import { setPersistedAdminToken } from "../src/admin-auth.js";

function req(
  headers: Record<string, string | string[] | undefined> = {},
  socket?: unknown,
) {
  return { headers, socket };
}

const ORIGINAL_KEYS = process.env.PI_ROTATOR_CLIENT_KEYS;
const ORIGINAL_ADMIN = process.env.PI_ROTATOR_ADMIN_TOKEN;

describe("client auth helpers", () => {
  beforeEach(() => {
    delete process.env.PI_ROTATOR_CLIENT_KEYS;
    delete process.env.PI_ROTATOR_ADMIN_TOKEN;
    // admin-auth has a module-level persisted-token fallback; keep it clean.
    setPersistedAdminToken(null);
  });

  after(() => {
    if (ORIGINAL_KEYS === undefined) delete process.env.PI_ROTATOR_CLIENT_KEYS;
    else process.env.PI_ROTATOR_CLIENT_KEYS = ORIGINAL_KEYS;
    if (ORIGINAL_ADMIN === undefined) delete process.env.PI_ROTATOR_ADMIN_TOKEN;
    else process.env.PI_ROTATOR_ADMIN_TOKEN = ORIGINAL_ADMIN;
    setPersistedAdminToken(null);
  });

  it("parses comma-separated keys, trimming and ignoring blanks", () => {
    const keys = getConfiguredClientKeys({
      PI_ROTATOR_CLIENT_KEYS: "  a , b ,, c  ",
    });
    assert.deepEqual([...keys].sort(), ["a", "b", "c"]);
    assert.equal(getConfiguredClientKeys({}).size, 0);
    assert.equal(getConfiguredClientKeys({ PI_ROTATOR_CLIENT_KEYS: "   " }).size, 0);
  });

  it("extracts the presented key from x-rotator-client-key, x-api-key, or Bearer", () => {
    assert.equal(getRequestClientKey(req({ "x-rotator-client-key": "k1" })), "k1");
    assert.equal(getRequestClientKey(req({ "x-api-key": "k2" })), "k2");
    assert.equal(getRequestClientKey(req({ authorization: "Bearer k3" })), "k3");
    assert.equal(getRequestClientKey(req({ authorization: "bearer k4" })), "k4");
    assert.equal(getRequestClientKey(req({})), null);
  });

  it("is open when no client keys are configured (loopback default)", () => {
    assert.equal(isClientAuthorized(req({})), true);
    assert.equal(isClientAuthorized(req({ "x-api-key": "anything" })), true);
  });

  it("accepts a valid key via any of the three header forms", () => {
    process.env.PI_ROTATOR_CLIENT_KEYS = "secret-a,secret-b";
    assert.equal(isClientAuthorized(req({ "x-api-key": "secret-a" })), true);
    assert.equal(isClientAuthorized(req({ authorization: "Bearer secret-b" })), true);
    assert.equal(
      isClientAuthorized(req({ "x-rotator-client-key": "secret-a" })),
      true,
    );
  });

  it("rejects a missing or wrong key when keys are configured", () => {
    process.env.PI_ROTATOR_CLIENT_KEYS = "secret-a";
    assert.equal(isClientAuthorized(req({})), false);
    assert.equal(isClientAuthorized(req({ "x-api-key": "nope" })), false);
  });

  it("bypasses the guard for MITM-terminated sockets (agy)", () => {
    process.env.PI_ROTATOR_CLIENT_KEYS = "secret-a";
    // No key presented, but the socket is tagged by mitm.ts.
    assert.equal(
      isClientAuthorized(req({}, { __mitmAuthorized: true })),
      true,
    );
    // A non-MITM socket without a key is still rejected.
    assert.equal(isClientAuthorized(req({}, { __mitmAuthorized: false })), false);
  });

  it("accepts the admin token as a superset credential", () => {
    process.env.PI_ROTATOR_CLIENT_KEYS = "secret-a";
    process.env.PI_ROTATOR_ADMIN_TOKEN = "admin-tok";
    assert.equal(
      isClientAuthorized(req({ "x-rotator-admin-token": "admin-tok" })),
      true,
    );
    assert.equal(isClientAuthorized(req({ authorization: "Bearer admin-tok" })), true);
    assert.equal(isClientAuthorized(req({ "x-rotator-admin-token": "wrong" })), false);
  });

  it("clientKeyValueOk validates bare key/admin-token values", () => {
    assert.equal(clientKeyValueOk("k", { PI_ROTATOR_CLIENT_KEYS: "k,j" }), true);
    assert.equal(clientKeyValueOk("j", { PI_ROTATOR_CLIENT_KEYS: "k,j" }), true);
    assert.equal(clientKeyValueOk("x", { PI_ROTATOR_CLIENT_KEYS: "k,j" }), false);
    assert.equal(clientKeyValueOk("", { PI_ROTATOR_CLIENT_KEYS: "k,j" }), false);
    assert.equal(clientKeyValueOk(undefined, {}), false);
    assert.equal(
      clientKeyValueOk("adm", { PI_ROTATOR_ADMIN_TOKEN: "adm" }),
      true,
    );
  });
});
