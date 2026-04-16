import test from "node:test";
import assert from "node:assert/strict";

import {
  formatFieldEffect,
  formatRegisterEconomicEffect,
} from "../src/cli/mutation-text-format.js";

test("register economic effect no longer mentions parent-owner identity", () => {
  const text = formatRegisterEconomicEffect({
    resolved: {
      sender: {
        selector: "wallet",
        localIndex: 0,
        scriptPubKeyHex: "0014" + "11".repeat(20),
        address: "bc1qfunding",
      },
      economicEffect: {
        kind: "burn",
        amount: 100_000_000n,
      },
    },
  } as any);

  assert.equal(text, "burn 1.00000000 COG from the parent owner");
  assert.doesNotMatch(text, /identity/);
});

test("field create effect is empty-create only", () => {
  const text = formatFieldEffect({
    resolved: {
      effect: {
        kind: "create-empty-field",
        burnCogtoshi: "250",
      },
    },
  } as any);

  assert.equal(text, "burn 250 cogtoshi to create an empty field");
});
