import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAnchorMutationData,
  buildFieldMutationData,
  buildSingleTxMutationData,
} from "../src/cli/mutation-json.js";

test("single-tx mutation data uses the simplified envelope", () => {
  const data = buildSingleTxMutationData({
    kind: "anchor",
    localStatus: "live",
    txid: "aa".repeat(32),
    reusedExisting: false,
    intent: { domainName: "alpha" },
  });

  assert.equal(data.resultType, "single-tx-mutation");
  assert.deepEqual(data.transaction, { txid: "aa".repeat(32), wtxid: null });
});

test("anchor mutation data is single-tx only", () => {
  const data = buildAnchorMutationData(
    {
      domainName: "alpha",
      txid: "bb".repeat(32),
      status: "live",
      reusedExisting: true,
      foundingMessageText: null,
    },
    { foundingMessageText: null },
  );

  assert.equal(data.resultType, "single-tx-mutation");
  assert.equal("tx1Txid" in data, false);
  assert.equal("tx2Txid" in data, false);
  assert.equal(data.intent.foundingMessageIncluded, false);
});

test("field-create mutation data is single-tx and empty-create only", () => {
  const data = buildFieldMutationData({
    kind: "field-create",
    domainName: "alpha",
    fieldName: "bio",
    fieldId: 7,
    txid: "cc".repeat(32),
    permanent: false,
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
  assert.equal("family" in data, false);
});
