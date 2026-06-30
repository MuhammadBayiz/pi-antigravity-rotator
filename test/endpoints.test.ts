import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ANTIGRAVITY_ENDPOINTS } from "../src/types.js";

describe("Antigravity endpoint defaults", () => {
  it("ships the verified daily endpoint as the production default", () => {
    assert.deepEqual([...ANTIGRAVITY_ENDPOINTS], [
      "https://daily-cloudcode-pa.googleapis.com",
    ]);
  });
});
