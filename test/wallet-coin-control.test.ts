import test from "node:test";
import assert from "node:assert/strict";

import { normalizeWalletStateRecord } from "../src/wallet/coin-control.js";

test("wallet state normalization keeps schema 4 and drops old reserve baggage", () => {
  const normalized = normalizeWalletStateRecord({
    schemaVersion: 1,
    stateRevision: 1,
    lastWrittenAtUnixMs: 1,
    walletRootId: "wallet-root",
    network: "mainnet",
    anchorValueSats: 2_000,
    mnemonic: {
      phrase: `${"abandon ".repeat(23)}art`,
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
      proofStatus: "ready",
      lastImportedAtUnixMs: null,
      lastVerifiedAtUnixMs: null,
    },
    domains: [],
    proactiveReserveSats: 1_000,
    proactiveReserveOutpoints: [{ txid: "aa".repeat(32), vout: 1 }],
    miningState: {
      runMode: "stopped",
      state: "idle",
      pauseReason: null,
      currentPublishState: "none",
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
      liveMiningFamilyInMempool: true,
      currentPublishDecision: null,
      replacementCount: 0,
      currentBlockFeeSpentSats: "0",
      sessionFeeSpentSats: "0",
      lifetimeFeeSpentSats: "0",
      sharedMiningConflictOutpoint: null,
    },
    hookClientState: {
      mining: {
        mode: "builtin",
        validationState: "current",
        lastValidationAtUnixMs: null,
        lastValidationError: null,
        validatedLaunchFingerprint: null,
        validatedFullFingerprint: null,
        fullTrustWarningAcknowledgedAtUnixMs: null,
        consecutiveFailureCount: 0,
        cooldownUntilUnixMs: null,
      },
    },
  } as any);

  assert.equal(normalized.schemaVersion, 4);
  assert.equal(normalized.miningState.livePublishInMempool, true);
  assert.equal("proactiveReserveSats" in normalized, false);
  assert.equal("proactiveReserveOutpoints" in normalized, false);
});
