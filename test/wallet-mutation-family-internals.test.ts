import assert from "node:assert/strict";
import test from "node:test";

import {
  createResolvedReputationSummary,
  normalizeReputationDomainName,
} from "../src/wallet/tx/reputation/intent.js";
import { createSetDelegateVariant } from "../src/wallet/tx/domain-admin/variants/delegate.js";
import {
  findActiveFieldCreateMutationByDomain,
} from "../src/wallet/tx/field/draft.js";
import {
  createResolvedFieldSummary,
} from "../src/wallet/tx/field/result.js";
import { parseTimeoutHeight } from "../src/wallet/tx/cog/intent.js";
import {
  createSellEconomicEffectSummary,
  createTransferEconomicEffectSummary,
  parseCogAmountToCogtoshi,
} from "../src/wallet/tx/domain-market/intent.js";

test("reputation intent normalization and resolved summaries keep give/review details", () => {
  assert.equal(normalizeReputationDomainName(" Alpha ", "err"), "alpha");

  const summary = createResolvedReputationSummary({
    kind: "give",
    sender: {
      localIndex: 0,
      scriptPubKeyHex: "0014" + "11".repeat(20),
      address: "bc1qfunding",
    },
    senderSelector: "wallet",
    amountCogtoshi: 42n,
    review: {
      text: "hello",
      payload: new Uint8Array([1, 2, 3]),
      payloadHex: "010203",
    },
    selfStake: true,
  });

  assert.equal(summary.effect.kind, "give-support");
  assert.equal(summary.effect.burnCogtoshi, "42");
  assert.equal(summary.review.included, true);
  assert.equal(summary.review.byteLength, 3);
  assert.equal(summary.selfStake, true);
});

test("domain-admin delegate variant preserves target payload and intent parts", async () => {
  const variant = createSetDelegateVariant({
    domainName: "alpha",
    target: "spk:0014" + "22".repeat(20),
    dataDir: "/tmp",
    databasePath: "/tmp/client.sqlite",
    prompter: {} as any,
  });

  const fakeOperation = {
    chainDomain: {
      domainId: 9,
      name: "alpha",
    },
    sender: {
      localIndex: 0,
      scriptPubKeyHex: "0014" + "11".repeat(20),
      address: "bc1qsender",
    },
    senderSelector: "wallet",
  } as any;

  assert.equal(variant.kind, "delegate");
  assert.deepEqual(variant.intentParts(fakeOperation), [
    "alpha",
    "0014" + "22".repeat(20),
  ]);

  const payload = await variant.createPayload(fakeOperation);
  assert.equal(payload.recipientScriptPubKeyHex, "0014" + "22".repeat(20));
  assert.equal(payload.resolvedEffect.kind, "delegate-set");
  assert.equal(payload.resolvedTarget?.scriptPubKeyHex, "0014" + "22".repeat(20));
});

test("field family helpers keep conflicting create matching and resolved summary shaping", () => {
  const conflict = findActiveFieldCreateMutationByDomain({
    walletRootId: "wallet-1",
    stateRevision: 1,
    lastWrittenAtUnixMs: 1,
    funding: {
      address: "bc1qfunding",
      scriptPubKeyHex: "0014" + "11".repeat(20),
    },
    managedCoreWallet: {
      walletName: "wallet.dat",
      walletPassphraseSecretRef: null,
      descriptorChecksum: "desc",
    },
    domains: [],
    pendingMutations: [
      {
        mutationId: "m-1",
        kind: "field-create",
        domainName: "alpha",
        parentDomainName: null,
        senderScriptPubKeyHex: "0014" + "11".repeat(20),
        senderLocalIndex: 0,
        fieldName: "bio",
        intentFingerprintHex: "other",
        status: "draft",
        createdAtUnixMs: 1,
        lastUpdatedAtUnixMs: 1,
        attemptedTxid: null,
        attemptedWtxid: null,
        selectedFeeRateSatVb: 5,
        feeSelectionSource: "fallback-default",
        temporaryBuilderLockedOutpoints: [],
      },
    ],
  } as any, "alpha", "current");

  assert.equal(conflict?.mutationId, "m-1");

  const summary = createResolvedFieldSummary({
    sender: {
      localIndex: 0,
      scriptPubKeyHex: "0014" + "11".repeat(20),
      address: "bc1qfunding",
    },
    senderSelector: "wallet",
    kind: "field-set",
    value: {
      format: 2,
      byteLength: 5,
    },
  });

  assert.equal(summary.path, "standalone-data-update");
  assert.equal(summary.effect.kind, "write-field-value");
  assert.equal(summary.value?.format, 2);
});

test("cog timeout parsing keeps absolute and duration semantics", () => {
  assert.equal(parseTimeoutHeight(100, "2h", null), 112);
  assert.equal(parseTimeoutHeight(100, null, 150), 150);
  assert.throws(() => parseTimeoutHeight(100, "5", 150), /wallet_lock_timeout_requires_exactly_one_mode/);
});

test("domain-market helpers keep cog amount parsing and effect summaries", () => {
  assert.equal(parseCogAmountToCogtoshi("12.3456789"), 1_234_567_890n);
  assert.deepEqual(createTransferEconomicEffectSummary(true), {
    kind: "ownership-transfer",
    clearsListing: true,
  });
  assert.deepEqual(createSellEconomicEffectSummary(0n), {
    kind: "listing-clear",
    listedPriceCogtoshi: "0",
  });
  assert.deepEqual(createSellEconomicEffectSummary(250n), {
    kind: "listing-set",
    listedPriceCogtoshi: "250",
  });
});
