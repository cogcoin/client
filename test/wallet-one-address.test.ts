import test from "node:test";
import assert from "node:assert/strict";

import { parseCliArgs } from "../src/cli/parse.js";
import { buildAnchorMutationData, buildFieldMutationData } from "../src/cli/mutation-json.js";
import { buildAnchorPreviewData, buildFieldPreviewData } from "../src/cli/preview-json.js";
import { normalizeWalletStateRecord } from "../src/wallet/coin-control.js";
import { createWalletReadModel } from "../src/wallet/read/project.js";

function createMiningState() {
  return {
    runMode: "stopped" as const,
    state: "idle" as const,
    pauseReason: null,
    currentPublishState: "none" as const,
    currentDomain: null,
    currentDomainId: null,
    currentDomainIndex: null,
    currentSenderScriptPubKeyHex: null,
    currentTxid: null,
    currentWtxid: null,
    currentFeeRateSatVb: null,
    currentAbsoluteFeeSats: null,
    currentScore: null,
    currentSentence: null,
    currentEncodedSentenceBytesHex: null,
    currentBip39WordIndices: null,
    currentBlendSeedHex: null,
    currentBlockTargetHeight: null,
    currentReferencedBlockHashDisplay: null,
    currentIntentFingerprintHex: null,
    livePublishInMempool: null,
    currentPublishDecision: null,
    replacementCount: 0,
    currentBlockFeeSpentSats: "0",
    sessionFeeSpentSats: "0",
    lifetimeFeeSpentSats: "0",
    sharedMiningConflictOutpoint: null,
  };
}

function createHookState() {
  return {
    mining: {
      mode: "builtin" as const,
      validationState: "current" as const,
      lastValidationAtUnixMs: null,
      lastValidationError: null,
      validatedLaunchFingerprint: null,
      validatedFullFingerprint: null,
      fullTrustWarningAcknowledgedAtUnixMs: null,
      consecutiveFailureCount: 0,
      cooldownUntilUnixMs: null,
    },
  };
}

test("normalizeWalletStateRecord migrates legacy multi-identity state into schema 4", () => {
  const normalized = normalizeWalletStateRecord({
    schemaVersion: 1,
    stateRevision: 7,
    lastWrittenAtUnixMs: 111,
    walletRootId: "wallet-root",
    network: "mainnet",
    anchorValueSats: 2_000,
    mnemonic: {
      phrase: "abandon ".repeat(23) + "art",
      language: "english",
    },
    keys: {
      masterFingerprintHex: "11".repeat(4),
      accountPath: "m/84'/0'/0'",
      accountXprv: "xprv-test",
      accountXpub: "xpub-test",
    },
    descriptor: {
      privateExternal: "wpkh(xprv-test/0/*)",
      publicExternal: "wpkh(xpub-test/0/*)",
      checksum: "abcd1234",
      rangeEnd: 50,
      safetyMargin: 20,
    },
    funding: {
      address: "bc1qfunding",
      scriptPubKeyHex: "0014" + "11".repeat(20),
    },
    walletBirthTime: 123456,
    managedCoreWallet: {
      walletName: "wallet.dat",
      internalPassphrase: "passphrase",
      descriptorChecksum: "abcd1234",
      fundingAddress0: "bc1qlegacy",
      fundingScriptPubKeyHex0: "0014" + "22".repeat(20),
      proofStatus: "ready",
      lastImportedAtUnixMs: 222,
      lastVerifiedAtUnixMs: 333,
    },
    identities: [
      { scriptPubKeyHex: "0014" + "33".repeat(20) },
      { scriptPubKeyHex: "0014" + "44".repeat(20) },
    ],
    domains: [
      {
        name: "alpha",
        domainId: 7,
        currentOwnerScriptPubKeyHex: "0014" + "33".repeat(20),
        canonicalChainStatus: "registered-unanchored",
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: "hello",
        birthTime: 999,
      },
    ],
    pendingMutations: [
      {
        mutationId: "confirmed",
        kind: "anchor",
        domainName: "alpha",
        parentDomainName: null,
        senderLocalIndex: 1,
        senderScriptPubKeyHex: "0014" + "33".repeat(20),
        intentFingerprintHex: "aa".repeat(32),
        status: "confirmed",
        createdAtUnixMs: 1,
        lastUpdatedAtUnixMs: 2,
        attemptedTxid: "bb".repeat(32),
        attemptedWtxid: null,
        temporaryBuilderLockedOutpoints: [{ txid: "cc".repeat(32), vout: 0 }],
      },
      {
        mutationId: "draft",
        kind: "anchor",
        domainName: "beta",
        parentDomainName: null,
        senderLocalIndex: 2,
        senderScriptPubKeyHex: "0014" + "44".repeat(20),
        intentFingerprintHex: "dd".repeat(32),
        status: "draft",
        createdAtUnixMs: 3,
        lastUpdatedAtUnixMs: 4,
        attemptedTxid: null,
        attemptedWtxid: null,
        temporaryBuilderLockedOutpoints: [{ txid: "ee".repeat(32), vout: 1 }],
      },
    ],
    miningState: createMiningState(),
    hookClientState: createHookState(),
  } as unknown as Parameters<typeof normalizeWalletStateRecord>[0]);

  assert.equal(normalized.schemaVersion, 4);
  assert.equal(normalized.managedCoreWallet.walletAddress, "bc1qfunding");
  assert.equal(normalized.managedCoreWallet.walletScriptPubKeyHex, "0014" + "11".repeat(20));
  assert.deepEqual(normalized.localScriptPubKeyHexes, [
    "0014" + "11".repeat(20),
    "0014" + "33".repeat(20),
    "0014" + "44".repeat(20),
  ]);
  assert.equal(normalized.pendingMutations?.length, 1);
  assert.equal(normalized.pendingMutations?.[0]?.status, "confirmed");
  assert.deepEqual(normalized.pendingMutations?.[0]?.temporaryBuilderLockedOutpoints, []);
});

test("createWalletReadModel exposes one wallet address and treats historical local scripts as local owners", () => {
  const model = createWalletReadModel({
    schemaVersion: 4,
    stateRevision: 1,
    lastWrittenAtUnixMs: 100,
    walletRootId: "wallet-root",
    network: "mainnet",
    anchorValueSats: 2_000,
    localScriptPubKeyHexes: ["0014" + "77".repeat(20)],
    mnemonic: {
      phrase: "abandon ".repeat(23) + "art",
      language: "english",
    },
    keys: {
      masterFingerprintHex: "11".repeat(4),
      accountPath: "m/84'/0'/0'",
      accountXprv: "xprv-test",
      accountXpub: "xpub-test",
    },
    descriptor: {
      privateExternal: "wpkh(xprv-test/0/*)",
      publicExternal: "wpkh(xpub-test/0/*)",
      checksum: "abcd1234",
      rangeEnd: 10,
      safetyMargin: 5,
    },
    funding: {
      address: "bc1qfunding",
      scriptPubKeyHex: "0014" + "11".repeat(20),
    },
    walletBirthTime: 123,
    managedCoreWallet: {
      walletName: "wallet.dat",
      internalPassphrase: "passphrase",
      descriptorChecksum: "abcd1234",
      walletAddress: "bc1qfunding",
      walletScriptPubKeyHex: "0014" + "11".repeat(20),
      proofStatus: "ready",
      lastImportedAtUnixMs: null,
      lastVerifiedAtUnixMs: null,
    },
    domains: [
      {
        name: "alpha",
        domainId: 1,
        currentOwnerScriptPubKeyHex: "0014" + "11".repeat(20),
        canonicalChainStatus: "registered-unanchored",
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: null,
        birthTime: 1,
      },
      {
        name: "beta",
        domainId: 2,
        currentOwnerScriptPubKeyHex: "0014" + "77".repeat(20),
        canonicalChainStatus: "anchored",
        currentCanonicalAnchorOutpoint: { txid: "aa".repeat(32), vout: 1, valueSats: 2_000 },
        foundingMessageText: "legacy",
        birthTime: 2,
      },
    ],
    miningState: createMiningState(),
    pendingMutations: [],
  }, null);

  assert.equal(model.walletAddress, "bc1qfunding");
  assert.equal(model.walletScriptPubKeyHex, "0014" + "11".repeat(20));
  assert.equal(model.domains.length, 2);
  assert.equal(model.domains.find((domain) => domain.name === "alpha")?.ownerAddress, "bc1qfunding");
  assert.equal(model.domains.find((domain) => domain.name === "alpha")?.localRelationship, "local");
  assert.equal(model.domains.find((domain) => domain.name === "beta")?.ownerAddress, null);
  assert.equal(model.domains.find((domain) => domain.name === "beta")?.localRelationship, "local");
});

test("parseCliArgs rejects removed multi-identity flags and anchor-clear command", () => {
  assert.throws(
    () => parseCliArgs(["register", "alpha", "--from", "id:1"]),
    /cli_from_not_supported_for_command/,
  );
  assert.throws(
    () => parseCliArgs(["anchor", "clear", "alpha"]),
    /cli_anchor_clear_removed/,
  );
});

test("parseCliArgs rejects removed field-create initial-value flags", () => {
  assert.throws(
    () => parseCliArgs(["field", "create", "alpha", "bio", "--text", "hello"]),
    /cli_field_create_initial_value_not_supported/,
  );
  assert.throws(
    () => parseCliArgs(["field", "create", "alpha", "bio", "--json", "{\"ok\":true}"]),
    /cli_field_create_initial_value_not_supported/,
  );
  assert.throws(
    () => parseCliArgs(["field", "create", "alpha", "bio", "--bytes", "hex:00ff"]),
    /cli_field_create_initial_value_not_supported/,
  );
  assert.throws(
    () => parseCliArgs(["field", "create", "alpha", "bio", "--format", "raw:1", "--value", "utf8:hello"]),
    /cli_field_create_initial_value_not_supported/,
  );
});

test("anchor and field-create emit single-tx mutation envelopes", () => {
  const anchorResult = {
    domainName: "alpha",
    txid: "aa".repeat(32),
    status: "live" as const,
    reusedExisting: false,
    foundingMessageText: "hello",
  };
  const fieldResult = {
    kind: "field-create" as const,
    domainName: "alpha",
    fieldName: "bio",
    fieldId: 7,
    txid: "bb".repeat(32),
    permanent: false,
    format: null,
    status: "live" as const,
    reusedExisting: false,
    resolved: {
      sender: {
        selector: "wallet",
        localIndex: 0,
        scriptPubKeyHex: "0014" + "11".repeat(20),
        address: "bc1qfunding",
      },
      path: "standalone-field-reg" as const,
      value: null,
      effect: {
        kind: "create-empty-field" as const,
        burnCogtoshi: "100" as const,
      },
    },
  };

  const anchorData = buildAnchorMutationData(anchorResult, {
    foundingMessageText: anchorResult.foundingMessageText,
  });
  const anchorPreview = buildAnchorPreviewData(anchorResult, {
    foundingMessageText: anchorResult.foundingMessageText,
  });
  const fieldData = buildFieldMutationData(fieldResult);
  const fieldPreview = buildFieldPreviewData(fieldResult);

  assert.equal(anchorData.resultType, "single-tx-mutation");
  assert.equal(anchorPreview.resultType, "single-tx-mutation");
  assert.equal(fieldData.resultType, "single-tx-mutation");
  assert.equal(fieldPreview.resultType, "single-tx-mutation");
  assert.deepEqual(anchorData.transaction, { txid: anchorResult.txid, wtxid: null });
  assert.deepEqual(fieldData.transaction, { txid: fieldResult.txid, wtxid: null });
});
