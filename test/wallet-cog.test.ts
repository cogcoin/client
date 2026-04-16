import test from "node:test";
import assert from "node:assert/strict";

import { buildCogMutationData } from "../src/cli/mutation-json.js";
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

test("COG mutation JSON stays single-tx in the one-address model", () => {
  const data = buildCogMutationData({
    kind: "send",
    txid: "aa".repeat(32),
    status: "live",
    reusedExisting: false,
    amountCogtoshi: 123n,
    recipientScriptPubKeyHex: "0014" + "22".repeat(20),
    resolved: {
      sender,
      claimPath: "recipient-claim",
    },
  } as any, {
    commandKind: "send",
  });

  assert.equal(data.resultType, "single-tx-mutation");
  assert.equal(data.resolved.sender.address, "bc1qfunding");
  assert.equal(formatCogClaimPath({ resolved: { claimPath: "recipient-claim" } } as any), "recipient-claim");
});
