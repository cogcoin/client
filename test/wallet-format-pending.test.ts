import assert from "node:assert/strict";
import test from "node:test";

import type { PendingMutationRecord } from "../src/wallet/types.js";
import {
  formatPendingMutationDomainLabel,
  formatPendingMutationKind,
  formatPendingMutationSummaryLabel,
} from "../src/cli/wallet-format/pending.js";

function createPendingMutation(
  overrides: Partial<PendingMutationRecord> = {},
): PendingMutationRecord {
  return {
    mutationId: "mutation-1",
    kind: "sell",
    domainName: "alpha",
    parentDomainName: null,
    senderScriptPubKeyHex: "11".repeat(32),
    senderLocalIndex: 0,
    intentFingerprintHex: "22".repeat(32),
    status: "draft",
    createdAtUnixMs: 1,
    lastUpdatedAtUnixMs: 1,
    attemptedTxid: null,
    attemptedWtxid: null,
    temporaryBuilderLockedOutpoints: [],
    ...overrides,
  };
}

test("pending mutation helpers keep the current semantic relabeling", () => {
  assert.equal(
    formatPendingMutationKind(createPendingMutation({ priceCogtoshi: 0n })),
    "unsell",
  );

  assert.equal(
    formatPendingMutationDomainLabel(createPendingMutation({
      kind: "endpoint",
      endpointValueHex: "",
    })),
    "endpoint-clear",
  );

  assert.equal(
    formatPendingMutationSummaryLabel(createPendingMutation({
      kind: "rep-give",
      recipientDomainName: "beta",
    })),
    "rep-give alpha->beta",
  );
});
