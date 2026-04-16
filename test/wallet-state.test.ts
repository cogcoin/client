import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { encryptJsonWithPassphrase } from "../src/wallet/state/crypto.js";
import { createMemoryWalletSecretProviderForTesting, createWalletSecretReference } from "../src/wallet/state/provider.js";
import { clearUnlockSession, loadUnlockSession, saveUnlockSession } from "../src/wallet/state/session.js";
import {
  extractWalletRootIdHintFromWalletStateEnvelope,
  loadRawWalletStateEnvelope,
  loadWalletState,
  saveWalletState,
} from "../src/wallet/state/storage.js";
import type { UnlockSessionStateV1, WalletStateV1 } from "../src/wallet/types.js";

function createWalletState(partial: Partial<WalletStateV1> = {}): WalletStateV1 {
  return {
    schemaVersion: 1,
    stateRevision: 1,
    lastWrittenAtUnixMs: 1_700_000_000_000,
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
    keys: {
      masterFingerprintHex: "1234abcd",
      accountPath: "m/84'/0'/0'",
      accountXprv: "xprv-test",
      accountXpub: "xpub-test",
    },
    descriptor: {
      privateExternal: "wpkh([1234abcd/84h/0h/0h]xprv-test/0/*)#priv",
      publicExternal: "wpkh([1234abcd/84h/0h/0h]xpub-test/0/*)#pub",
      checksum: "priv",
      rangeEnd: 4095,
      safetyMargin: 128,
    },
    funding: {
      address: "bc1qfundingidentity0000000000000000000000000",
      scriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    },
    walletBirthTime: 1_700_000_000,
    managedCoreWallet: {
      walletName: "cogcoin-wallet-root-test",
      internalPassphrase: "core-passphrase",
      descriptorChecksum: "priv",
      fundingAddress0: "bc1qfundingidentity0000000000000000000000000",
      fundingScriptPubKeyHex0: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
      proofStatus: "ready",
      lastImportedAtUnixMs: 1_700_000_000_000,
      lastVerifiedAtUnixMs: 1_700_000_000_000,
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

test("wallet state encryption round-trips with a passphrase", async () => {
  const envelope = await encryptJsonWithPassphrase(
    createWalletState(),
    "correct horse battery staple",
    { format: "cogcoin-local-wallet-state" },
  );

  assert.equal(envelope.format, "cogcoin-local-wallet-state");
  assert.equal(envelope.cipher, "aes-256-gcm");
  assert.ok(envelope.argon2id);
  assert.equal(envelope.argon2id.name, "argon2id");
  assert.notEqual(envelope.ciphertext.length, 0);
});

test("wallet state saves a primary file and refreshes a backup from the prior primary", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-state-"));
  const primaryPath = join(tempRoot, "wallet-state.enc");
  const backupPath = join(tempRoot, "wallet-state.enc.bak");
  const passphrase = "correct horse battery staple";

  await saveWalletState(
    { primaryPath, backupPath },
    createWalletState({ stateRevision: 1 }),
    passphrase,
  );

  await saveWalletState(
    { primaryPath, backupPath },
    createWalletState({ stateRevision: 2 }),
    passphrase,
  );

  const loaded = await loadWalletState({ primaryPath, backupPath }, passphrase);
  const raw = await loadRawWalletStateEnvelope({ primaryPath, backupPath });
  const backupRaw = await readFile(backupPath, "utf8");

  assert.equal(loaded.source, "primary");
  assert.equal(loaded.state.stateRevision, 2);
  assert.equal(raw?.envelope.walletRootIdHint, "wallet-root-test");
  assert.equal(extractWalletRootIdHintFromWalletStateEnvelope(raw?.envelope ?? null), "wallet-root-test");
  assert.match(backupRaw, /"ciphertext"/);
});

test("wallet state also round-trips through a provider-backed envelope", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-state-provider-"));
  const primaryPath = join(tempRoot, "wallet-state.enc");
  const backupPath = join(tempRoot, "wallet-state.enc.bak");
  const provider = createMemoryWalletSecretProviderForTesting();
  const secretReference = createWalletSecretReference("wallet-root-test");

  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 7));
  await saveWalletState(
    { primaryPath, backupPath },
    createWalletState({ stateRevision: 9 }),
    {
      provider,
      secretReference,
    },
  );

  const loaded = await loadWalletState({ primaryPath, backupPath }, {
    provider,
  });
  const raw = await loadRawWalletStateEnvelope({ primaryPath, backupPath });
  assert.equal(loaded.state.stateRevision, 9);
  assert.equal(loaded.state.walletRootId, "wallet-root-test");
  assert.equal(raw?.envelope.walletRootIdHint, "wallet-root-test");
  assert.equal(extractWalletRootIdHintFromWalletStateEnvelope(raw?.envelope ?? null), "wallet-root-test");
});

test("wallet root resolution falls back to the legacy provider key id when the hint is absent", async () => {
  const envelope = await encryptJsonWithPassphrase(
    createWalletState(),
    "correct horse battery staple",
    {
      format: "cogcoin-local-wallet-state",
      walletRootIdHint: null,
    },
  );

  envelope.secretProvider = {
    kind: "wallet-state-key",
    keyId: "wallet-state:wallet-root-legacy",
  };

  assert.equal(extractWalletRootIdHintFromWalletStateEnvelope(envelope), "wallet-root-legacy");
});

test("wallet state falls back to backup when the primary is unreadable", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-state-fallback-"));
  const primaryPath = join(tempRoot, "wallet-state.enc");
  const backupPath = join(tempRoot, "wallet-state.enc.bak");
  const passphrase = "correct horse battery staple";

  await saveWalletState(
    { primaryPath, backupPath },
    createWalletState({ stateRevision: 1 }),
    passphrase,
  );
  await saveWalletState(
    { primaryPath, backupPath },
    createWalletState({ stateRevision: 2 }),
    passphrase,
  );

  await writeFile(primaryPath, "{not-json", "utf8");

  const loaded = await loadWalletState({ primaryPath, backupPath }, passphrase);
  assert.equal(loaded.source, "backup");
  assert.equal(loaded.state.stateRevision, 1);
});

test("unlock sessions save, load, and clear through the encrypted runtime artifact", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-session-"));
  const sessionPath = join(tempRoot, "wallet-unlock-session.enc");
  const passphrase = "session passphrase";
  const session: UnlockSessionStateV1 = {
    schemaVersion: 1,
    walletRootId: "wallet-root-test",
    sessionId: "session-1",
    createdAtUnixMs: 1_700_000_000_000,
    unlockUntilUnixMs: 1_700_000_900_000,
    sourceStateRevision: 5,
    wrappedSessionKeyMaterial: "opaque-runtime-capability",
  };

  await saveUnlockSession(sessionPath, session, passphrase);

  const loaded = await loadUnlockSession(sessionPath, passphrase);
  assert.deepEqual(loaded, session);

  await clearUnlockSession(sessionPath);
  await assert.rejects(() => readFile(sessionPath, "utf8"));
});

test("unlock sessions also round-trip through a provider-backed envelope", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-session-provider-"));
  const sessionPath = join(tempRoot, "wallet-unlock-session.enc");
  const provider = createMemoryWalletSecretProviderForTesting();
  const secretReference = createWalletSecretReference("wallet-root-test");
  const session: UnlockSessionStateV1 = {
    schemaVersion: 1,
    walletRootId: "wallet-root-test",
    sessionId: "session-2",
    createdAtUnixMs: 1_700_000_000_000,
    unlockUntilUnixMs: 1_700_000_900_000,
    sourceStateRevision: 5,
    wrappedSessionKeyMaterial: secretReference.keyId,
  };

  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 9));
  await saveUnlockSession(sessionPath, session, {
    provider,
    secretReference,
  });

  const loaded = await loadUnlockSession(sessionPath, { provider });
  assert.deepEqual(loaded, session);
});
