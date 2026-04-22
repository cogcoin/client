import test from "node:test";
import assert from "node:assert/strict";

import { formatCogClaimPath, formatCogSenderSummary } from "../src/cli/mutation-text-format.js";

const sender = {
  selector: "wallet",
  localIndex: 0,
  scriptPubKeyHex: "0014" + "11".repeat(20),
  address: "bc1qfunding",
};

test("COG sender summaries resolve to the wallet address", () => {
  const summary = formatCogSenderSummary({
    resolved: {
      sender,
      claimPath: null,
    },
  } as any);

  assert.equal(summary, "wallet (bc1qfunding)");
});

test("COG claim path formatting keeps the one-address recipient claim label", () => {
  assert.equal(formatCogClaimPath({ resolved: { claimPath: "recipient-claim" } } as any), "recipient-claim");
});
