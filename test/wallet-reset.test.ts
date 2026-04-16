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
import { addImportedWalletSeedRecord } from "../src/wallet/state/seed-index.js";
import {
  createMemoryWalletSecretProviderForTesting,
  createWalletSecretReference,
} from "../src/wallet/state/provider.js";
import { loadWalletExplicitLock, saveWalletExplicitLock } from "../src/wallet/state/explicit-lock.js";
import { loadUnlockSession, saveUnlockSession } from "../src/wallet/state/session.js";
import { loadWalletState, saveWalletState } from "../src/wallet/state/storage.js";
import type { WalletStateV1 } from "../src/wallet/types.js";

const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

function stripDescriptorChecksum(descriptor: string): string {
  return descriptor.replace(/#[A-Za-z0-9]+$/, "");
}

function createResetRpcHarness(state: WalletStateV1) {
  const importedDescriptors: string[] = [];
  const listedDescriptors: string[] = [];
  const wallets = new Set<string>();
  let walletLocked = false;
  const checksum = "resetchk";
  const normalizedPublicDescriptor = `${stripDescriptorChecksum(
    deriveWalletMaterialFromMnemonic(state.mnemonic.phrase).descriptor.publicExternal,
  )}#${checksum}`;

  return {
    rpcFactory() {
      return {
        async getDescriptorInfo(descriptor: string) {
          return {
            descriptor: stripDescriptorChecksum(descriptor),
            checksum,
          };
        },
        async walletPassphrase() {
          walletLocked = false;
          return null;
        },
        async createWallet(walletName: string) {
          wallets.add(walletName);
          return {
            name: walletName,
            warning: "",
          };
        },
        async importDescriptors(_walletName: string, requests: Array<{ desc: string }>) {
          importedDescriptors.push(...requests.map((request) => request.desc));
          if (!listedDescriptors.includes(normalizedPublicDescriptor)) {
            listedDescriptors.push(normalizedPublicDescriptor);
          }
          return requests.map(() => ({ success: true }));
        },
        async walletLock() {
          walletLocked = true;
          return null;
        },
        async loadWallet(walletName: string) {
          if (!wallets.has(walletName)) {
            throw new Error("bitcoind_rpc_loadwallet_-18_wallet_not_found");
          }

          return {
            name: walletName,
            warning: "",
          };
        },
        async listWallets() {
          return [...wallets];
        },
        async deriveAddresses() {
          return [state.funding.address];
        },
        async listDescriptors() {
          return {
            descriptors: listedDescriptors.map((desc) => ({ desc })),
          };
        },
        async getWalletInfo(walletName: string) {
          return {
            walletname: walletName,
            private_keys_enabled: true,
            descriptors: true,
          };
        },
      };
    },
    get importedDescriptors() {
      return importedDescriptors.slice();
    },
    get walletLocked() {
      return walletLocked;
    },
    get checksum() {
      return checksum;
    },
  };
}

function createTempWalletPaths(root: string, seedName?: string | null) {
  return resolveWalletRuntimePathsForTesting({
    platform: "linux",
    homeDirectory: root,
    env: {
      XDG_DATA_HOME: join(root, "data"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_RUNTIME_DIR: join(root, "runtime"),
    },
    seedName,
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
    proactiveReserveSats: 50_000,
    proactiveReserveOutpoints: [],
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
  const harness = createResetRpcHarness(state);
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
      attachService: async () => ({
        rpc: {
          url: "http://127.0.0.1:8332",
          cookieFile: "/tmp/does-not-matter",
          port: 8_332,
        },
      } as never),
      rpcFactory: harness.rpcFactory,
    });

    assert.equal(result.walletAction, "retain-mnemonic");
    assert.equal(result.walletOldRootId, state.walletRootId);
    assert.notEqual(result.walletNewRootId, state.walletRootId);
    assert.equal(result.bootstrapSnapshot.status, "not-present");
    assert.equal(result.bitcoinDataDir.status, "not-present");

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
    assert.equal(loaded.state.descriptor.checksum, harness.checksum);
    assert.equal(loaded.state.managedCoreWallet.proofStatus, "ready");
    assert.equal(loaded.state.managedCoreWallet.descriptorChecksum, harness.checksum);
    assert.equal(loaded.state.managedCoreWallet.fundingAddress0, loaded.state.funding.address);
    assert.equal(loaded.state.managedCoreWallet.fundingScriptPubKeyHex0, loaded.state.funding.scriptPubKeyHex);
    assert.equal(loaded.state.managedCoreWallet.lastImportedAtUnixMs, 1_700_000_100_000);
    assert.equal(loaded.state.managedCoreWallet.lastVerifiedAtUnixMs, 1_700_000_100_000);
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
    assert.equal(harness.importedDescriptors.length, 1);
    assert.equal(harness.walletLocked, true);
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

test("reset deletes imported seed secrets alongside the main wallet", async () => {
  const root = await mkdtemp(join(tmpdir(), "cogcoin-reset-imported-seeds-"));
  const mainPaths = createTempWalletPaths(root);
  const importedPaths = createTempWalletPaths(root, "trading");
  const provider = createMemoryWalletSecretProviderForTesting();
  const mainState = createWalletState();
  const importedBaseState = createWalletState();
  const importedState: WalletStateV1 = {
    ...importedBaseState,
    walletRootId: "wallet-root-imported",
    managedCoreWallet: {
      ...importedBaseState.managedCoreWallet,
      walletName: "cogcoin-wallet-root-imported",
    },
  };
  const mainSecretReference = createWalletSecretReference(mainState.walletRootId);
  const importedSecretReference = createWalletSecretReference(importedState.walletRootId);
  const prompter = new ScriptedPrompter({
    visibleAnswers: ["permanently reset", "delete wallet"],
  });

  try {
    await provider.storeSecret(mainSecretReference.keyId, randomBytes(32));
    await provider.storeSecret(importedSecretReference.keyId, randomBytes(32));
    await saveWalletState(
      {
        primaryPath: mainPaths.walletStatePath,
        backupPath: mainPaths.walletStateBackupPath,
      },
      mainState,
      {
        provider,
        secretReference: mainSecretReference,
      },
    );
    await saveWalletState(
      {
        primaryPath: importedPaths.walletStatePath,
        backupPath: importedPaths.walletStateBackupPath,
      },
      importedState,
      {
        provider,
        secretReference: importedSecretReference,
      },
    );
    await addImportedWalletSeedRecord({
      paths: mainPaths,
      seedName: "trading",
      walletRootId: importedState.walletRootId,
      nowUnixMs: 1_700_000_000_000,
    });

    const result = await resetWallet({
      dataDir: mainPaths.bitcoinDataDir,
      provider,
      paths: mainPaths,
      nowUnixMs: 1_700_000_100_000,
      prompter,
    });

    assert.equal(result.walletAction, "deleted");
    assert.equal(result.secretCleanupStatus, "deleted");
    assert.ok(result.deletedSecretRefs.includes(mainSecretReference.keyId));
    assert.ok(result.deletedSecretRefs.includes(importedSecretReference.keyId));
    await assert.rejects(() => provider.loadSecret(mainSecretReference.keyId), /wallet_secret_missing_/);
    await assert.rejects(() => provider.loadSecret(importedSecretReference.keyId), /wallet_secret_missing_/);
    assert.equal(await pathExists(mainPaths.seedRegistryPath), false);
    assert.equal(await pathExists(importedPaths.walletStatePath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reset uses hidden passphrase input for passphrase-wrapped entropy-retaining resets", async () => {
  const root = await mkdtemp(join(tmpdir(), "cogcoin-reset-passphrase-"));
  const paths = createTempWalletPaths(root);
  const provider = createMemoryWalletSecretProviderForTesting();
  const state = createWalletState();
  const harness = createResetRpcHarness(state);
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
      attachService: async () => ({
        rpc: {
          url: "http://127.0.0.1:8332",
          cookieFile: "/tmp/does-not-matter",
          port: 8_332,
        },
      } as never),
      rpcFactory: harness.rpcFactory,
    });

    assert.equal(result.walletAction, "retain-mnemonic");
    assert.equal(result.bitcoinDataDir.status, "not-present");
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
    assert.equal(loaded.state.managedCoreWallet.proofStatus, "ready");
    assert.equal(loaded.state.managedCoreWallet.descriptorChecksum, harness.checksum);
    assert.equal(harness.importedDescriptors.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reset can retain the mnemonic while preserving the managed Bitcoin datadir in place", async () => {
  const root = await mkdtemp(join(tmpdir(), "cogcoin-reset-retain-bitcoind-"));
  const paths = createTempWalletPaths(root);
  const provider = createMemoryWalletSecretProviderForTesting();
  const state = createWalletState();
  const harness = createResetRpcHarness(state);
  const secretReference = createWalletSecretReference(state.walletRootId);
  const snapshotPaths = resolveBootstrapPathsForTesting(paths.bitcoinDataDir);
  const bitcoinSentinelPath = join(paths.bitcoinDataDir, "sentinel.txt");
  const clientSentinelPath = join(paths.clientDataDir, "client.sqlite");
  const prompter = new ScriptedPrompter({
    visibleAnswers: ["permanently reset", "", "", ""],
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
    await mkdir(snapshotPaths.directory, { recursive: true });
    await writeFile(snapshotPaths.snapshotPath, "snapshot", "utf8");
    await writeFile(bitcoinSentinelPath, "keep", "utf8");
    await mkdir(paths.clientDataDir, { recursive: true });
    await writeFile(clientSentinelPath, "client-state", "utf8");

    const result = await resetWallet({
      dataDir: paths.bitcoinDataDir,
      provider,
      paths,
      nowUnixMs: 1_700_000_250_000,
      validateSnapshotFile: async () => {},
      prompter,
      attachService: async () => ({
        rpc: {
          url: "http://127.0.0.1:8332",
          cookieFile: "/tmp/does-not-matter",
          port: 8_332,
        },
      } as never),
      rpcFactory: harness.rpcFactory,
    });

    assert.equal(result.walletAction, "retain-mnemonic");
    assert.equal(result.bootstrapSnapshot.status, "preserved");
    assert.equal(result.bitcoinDataDir.status, "preserved");
    assert.ok(!result.removedPaths.includes(paths.dataRoot));
    assert.ok(result.removedPaths.includes(paths.clientDataDir));
    assert.equal(await readFile(bitcoinSentinelPath, "utf8"), "keep");
    await assert.rejects(() => readFile(clientSentinelPath, "utf8"), /ENOENT/);
    assert.deepEqual(prompter.prompts, [
      "Type \"permanently reset\" to continue: ",
      "Wallet reset choice ([Enter] retain base entropy, \"skip\", or \"delete wallet\"): ",
      "Delete downloaded 910000 UTXO snapshot too? [y/N]: ",
      "Delete managed Bitcoin datadir too? [y/N]: ",
    ]);
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
  const bitcoinSentinelPath = join(paths.bitcoinDataDir, "sentinel.txt");
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
    await writeFile(bitcoinSentinelPath, "keep", "utf8");

    const result = await resetWallet({
      dataDir: paths.bitcoinDataDir,
      provider,
      paths,
      nowUnixMs: 1_700_000_300_000,
      validateSnapshotFile: async () => {},
      prompter: new ScriptedPrompter({
        visibleAnswers: ["permanently reset", "skip", "", ""],
      }),
    });

    assert.equal(result.walletAction, "kept-unchanged");
    assert.equal(result.bootstrapSnapshot.status, "preserved");
    assert.equal(result.bitcoinDataDir.status, "preserved");
    assert.equal(result.stoppedProcesses.managedBitcoind, 1);
    assert.equal(await isAlive(tracked.pid), false);
    assert.equal(await isAlive(unrelated.pid), true);
    assert.ok(!result.removedPaths.includes(paths.dataRoot));
    assert.ok(result.removedPaths.includes(paths.clientDataDir));

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
    assert.equal(await readFile(bitcoinSentinelPath, "utf8"), "keep");
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

test("reset can preserve the snapshot while explicitly deleting the managed Bitcoin datadir", async () => {
  const root = await mkdtemp(join(tmpdir(), "cogcoin-reset-delete-bitcoind-"));
  const paths = createTempWalletPaths(root);
  const provider = createMemoryWalletSecretProviderForTesting();
  const state = createWalletState();
  const secretReference = createWalletSecretReference(state.walletRootId);
  const snapshotPaths = resolveBootstrapPathsForTesting(paths.bitcoinDataDir);
  const bitcoinSentinelPath = join(paths.bitcoinDataDir, "sentinel.txt");

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
    await writeFile(bitcoinSentinelPath, "delete-me", "utf8");

    const result = await resetWallet({
      dataDir: paths.bitcoinDataDir,
      provider,
      paths,
      nowUnixMs: 1_700_000_310_000,
      validateSnapshotFile: async () => {},
      prompter: new ScriptedPrompter({
        visibleAnswers: ["permanently reset", "skip", "", "yes"],
      }),
    });

    assert.equal(result.walletAction, "kept-unchanged");
    assert.equal(result.bootstrapSnapshot.status, "preserved");
    assert.equal(result.bitcoinDataDir.status, "deleted");
    assert.ok(result.removedPaths.includes(paths.dataRoot));
    assert.equal(await pathExists(snapshotPaths.snapshotPath), true);
    await assert.rejects(() => readFile(bitcoinSentinelPath, "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reset leaves an external managed Bitcoin datadir alone without asking for datadir deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "cogcoin-reset-external-bitcoind-"));
  const externalRoot = await mkdtemp(join(tmpdir(), "cogcoin-reset-external-bitcoind-data-"));
  const paths = createTempWalletPaths(root);
  const provider = createMemoryWalletSecretProviderForTesting();
  const state = createWalletState();
  const secretReference = createWalletSecretReference(state.walletRootId);
  const externalDataDir = join(externalRoot, "bitcoin");
  const snapshotPaths = resolveBootstrapPathsForTesting(externalDataDir);
  const sentinelPath = join(externalDataDir, "sentinel.txt");

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
    await writeFile(sentinelPath, "keep", "utf8");

    const prompter = new ScriptedPrompter({
      visibleAnswers: ["permanently reset", "skip", ""],
    });

    const result = await resetWallet({
      dataDir: externalDataDir,
      provider,
      paths,
      nowUnixMs: 1_700_000_320_000,
      validateSnapshotFile: async () => {},
      prompter,
    });

    assert.equal(result.walletAction, "kept-unchanged");
    assert.equal(result.bootstrapSnapshot.status, "preserved");
    assert.equal(result.bitcoinDataDir.status, "outside-reset-scope");
    assert.deepEqual(prompter.prompts, [
      "Type \"permanently reset\" to continue: ",
      "Wallet reset choice ([Enter] retain base entropy, \"skip\", or \"delete wallet\"): ",
      "Delete downloaded 910000 UTXO snapshot too? [y/N]: ",
    ]);
    assert.equal(await readFile(sentinelPath, "utf8"), "keep");
    assert.equal(await pathExists(snapshotPaths.snapshotPath), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
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
    assert.equal(preview.bitcoinDataDir.status, "within-reset-scope");
    assert.equal(preview.bitcoinDataDir.path, paths.bitcoinDataDir);
    assert.equal(preview.bitcoinDataDir.conditionalPrompt?.defaultAction, "preserve");
    assert.equal(preview.willDeleteOsSecrets, true);
    assert.ok(!preview.removedPaths.includes(paths.dataRoot));
    assert.ok(preview.removedPaths.includes(paths.clientDataDir));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
