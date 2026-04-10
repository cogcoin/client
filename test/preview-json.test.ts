import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCogPreviewData,
  buildDomainAdminPreviewData,
  buildDomainMarketPreviewData,
  buildFieldPreviewData,
  buildReputationPreviewData,
} from "../src/cli/preview-json.js";

test("preview builders include additive resolved domain-market and cog summaries", () => {
  const transferData = buildDomainMarketPreviewData({
    kind: "transfer",
    domainName: "alpha",
    txid: "11".repeat(32),
    status: "live",
    reusedExisting: false,
    recipientScriptPubKeyHex: "00141111111111111111111111111111111111111111",
    resolved: {
      sender: {
        selector: "id:1",
        localIndex: 1,
        scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
        address: "bc1qalphaowner0000000000000000000000000000",
      },
      recipient: {
        scriptPubKeyHex: "00141111111111111111111111111111111111111111",
        address: "bc1qrecipient00000000000000000000000000000",
        opaque: false,
      },
      economicEffect: {
        kind: "ownership-transfer",
        clearsListing: true,
      },
    },
  }, {
    commandKind: "transfer",
  });

  assert.equal(transferData.intent.recipientScriptPubKeyHex, "00141111111111111111111111111111111111111111");
  assert.deepEqual(transferData.resolved, {
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      address: "bc1qalphaowner0000000000000000000000000000",
    },
    recipient: {
      scriptPubKeyHex: "00141111111111111111111111111111111111111111",
      address: "bc1qrecipient00000000000000000000000000000",
      opaque: false,
    },
    economicEffect: {
      kind: "ownership-transfer",
      clearsListing: true,
    },
  });

  const buyData = buildDomainMarketPreviewData({
    kind: "buy",
    domainName: "alpha",
    txid: "22".repeat(32),
    status: "live",
    reusedExisting: false,
    listedPriceCogtoshi: 500n,
    recipientScriptPubKeyHex: null,
    resolvedBuyer: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      address: "bc1qalphaowner0000000000000000000000000000",
    },
    resolvedSeller: {
      scriptPubKeyHex: "00145f5a03d6c7c88648b5f947459b769008ced5a020",
      address: "bc1qseller0000000000000000000000000000000",
    },
  }, {
    commandKind: "buy",
    fromIdentity: "domain:alpha",
  });

  assert.equal(buyData.intent.fromIdentitySelector, "domain:alpha");
  assert.deepEqual(buyData.resolved, {
    buyer: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      address: "bc1qalphaowner0000000000000000000000000000",
    },
    seller: {
      scriptPubKeyHex: "00145f5a03d6c7c88648b5f947459b769008ced5a020",
      address: "bc1qseller0000000000000000000000000000000",
    },
  });

  const claimData = buildCogPreviewData({
    kind: "claim",
    amountCogtoshi: 250n,
    recipientScriptPubKeyHex: null,
    recipientDomainName: "alpha",
    lockId: 7,
    txid: "33".repeat(32),
    status: "live",
    reusedExisting: false,
    resolved: {
      sender: {
        selector: "id:1",
        localIndex: 1,
        scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
        address: "bc1qalphaowner0000000000000000000000000000",
      },
      claimPath: "recipient-claim",
    },
  }, {
    commandKind: "claim",
    fromIdentity: null,
  });

  assert.equal(claimData.intent.lockId, 7);
  assert.deepEqual(claimData.resolved, {
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      address: "bc1qalphaowner0000000000000000000000000000",
    },
    claimPath: "recipient-claim",
  });
});

test("preview builders include additive resolved domain-admin, field, and reputation summaries", () => {
  const domainAdminData = buildDomainAdminPreviewData({
    kind: "delegate",
    domainName: "alpha",
    txid: "44".repeat(32),
    status: "live",
    reusedExisting: false,
    recipientScriptPubKeyHex: "00141111111111111111111111111111111111111111",
    resolved: {
      sender: {
        selector: "id:1",
        localIndex: 1,
        scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
        address: "bc1qalphaowner0000000000000000000000000000",
      },
      target: {
        scriptPubKeyHex: "00141111111111111111111111111111111111111111",
        address: "bc1qdelegate0000000000000000000000000000",
        opaque: false,
      },
      effect: {
        kind: "delegate-set",
      },
    },
  }, {
    commandKind: "domain-delegate-set",
  });

  assert.deepEqual(domainAdminData.resolved, {
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      address: "bc1qalphaowner0000000000000000000000000000",
    },
    target: {
      scriptPubKeyHex: "00141111111111111111111111111111111111111111",
      address: "bc1qdelegate0000000000000000000000000000",
      opaque: false,
    },
    effect: {
      kind: "delegate-set",
    },
  });

  const fieldData = buildFieldPreviewData({
    kind: "field-create",
    domainName: "alpha",
    fieldName: "tagline",
    fieldId: 9,
    txid: "55".repeat(32),
    tx1Txid: "66".repeat(32),
    tx2Txid: "77".repeat(32),
    family: true,
    permanent: true,
    format: 1,
    status: "live",
    reusedExisting: false,
    resolved: {
      sender: {
        selector: "id:1",
        localIndex: 1,
        scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
        address: "bc1qalphaowner0000000000000000000000000000",
      },
      path: "field-reg-plus-data-update-family",
      value: {
        format: 1,
        byteLength: 5,
      },
      effect: {
        kind: "create-and-initialize-field",
        tx1BurnCogtoshi: "100",
        tx2AdditionalBurnCogtoshi: "1",
      },
    },
  });

  assert.equal(fieldData.resultType, "family-mutation");
  assert.deepEqual(fieldData.resolved, {
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      address: "bc1qalphaowner0000000000000000000000000000",
    },
    path: "field-reg-plus-data-update-family",
    value: {
      format: 1,
      byteLength: 5,
    },
    effect: {
      kind: "create-and-initialize-field",
      tx1BurnCogtoshi: "100",
      tx2AdditionalBurnCogtoshi: "1",
    },
  });

  const reputationData = buildReputationPreviewData({
    kind: "give",
    sourceDomainName: "alpha",
    targetDomainName: "beta",
    amountCogtoshi: 250n,
    txid: "88".repeat(32),
    status: "live",
    reusedExisting: false,
    reviewIncluded: true,
    resolved: {
      sender: {
        selector: "id:1",
        localIndex: 1,
        scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
        address: "bc1qalphaowner0000000000000000000000000000",
      },
      effect: {
        kind: "give-support",
        burnCogtoshi: "250",
      },
      review: {
        included: true,
        byteLength: 12,
      },
      selfStake: false,
    },
  });

  assert.equal(reputationData.intent.reviewIncluded, true);
  assert.deepEqual(reputationData.resolved, {
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      address: "bc1qalphaowner0000000000000000000000000000",
    },
    effect: {
      kind: "give-support",
      burnCogtoshi: "250",
    },
    review: {
      included: true,
      byteLength: 12,
    },
    selfStake: false,
  });
});
