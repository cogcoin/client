import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readPortableWalletArchive, writePortableWalletArchive } from "../src/wallet/archive.js";
import { deriveKeyFromPassphrase } from "../src/wallet/state/crypto.js";
import type { PortableWalletArchivePayloadV1 } from "../src/wallet/types.js";

const PRE_WASM_ARCHIVE_FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/portable-wallet-archive.pre-wasm.json",
);

function createPortableWalletArchivePayload(
  partial: Partial<PortableWalletArchivePayloadV1> = {},
): PortableWalletArchivePayloadV1 {
  return {
    schemaVersion: 1,
    exportedAtUnixMs: 1_700_000_100_000,
    walletRootId: "wallet-root-test",
    network: "mainnet",
    anchorValueSats: 2_000,
    proactiveReserveSats: 50_000,
    proactiveReserveOutpoints: [],
    nextDedicatedIndex: 1,
    fundingIndex: 0,
    mnemonic: {
      phrase: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
      language: "english",
    },
    expected: {
      masterFingerprintHex: "1234abcd",
      accountPath: "m/84'/0'/0'",
      accountXpub: "xpub-test",
      publicExternalDescriptor: "wpkh([1234abcd/84h/0h/0h]xpub-test/0/*)#pub",
      descriptorChecksum: "pub",
      rangeEnd: 4095,
      safetyMargin: 128,
      fundingAddress0: "bc1qfundingidentity0000000000000000000000000",
      fundingScriptPubKeyHex0: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
      walletBirthTime: 1_700_000_000,
    },
    identities: [],
    domains: [],
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
      liveMiningFamilyInMempool: false,
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
        validationState: "unknown",
        lastValidationAtUnixMs: null,
        lastValidationError: null,
        validatedLaunchFingerprint: null,
        validatedFullFingerprint: null,
        fullTrustWarningAcknowledgedAtUnixMs: null,
        consecutiveFailureCount: 0,
        cooldownUntilUnixMs: null,
      },
    },
    proactiveFamilies: [],
    ...partial,
  };
}

test("deriveKeyFromPassphrase preserves the argon2id parameter mapping", async () => {
  const derived = await deriveKeyFromPassphrase("correct horse battery staple", {
    salt: Buffer.from("00112233445566778899aabbccddeeff", "hex"),
    memoryKib: 65_536,
    iterations: 3,
    parallelism: 1,
  });

  assert.equal(Buffer.from(derived.key).toString("hex"), "c63a7e80f29a251ff0f1067c51d08ff12594199c5d2bd4a51d95348f3a205883");
  assert.deepEqual(derived.params, {
    name: "argon2id",
    memoryKib: 65_536,
    iterations: 3,
    parallelism: 1,
    salt: "ABEiM0RVZneImaq7zN3u/w==",
  });
});

test("portable wallet archives round-trip with a passphrase", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-archive-"));
  const archivePath = join(tempRoot, "wallet.cogwallet");
  const payload = createPortableWalletArchivePayload();

  await writePortableWalletArchive(archivePath, payload, "archive-passphrase");

  const loaded = await readPortableWalletArchive(archivePath, "archive-passphrase");
  assert.deepEqual(loaded, payload);
});

test("portable wallet archives created before the wasm migration still decrypt", async () => {
  const loaded = await readPortableWalletArchive(PRE_WASM_ARCHIVE_FIXTURE_PATH, "correct horse battery staple");

  assert.equal(loaded.walletRootId, "wallet-root-golden");
  assert.equal(loaded.expected.accountPath, "m/84'/0'/0'");
  assert.equal(loaded.expected.accountXpub, "xpub-test");
  assert.equal(loaded.mnemonic.language, "english");
});
