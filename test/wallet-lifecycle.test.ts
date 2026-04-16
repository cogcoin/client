import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_UNLOCK_DURATION_MS, parseUnlockDurationToMs } from "../src/wallet/lifecycle.js";

test("parseUnlockDurationToMs parses supported explicit unlock durations", () => {
  assert.equal(parseUnlockDurationToMs("15m"), 15 * 60 * 1000);
  assert.equal(parseUnlockDurationToMs("2h"), 2 * 60 * 60 * 1000);
  assert.equal(parseUnlockDurationToMs("1d"), 24 * 60 * 60 * 1000);
});

test("parseUnlockDurationToMs falls back to the default unlock duration", () => {
  assert.equal(parseUnlockDurationToMs(null), DEFAULT_UNLOCK_DURATION_MS);
  assert.equal(parseUnlockDurationToMs(undefined), DEFAULT_UNLOCK_DURATION_MS);
});
