import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAnchorClearMutationData,
  buildCogMutationData,
  buildDomainAdminMutationData,
  buildDomainMarketMutationData,
  buildFieldMutationData,
  buildRegisterMutationData,
  buildReputationMutationData,
} from "../src/cli/mutation-json.js";
import {
  buildAnchorClearPreviewData,
  buildCogPreviewData,
  buildDomainAdminPreviewData,
  buildDomainMarketPreviewData,
  buildFieldPreviewData,
  buildRegisterPreviewData,
  buildReputationPreviewData,
} from "../src/cli/preview-json.js";

test("mutation and preview builders keep register and domain-market resolved blocks in sync", () => {
  const anchorClearResult = {
    domainName: "weatherbot",
    cleared: true,
    previousFamilyStatus: "draft" as const,
    previousFamilyStep: "reserved" as const,
    releasedDedicatedIndex: 2,
    forced: true,
    clearedReservedFamilies: 1,
    canceledActiveFamilies: 1,
    releasedDedicatedIndices: [2, 4],
    affectedFamilies: [
      {
        familyId: "anchor-family-1",
        previousStatus: "draft" as const,
        previousStep: "reserved" as const,
        action: "cleared" as const,
      },
      {
        familyId: "anchor-family-2",
        previousStatus: "live" as const,
        previousStep: "tx1" as const,
        action: "canceled" as const,
      },
    ],
    previousLocalAnchorIntent: "tx1-live" as const,
    previousDedicatedIndex: 2,
    resultingLocalAnchorIntent: "none" as const,
    resultingDedicatedIndex: null,
  };
  const anchorClearMutation = buildAnchorClearMutationData(anchorClearResult);
  const anchorClearPreview = buildAnchorClearPreviewData(anchorClearResult);
  assert.deepEqual(anchorClearMutation, anchorClearPreview);
  assert.deepEqual(anchorClearMutation, {
    resultType: "state-change",
    stateChange: {
      kind: "anchor-clear",
      before: {
        localAnchorIntent: "tx1-live",
        dedicatedIndex: 2,
        familyStatus: "draft",
        familyStep: "reserved",
      },
      after: {
        localAnchorIntent: "none",
        dedicatedIndex: null,
        familyStatus: "canceled",
        familyStep: "reserved",
      },
    },
    state: {
      domainName: "weatherbot",
      cleared: true,
      previousFamilyStatus: "draft",
      previousFamilyStep: "reserved",
      releasedDedicatedIndex: 2,
      forced: true,
      clearedReservedFamilies: 1,
      canceledActiveFamilies: 1,
      releasedDedicatedIndices: [2, 4],
      affectedFamilies: [
        {
          familyId: "anchor-family-1",
          previousStatus: "draft",
          previousStep: "reserved",
          action: "cleared",
        },
        {
          familyId: "anchor-family-2",
          previousStatus: "live",
          previousStep: "tx1",
          action: "canceled",
        },
      ],
      previousLocalAnchorIntent: "tx1-live",
      previousDedicatedIndex: 2,
      resultingLocalAnchorIntent: "none",
      resultingDedicatedIndex: null,
    },
  });

  const registerResult = {
    domainName: "weatherbot",
    registerKind: "root" as const,
    parentDomainName: null,
    senderSelector: "id:1",
    senderLocalIndex: 1,
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    economicEffectKind: "treasury-payment" as const,
    economicEffectAmount: 100000n,
    resolved: {
      path: "root" as const,
      parentDomainName: null,
      sender: {
        selector: "id:1",
        localIndex: 1,
        scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
        address: "bc1qalphaowner0000000000000000000000000000",
      },
      economicEffect: {
        kind: "treasury-payment" as const,
        amount: 100000n,
      },
    },
    txid: "11".repeat(32),
    status: "live" as const,
    reusedExisting: false,
  };
  const registerMutation = buildRegisterMutationData(registerResult, {
    forceRace: false,
    fromIdentity: "domain:alpha",
  });
  const registerPreview = buildRegisterPreviewData(registerResult, {
    forceRace: false,
    fromIdentity: "domain:alpha",
  });
  assert.deepEqual(registerMutation.resolved, registerPreview.resolved);
  assert.deepEqual(registerMutation.resolved, {
    path: "root",
    parentDomainName: null,
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      address: "bc1qalphaowner0000000000000000000000000000",
    },
    economicEffect: {
      kind: "treasury-payment",
      amount: "100000",
    },
  });

  const transferResult = {
    kind: "transfer" as const,
    domainName: "alpha",
    txid: "22".repeat(32),
    status: "live" as const,
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
        kind: "ownership-transfer" as const,
        clearsListing: true,
      },
    },
  };
  const transferMutation = buildDomainMarketMutationData(transferResult, {
    commandKind: "transfer",
  });
  const transferPreview = buildDomainMarketPreviewData(transferResult, {
    commandKind: "transfer",
  });
  assert.deepEqual(transferMutation.resolved, transferPreview.resolved);

  const buyResult = {
    kind: "buy" as const,
    domainName: "alpha",
    txid: "33".repeat(32),
    status: "live" as const,
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
  };
  const buyMutation = buildDomainMarketMutationData(buyResult, {
    commandKind: "buy",
    fromIdentity: "domain:alpha",
  });
  const buyPreview = buildDomainMarketPreviewData(buyResult, {
    commandKind: "buy",
    fromIdentity: "domain:alpha",
  });
  assert.deepEqual(buyMutation.resolved, buyPreview.resolved);
});

test("mutation and preview builders keep cog, domain-admin, field, and reputation resolved blocks in sync", () => {
  const claimResult = {
    kind: "claim" as const,
    amountCogtoshi: 250n,
    recipientScriptPubKeyHex: null,
    recipientDomainName: "alpha",
    lockId: 7,
    txid: "44".repeat(32),
    status: "live" as const,
    reusedExisting: false,
    resolved: {
      sender: {
        selector: "id:1",
        localIndex: 1,
        scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
        address: "bc1qalphaowner0000000000000000000000000000",
      },
      claimPath: "recipient-claim" as const,
    },
  };
  const claimMutation = buildCogMutationData(claimResult, {
    commandKind: "claim",
    fromIdentity: null,
  });
  const claimPreview = buildCogPreviewData(claimResult, {
    commandKind: "claim",
    fromIdentity: null,
  });
  assert.deepEqual(claimMutation.resolved, claimPreview.resolved);

  const domainAdminResult = {
    kind: "delegate" as const,
    domainName: "alpha",
    txid: "55".repeat(32),
    status: "live" as const,
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
        kind: "delegate-set" as const,
      },
    },
  };
  const domainAdminMutation = buildDomainAdminMutationData(domainAdminResult, {
    commandKind: "domain-delegate-set",
  });
  const domainAdminPreview = buildDomainAdminPreviewData(domainAdminResult, {
    commandKind: "domain-delegate-set",
  });
  assert.deepEqual(domainAdminMutation.resolved, domainAdminPreview.resolved);

  const fieldResult = {
    kind: "field-create" as const,
    domainName: "alpha",
    fieldName: "tagline",
    fieldId: 9,
    txid: "66".repeat(32),
    tx1Txid: "77".repeat(32),
    tx2Txid: "88".repeat(32),
    family: true,
    permanent: true,
    format: 1,
    status: "live" as const,
    reusedExisting: false,
    resolved: {
      sender: {
        selector: "id:1",
        localIndex: 1,
        scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
        address: "bc1qalphaowner0000000000000000000000000000",
      },
      path: "field-reg-plus-data-update-family" as const,
      value: {
        format: 1,
        byteLength: 5,
      },
      effect: {
        kind: "create-and-initialize-field" as const,
        tx1BurnCogtoshi: "100" as const,
        tx2AdditionalBurnCogtoshi: "1" as const,
      },
    },
  };
  const fieldMutation = buildFieldMutationData(fieldResult);
  const fieldPreview = buildFieldPreviewData(fieldResult);
  assert.deepEqual(fieldMutation.resolved, fieldPreview.resolved);

  const reputationResult = {
    kind: "give" as const,
    sourceDomainName: "alpha",
    targetDomainName: "beta",
    amountCogtoshi: 250n,
    txid: "99".repeat(32),
    status: "live" as const,
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
        kind: "give-support" as const,
        burnCogtoshi: "250",
      },
      review: {
        included: true,
        byteLength: 12,
      },
      selfStake: false,
    },
  };
  const reputationMutation = buildReputationMutationData(reputationResult);
  const reputationPreview = buildReputationPreviewData(reputationResult);
  assert.deepEqual(reputationMutation.resolved, reputationPreview.resolved);
});
