import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAnchorPreviewData,
  buildFieldPreviewData,
  buildSingleTxMutationPreviewData,
} from "../src/cli/preview-json.js";

test("single-tx preview data uses the simplified envelope", () => {
  const data = buildSingleTxMutationPreviewData({
    kind: "anchor",
    localStatus: "live",
    txid: "aa".repeat(32),
    reusedExisting: false,
    intent: { domainName: "alpha" },
  });

  assert.equal(data.resultType, "single-tx-mutation");
  assert.deepEqual(data.transaction, { txid: "aa".repeat(32), wtxid: null });
});

test("anchor preview data is single-tx only", () => {
  const data = buildAnchorPreviewData(
    {
      domainName: "alpha",
      txid: "bb".repeat(32),
      status: "confirmed",
      reusedExisting: false,
      foundingMessageText: "hello",
    },
    { foundingMessageText: "hello" },
  );

  assert.equal(data.resultType, "single-tx-mutation");
  assert.equal(data.intent.foundingMessageIncluded, true);
  assert.equal("tx1Txid" in data, false);
  assert.equal("tx2Txid" in data, false);
});

test("field-create preview data is single-tx and empty-create only", () => {
  const data = buildFieldPreviewData({
    kind: "field-create",
    domainName: "alpha",
    fieldName: "bio",
    fieldId: 7,
    txid: "cc".repeat(32),
    permanent: true,
    format: null,
    status: "live",
    reusedExisting: false,
    resolved: {
      sender: {
        selector: "wallet",
        localIndex: 0,
        scriptPubKeyHex: "0014" + "11".repeat(20),
        address: "bc1qfunding",
      },
      path: "standalone-field-reg",
      value: null,
      effect: {
        kind: "create-empty-field",
        burnCogtoshi: "100",
      },
    },
  });

  assert.equal(data.resultType, "single-tx-mutation");
  assert.equal(data.resolved?.path, "standalone-field-reg");
  assert.equal(data.resolved?.effect.kind, "create-empty-field");
});
