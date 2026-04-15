import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveBootstrapPathsForTesting } from "../src/bitcoind/bootstrap/paths.js";
import { deriveWalletMaterialFromMnemonic } from "../src/wallet/material.js";
import { previewResetWallet, resetWallet, type WalletPrompter } from "../src/wallet/lifecycle.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  createMemoryWalletSecretProviderForTesting,
  createWalletSecretReference,
} from "../src/wallet/state/provider.js";
import { loadWalletExplicitLock, saveWalletExplicitLock } from "../src/wallet/state/explicit-lock.js";
import { loadUnlockSession, saveUnlockSession } from "../src/wallet/state/session.js";
import { loadWalletState, saveWalletState } from "../src/wallet/state/storage.js";
import type { WalletStateV1 } from "../src/wallet/types.js";

const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

function createTempWalletPaths(root: string) {
  return resolveWalletRuntimePathsForTesting({
    platform: "linux",
    homeDirectory: root,
    env: {
      XDG_DATA_HOME: join(root, "data"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_RUNTIME_DIR: join(root, "runtime"),
    },
  });
}

function createWalletState(partial: Partial<WalletStateV1> = {}): WalletStateV1 {
  const material = deriveWalletMaterialFromMnemonic(TEST_MNEMONIC);

  return {
    schemaVersion: 1,
    stateRevision: 7,
    lastWrittenAtUnixMs: 1_700_000_000_000,
    walletRootId: "wallet-root-old",
    network: "mainnet",
    anchorValueSats: 2_000,
    nextDedicatedIndex: 4,
    fundingIndex: 0,
    mnemonic: {
      phrase: TEST_MNEMONIC,
      language: "english",
    },
    keys: {
      masterFingerprintHex: material.keys.masterFingerprintHex,
      accountPath: material.keys.accountPath,
      accountXprv: material.keys.accountXprv,
      accountXpub: material.keys.accountXpub,
    },
    descriptor: {
      privateExternal: `${material.descriptor.privateExternal}#oldpriv`,
      publicExternal: `${material.descriptor.publicExternal}#oldpub`,
      checksum: "oldpub",
      rangeEnd: 2048,
      safetyMargin: 96,
    },
    funding: {
      address: material.funding.address,
      scriptPubKeyHex: material.funding.scriptPubKeyHex,
    },
    walletBirthTime: 1_700_000_000,
    managedCoreWallet: {
      walletName: "cogcoin-wallet-root-old",
      internalPassphrase: "core-passphrase-old",
      descriptorChecksum: "oldpub",
      fundingAddress0: material.funding.address,
      fundingScriptPubKeyHex0: material.funding.scriptPubKeyHex,
      proofStatus: "ready",
      lastImportedAtUnixMs: 1_700_000_000_000,
      lastVerifiedAtUnixMs: 1_700_000_000_000,
    },
    identities: [
      {
        index: 0,
        scriptPubKeyHex: material.funding.scriptPubKeyHex,
        address: material.funding.address,
        status: "funding",
        assignedDomainNames: ["alpha"],
      },
      {
        index: 1,
        scriptPubKeyHex: "00140101010101010101010101010101010101010101",
        address: "bc1qalphaowner0000000000000000000000000000",
        status: "dedicated",
        assignedDomainNames: ["alpha"],
      },
      {
        index: 3,
        scriptPubKeyHex: "00140303030303030303030303030303030303030303",
        address: "bc1qgammaowner0000000000000000000000000000",
        status: "dedicated",
        assignedDomainNames: ["gamma"],
      },
      {
        index: 9,
        scriptPubKeyHex: "00140909090909090909090909090909090909090909",
        address: "bc1qreadonly0000000000000000000000000000000",
        status: "read-only",
        assignedDomainNames: ["readonly"],
      },
    ],
    domains: [
      {
        name: "alpha",
        domainId: 1,
        dedicatedIndex: 1,
        currentOwnerScriptPubKeyHex: "00140101010101010101010101010101010101010101",
        currentOwnerLocalIndex: 1,
        canonicalChainStatus: "anchored",
        localAnchorIntent: "none",
        currentCanonicalAnchorOutpoint: {
          txid: "aa".repeat(32),
          vout: 0,
          valueSats: 2_000,
        },
        foundingMessageText: "founding",
        birthTime: 1_700_000_000,
      },
    ],
    miningState: {
      runMode: "background",
      state: "live",
      pauseReason: null,
      currentPublishState: "in-mempool",
      currentDomain: "alpha",
      currentDomainId: 1,
      currentDomainIndex: 1,
      currentSenderScriptPubKeyHex: "00140101010101010101010101010101010101010101",
      currentTxid: "bb".repeat(32),
      currentWtxid: "cc".repeat(32),
      currentFeeRateSatVb: 10,
      currentAbsoluteFeeSats: 1_000,
      currentScore: "1",
      currentSentence: "sentence",
      currentEncodedSentenceBytesHex: "aa",
      currentBip39WordIndices: [1, 2, 3],
      currentBlendSeedHex: "bb",
      currentBlockTargetHeight: 100,
      currentReferencedBlockHashDisplay: "0000",
      currentIntentFingerprintHex: "cc",
      liveMiningFamilyInMempool: true,
      currentPublishDecision: "keep",
      replacementCount: 1,
      currentBlockFeeSpentSats: "1000",
      sessionFeeSpentSats: "1000",
      lifetimeFeeSpentSats: "1000",
      sharedMiningConflictOutpoint: null,
    },
    hookClientState: {
      mining: {
        mode: "custom",
        validationState: "validated",
        lastValidationAtUnixMs: 1_700_000_000_000,
        lastValidationError: null,
        validatedLaunchFingerprint: "aa",
        validatedFullFingerprint: "bb",
        fullTrustWarningAcknowledgedAtUnixMs: 1_700_000_000_000,
        consecutiveFailureCount: 0,
        cooldownUntilUnixMs: null,
      },
    },
    proactiveFamilies: [
      {
        familyId: "family-1",
        type: "anchor",
        status: "live",
        intentFingerprintHex: "dd",
        createdAtUnixMs: 1_700_000_000_000,
      },
    ],
    pendingMutations: [
      {
        mutationId: "mutation-1",
        kind: "register",
        domainName: "alpha-child",
        parentDomainName: "alpha",
        senderScriptPubKeyHex: material.funding.scriptPubKeyHex,
        senderLocalIndex: 0,
        intentFingerprintHex: "ee",
        status: "draft",
        createdAtUnixMs: 1_700_000_000_000,
        lastUpdatedAtUnixMs: 1_700_000_000_000,
        attemptedTxid: null,
        attemptedWtxid: null,
        temporaryBuilderLockedOutpoints: [],
      },
    ],
    ...partial,
  };
}

class ScriptedPrompter implements WalletPrompter {
  readonly isInteractive = true;
  readonly lines: string[] = [];
  readonly prompts: string[] = [];
  readonly hiddenPrompts: string[] = [];
  readonly visibleAnswers: string[];
  readonly hiddenAnswers: string[];

  constructor(options: {
    visibleAnswers: string[];
    hiddenAnswers?: string[];
  }) {
    this.visibleAnswers = [...options.visibleAnswers];
    this.hiddenAnswers = [...(options.hiddenAnswers ?? [])];
  }

  writeLine(message: string): void {
    this.lines.push(message);
  }

  async prompt(message: string): Promise<string> {
    this.prompts.push(message);
    const answer = this.visibleAnswers.shift();
    if (answer === undefined) {
      throw new Error(`unexpected_prompt_${message}`);
    }
    return answer;
  }

  async promptHidden(message: string): Promise<string> {
    this.hiddenPrompts.push(message);
    const answer = this.hiddenAnswers.shift();
    if (answer === undefined) {
      throw new Error(`unexpected_hidden_prompt_${message}`);
    }
    return answer;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    return true;
  }
}

async function isAlive(pid: number | null | undefined): Promise<boolean> {
  if (pid == null) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("reset preserves base entropy for provider-backed wallets and clears derived local state", async () => {
  const root = await mkdtemp(join(tmpdir(), "cogcoin-reset-provider-"));
  const paths = createTempWalletPaths(root);
  const provider = createMemoryWalletSecretProviderForTesting();
  const state = createWalletState();
  const secretReference = createWalletSecretReference(state.walletRootId);
  const prompter = new ScriptedPrompter({
    visibleAnswers: ["permanently reset", ""],
  });

  try {
    await provider.storeSecret(secretReference.keyId, randomBytes(32));
    await saveWalletState(
      {
        primaryPath: paths.walletStatePath,
        backupPath: paths.walletStateBackupPath,
      },
      state,
      {
        provider,
        secretReference,
      },
    );
    await saveWalletExplicitLock(paths.walletExplicitLockPath, {
      schemaVersion: 1,
      walletRootId: state.walletRootId,
      lockedAtUnixMs: 1_700_000_010_000,
    });
    await saveUnlockSession(
      paths.walletUnlockSessionPath,
      {
        schemaVersion: 1,
        walletRootId: state.walletRootId,
        sessionId: "session-1",
        createdAtUnixMs: 1_700_000_000_000,
        unlockUntilUnixMs: 1_700_000_900_000,
        sourceStateRevision: state.stateRevision,
        wrappedSessionKeyMaterial: secretReference.keyId,
      },
      {
        provider,
        secretReference,
      },
    );

    const result = await resetWallet({
      dataDir: paths.bitcoinDataDir,
      provider,
      paths,
      nowUnixMs: 1_700_000_100_000,
      prompter,
    });

    assert.equal(result.walletAction, "retain-mnemonic");
    assert.equal(result.walletOldRootId, state.walletRootId);
    assert.notEqual(result.walletNewRootId, state.walletRootId);
    assert.equal(result.bootstrapSnapshot.status, "not-present");

    const loaded = await loadWalletState(
      {
        primaryPath: paths.walletStatePath,
        backupPath: paths.walletStateBackupPath,
      },
      {
        provider,
      },
    );

    assert.equal(loaded.state.mnemonic.phrase, state.mnemonic.phrase);
    assert.equal(loaded.state.walletBirthTime, state.walletBirthTime);
    assert.equal(loaded.state.nextDedicatedIndex, state.nextDedicatedIndex);
    assert.equal(loaded.state.descriptor.rangeEnd, state.descriptor.rangeEnd);
    assert.equal(loaded.state.descriptor.safetyMargin, state.descriptor.safetyMargin);
    assert.equal(loaded.state.walletRootId, result.walletNewRootId);
    assert.equal(loaded.state.managedCoreWallet.proofStatus, "not-proven");
    assert.deepEqual(
      loaded.state.identities.map((identity) => ({
        index: identity.index,
        status: identity.status,
        assignedDomainNames: identity.assignedDomainNames,
      })),
      [
        { index: 0, status: "funding", assignedDomainNames: [] },
        { index: 1, status: "dedicated", assignedDomainNames: [] },
        { index: 3, status: "dedicated", assignedDomainNames: [] },
      ],
    );
    assert.deepEqual(loaded.state.domains, []);
    assert.deepEqual(loaded.state.proactiveFamilies, []);
    assert.deepEqual(loaded.state.pendingMutations, []);
    assert.equal(await loadWalletExplicitLock(paths.walletExplicitLockPath), null);
    assert.deepEqual(prompter.prompts, [
      "Type \"permanently reset\" to continue: ",
      "Wallet reset choice ([Enter] retain base entropy, \"skip\", or \"delete wallet\"): ",
    ]);
    await assert.rejects(
      () => loadUnlockSession(paths.walletUnlockSessionPath, { provider }),
      /ENOENT|wallet_secret_missing_/,
    );
    await assert.rejects(
      () => provider.loadSecret(secretReference.keyId),
      /wallet_secret_missing_/,
    );
    await provider.loadSecret(createWalletSecretReference(result.walletNewRootId!).keyId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reset uses hidden passphrase input for passphrase-wrapped entropy-retaining resets", async () => {
  const root = await mkdtemp(join(tmpdir(), "cogcoin-reset-passphrase-"));
  const paths = createTempWalletPaths(root);
  const provider = createMemoryWalletSecretProviderForTesting();
  const state = createWalletState();
  const passphrase = "wallet-passphrase";
  const prompter = new ScriptedPrompter({
    visibleAnswers: ["permanently reset", ""],
    hiddenAnswers: [passphrase],
  });

  try {
    await saveWalletState(
      {
        primaryPath: paths.walletStatePath,
        backupPath: paths.walletStateBackupPath,
      },
      state,
      passphrase,
    );

    const result = await resetWallet({
      dataDir: paths.bitcoinDataDir,
      provider,
      paths,
      nowUnixMs: 1_700_000_200_000,
      prompter,
    });

    assert.equal(result.walletAction, "retain-mnemonic");
    assert.deepEqual(prompter.hiddenPrompts, ["Wallet-state passphrase: "]);

    const loaded = await loadWalletState(
      {
        primaryPath: paths.walletStatePath,
        backupPath: paths.walletStateBackupPath,
      },
      passphrase,
    );
    assert.equal(loaded.state.walletRootId, result.walletNewRootId);
    assert.equal(loaded.state.mnemonic.phrase, state.mnemonic.phrase);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reset can keep the wallet unchanged, preserve a valid snapshot, and kill only tracked managed processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cogcoin-reset-skip-"));
  const paths = createTempWalletPaths(root);
  const provider = createMemoryWalletSecretProviderForTesting();
  const state = createWalletState();
  const secretReference = createWalletSecretReference(state.walletRootId);
  const snapshotPaths = resolveBootstrapPathsForTesting(paths.bitcoinDataDir);
  const tracked = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000);"], {
    stdio: "ignore",
  });
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000);"], {
    stdio: "ignore",
  });

  try {
    await provider.storeSecret(secretReference.keyId, randomBytes(32));
    await saveWalletState(
      {
        primaryPath: paths.walletStatePath,
        backupPath: paths.walletStateBackupPath,
      },
      state,
      {
        provider,
        secretReference,
      },
    );
    await saveWalletExplicitLock(paths.walletExplicitLockPath, {
      schemaVersion: 1,
      walletRootId: state.walletRootId,
      lockedAtUnixMs: 1_700_000_010_000,
    });
    await mkdir(join(paths.runtimeRoot, state.walletRootId), { recursive: true });
    await writeFile(
      join(paths.runtimeRoot, state.walletRootId, "bitcoind-status.json"),
      JSON.stringify({
        processId: tracked.pid,
      }),
      "utf8",
    );
    await mkdir(snapshotPaths.directory, { recursive: true });
    await writeFile(snapshotPaths.snapshotPath, "snapshot", "utf8");

    const result = await resetWallet({
      dataDir: paths.bitcoinDataDir,
      provider,
      paths,
      nowUnixMs: 1_700_000_300_000,
      validateSnapshotFile: async () => {},
      prompter: new ScriptedPrompter({
        visibleAnswers: ["permanently reset", "skip", ""],
      }),
    });

    assert.equal(result.walletAction, "kept-unchanged");
    assert.equal(result.bootstrapSnapshot.status, "preserved");
    assert.equal(result.stoppedProcesses.managedBitcoind, 1);
    assert.equal(await isAlive(tracked.pid), false);
    assert.equal(await isAlive(unrelated.pid), true);

    const loaded = await loadWalletState(
      {
        primaryPath: paths.walletStatePath,
        backupPath: paths.walletStateBackupPath,
      },
      {
        provider,
      },
    );
    assert.equal(loaded.state.walletRootId, state.walletRootId);
    assert.equal((await loadWalletExplicitLock(paths.walletExplicitLockPath))?.walletRootId, state.walletRootId);
    await assert.rejects(
      () => loadUnlockSession(paths.walletUnlockSessionPath, { provider }),
      /ENOENT|wallet_secret_missing_/,
    );
    assert.equal(await pathExists(snapshotPaths.snapshotPath), true);
    assert.equal(await pathExists(snapshotPaths.statePath), false);
  } finally {
    if (await isAlive(tracked.pid)) {
      tracked.kill("SIGKILL");
    }
    if (await isAlive(unrelated.pid)) {
      unrelated.kill("SIGKILL");
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("reset preview exposes wallet, snapshot, and managed-process preflight information", async () => {
  const root = await mkdtemp(join(tmpdir(), "cogcoin-reset-preview-"));
  const paths = createTempWalletPaths(root);
  const provider = createMemoryWalletSecretProviderForTesting();
  const state = createWalletState();
  const secretReference = createWalletSecretReference(state.walletRootId);
  const snapshotPaths = resolveBootstrapPathsForTesting(paths.bitcoinDataDir);

  try {
    await provider.storeSecret(secretReference.keyId, randomBytes(32));
    await saveWalletState(
      {
        primaryPath: paths.walletStatePath,
        backupPath: paths.walletStateBackupPath,
      },
      state,
      {
        provider,
        secretReference,
      },
    );
    await mkdir(snapshotPaths.directory, { recursive: true });
    await writeFile(snapshotPaths.snapshotPath, "snapshot", "utf8");

    const preview = await previewResetWallet({
      dataDir: paths.bitcoinDataDir,
      provider,
      paths,
      validateSnapshotFile: async () => {},
    });

    assert.equal(preview.walletPrompt?.defaultAction, "retain-mnemonic");
    assert.equal(preview.walletPrompt?.requiresPassphrase, false);
    assert.equal(preview.bootstrapSnapshot.status, "valid");
    assert.equal(preview.bootstrapSnapshot.defaultAction, "preserve");
    assert.equal(preview.willDeleteOsSecrets, true);
    assert.ok(preview.removedPaths.includes(paths.dataRoot));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
