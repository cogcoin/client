import assert from "node:assert/strict";
import test from "node:test";
import {
  access,
  constants,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { DEFAULT_SNAPSHOT_METADATA } from "../src/bitcoind/bootstrap/constants.js";
import { resolveBootstrapPathsForTesting } from "../src/bitcoind/bootstrap/paths.js";
import {
  deleteBootstrapSnapshotArtifacts,
  restoreStagedArtifacts,
  resolveRemovedRoots,
  stageArtifact,
} from "../src/wallet/reset/artifacts.js";
import {
  determineBitcoinDataDirResultStatus,
  determineSnapshotResultStatus,
  determineWalletAction,
  loadWalletForEntropyReset,
  resolveResetExecutionDecision,
} from "../src/wallet/reset/execution.js";
import { preflightReset } from "../src/wallet/reset/preflight.js";
import {
  acquireResetLocks,
  terminateTrackedProcesses,
} from "../src/wallet/reset/process-cleanup.js";
import { previewResetWallet } from "../src/wallet/reset/preview.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  createDefaultWalletSecretProviderForTesting,
  createWalletSecretReference,
  lockClientPassword,
} from "../src/wallet/state/provider.js";
import {
  loadWalletState,
  saveWalletState,
} from "../src/wallet/state/storage.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import {
  configureTestClientPassword,
  createScriptedPrompter,
} from "./client-password-test-helpers.js";
import { createWalletState } from "./current-model-helpers.js";

function createMissingProcessError(): NodeJS.ErrnoException {
  const error = new Error("process missing") as NodeJS.ErrnoException;
  error.code = "ESRCH";
  return error;
}

test("preflightReset discovers provider-backed wallets, legacy imported seeds, and tracked processes", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-reset-preflight");
  const paths = resolveWalletRuntimePathsForTesting({ homeDirectory, platform: "linux" });
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot: paths.stateRoot,
  });
  const state = createWalletState({
    walletRootId: "wallet-root-main",
  });
  const secretReference = createWalletSecretReference(state.walletRootId);
  const snapshotPaths = resolveBootstrapPathsForTesting(paths.bitcoinDataDir, DEFAULT_SNAPSHOT_METADATA);
  const alive = new Set([111, 222, 333]);

  await configureTestClientPassword(provider);
  t.after(async () => {
    await lockClientPassword(provider);
  });

  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 23));
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

  await mkdir(join(paths.stateRoot, "seeds", "legacy-a"), { recursive: true });
  await mkdir(join(paths.stateRoot, "seeds", "legacy-b"), { recursive: true });
  await writeFile(
    join(paths.stateRoot, "seeds", "legacy-a", "wallet-state.enc"),
    `${JSON.stringify({ secretProvider: { keyId: "wallet-state:legacy-a" } }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(paths.stateRoot, "seeds", "legacy-b", "wallet-init-pending.enc"),
    `${JSON.stringify({ secretProvider: { keyId: "wallet-state:legacy-b" } }, null, 2)}\n`,
    "utf8",
  );

  await mkdir(dirname(snapshotPaths.partialSnapshotPath), { recursive: true });
  await writeFile(snapshotPaths.partialSnapshotPath, "partial snapshot", "utf8");

  await mkdir(join(paths.runtimeRoot, "svc-a"), { recursive: true });
  await mkdir(join(paths.runtimeRoot, "svc-b"), { recursive: true });
  await mkdir(join(paths.indexerRoot, "svc-index"), { recursive: true });
  await mkdir(dirname(paths.miningStatusPath), { recursive: true });
  await writeFile(
    join(paths.runtimeRoot, "svc-a", "bitcoind-status.json"),
    `${JSON.stringify({ processId: 111 }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(paths.runtimeRoot, "svc-b", "bitcoind-status.json"),
    `${JSON.stringify({ processId: 111 }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(paths.indexerRoot, "svc-index", "status.json"),
    `${JSON.stringify({ processId: 222 }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    paths.miningStatusPath,
    `${JSON.stringify({ backgroundWorkerPid: 333 }, null, 2)}\n`,
    "utf8",
  );

  const preflight = await preflightReset({
    dataDir: paths.bitcoinDataDir,
    paths,
    provider,
    processCleanupDeps: {
      processKill: ((pid: number, signal?: NodeJS.Signals | number) => {
        if (signal === 0 && alive.has(pid)) {
          return true;
        }

        throw createMissingProcessError();
      }) as typeof process.kill,
    },
  });

  assert.equal(preflight.wallet.present, true);
  assert.equal(preflight.wallet.mode, "provider-backed");
  assert.equal(preflight.wallet.envelopeSource, "primary");
  assert.equal(preflight.wallet.secretProviderKeyId, secretReference.keyId);
  assert.deepEqual(preflight.wallet.importedSeedSecretProviderKeyIds, [
    "wallet-state:legacy-a",
    "wallet-state:legacy-b",
  ]);
  assert.equal(preflight.snapshot.status, "invalid");
  assert.equal(preflight.bitcoinDataDir.status, "within-reset-scope");
  assert.deepEqual(
    preflight.trackedProcesses,
    [
      { kind: "managed-bitcoind", pid: 111 },
      { kind: "indexer-daemon", pid: 222 },
      { kind: "background-mining", pid: 333 },
    ],
  );
  assert.deepEqual(preflight.trackedProcessKinds, [
    "managed-bitcoind",
    "indexer-daemon",
    "background-mining",
  ]);
  assert.deepEqual(preflight.serviceLockPaths, [
    join(paths.runtimeRoot, "svc-a", "bitcoind.lock"),
    join(paths.runtimeRoot, "svc-b", "bitcoind.lock"),
    join(paths.runtimeRoot, "svc-index", "indexer-daemon.lock"),
  ]);
});

test("previewResetWallet preserves the managed Bitcoin datadir when a valid snapshot exists", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-reset-preview");
  const paths = resolveWalletRuntimePathsForTesting({ homeDirectory, platform: "linux" });
  const snapshotPaths = resolveBootstrapPathsForTesting(paths.bitcoinDataDir, DEFAULT_SNAPSHOT_METADATA);

  await mkdir(dirname(snapshotPaths.snapshotPath), { recursive: true });
  await writeFile(snapshotPaths.snapshotPath, "valid snapshot placeholder", "utf8");

  const preview = await previewResetWallet({
    dataDir: paths.bitcoinDataDir,
    paths,
    validateSnapshotFile: async () => undefined,
  });

  assert.equal(preview.bootstrapSnapshot.status, "valid");
  assert.equal(preview.bootstrapSnapshot.defaultAction, "preserve");
  assert.equal(preview.bitcoinDataDir.status, "within-reset-scope");
  assert.deepEqual(preview.bitcoinDataDir.conditionalPrompt, {
    prompt: "Delete managed Bitcoin datadir too? [y/N]: ",
    defaultAction: "preserve",
    acceptedInputs: ["", "n", "no", "y", "yes"],
  });
  assert.deepEqual(preview.removedPaths, resolveRemovedRoots(paths, {
    preserveBitcoinDataDir: true,
  }));
});

test("terminateTrackedProcesses escalates from TERM to KILL and reports stopped kinds", async (t) => {
  const alive = new Set([11, 22]);
  const nonProbeSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const originalDateNow = Date.now;
  let now = 0;

  Date.now = () => {
    now += 10_000;
    return now;
  };
  t.after(() => {
    Date.now = originalDateNow;
  });

  const stopped = await terminateTrackedProcesses([
    { kind: "managed-bitcoind", pid: 11 },
    { kind: "background-mining", pid: 22 },
  ], {
    processKill: ((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        if (alive.has(pid)) {
          return true;
        }

        throw createMissingProcessError();
      }

      if (signal === "SIGTERM") {
        nonProbeSignals.push({ pid, signal });
        if (pid === 11) {
          alive.delete(pid);
        }
        return true;
      }

      if (signal === "SIGKILL") {
        nonProbeSignals.push({ pid, signal });
        alive.delete(pid);
        return true;
      }

      return true;
    }) as typeof process.kill,
    sleep: async () => undefined,
  });

  assert.deepEqual(nonProbeSignals, [
    { pid: 11, signal: "SIGTERM" },
    { pid: 22, signal: "SIGTERM" },
    { pid: 22, signal: "SIGKILL" },
  ]);
  assert.deepEqual(stopped, {
    managedBitcoind: 1,
    indexerDaemon: 0,
    backgroundMining: 1,
    survivors: 0,
  });
});

test("acquireResetLocks acquires wallet-reset locks in order and releases prior handles on failure", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-reset-locks");
  const paths = resolveWalletRuntimePathsForTesting({ homeDirectory, platform: "linux" });
  const acquired: string[] = [];
  const released: string[] = [];

  await assert.rejects(
    () => acquireResetLocks(paths, ["/tmp/service-a.lock", "/tmp/service-b.lock"], {
      acquireLock: async (path) => {
        acquired.push(path);

        if (path === "/tmp/service-a.lock") {
          throw new Error("lock_busy");
        }

        return {
          release: async () => {
            released.push(path);
          },
        } as never;
      },
    }),
    /lock_busy/,
  );

  assert.deepEqual(acquired, [
    paths.walletControlLockPath,
    paths.miningControlLockPath,
    "/tmp/service-a.lock",
  ]);
  assert.deepEqual(new Set(released), new Set([
    paths.walletControlLockPath,
    paths.miningControlLockPath,
  ]));
});

test("reset artifacts support EXDEV staging/restore and bootstrap snapshot cleanup", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-reset-artifacts");
  const paths = resolveWalletRuntimePathsForTesting({ homeDirectory, platform: "linux" });
  const stagingRoot = join(homeDirectory, "staging");
  const sourcePath = join(homeDirectory, "wallet-state.enc");
  const snapshotPaths = resolveBootstrapPathsForTesting(paths.bitcoinDataDir, DEFAULT_SNAPSHOT_METADATA);
  const artifactDeps = {
    access,
    copyFile,
    mkdir,
    readFile,
    rename: async () => {
      const error = new Error("cross-device") as NodeJS.ErrnoException;
      error.code = "EXDEV";
      throw error;
    },
    remove: rm,
  };

  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, "wallet state", "utf8");

  const staged = await stageArtifact(
    sourcePath,
    stagingRoot,
    "wallet/wallet-state.enc",
    artifactDeps,
  );

  if (staged === null) {
    throw new Error("expected staged artifact");
  }
  await assert.rejects(() => access(sourcePath, constants.F_OK), /ENOENT/);
  assert.equal(await readFile(staged.stagedPath, "utf8"), "wallet state");

  await restoreStagedArtifacts([staged], artifactDeps);
  assert.equal(await readFile(sourcePath, "utf8"), "wallet state");

  await mkdir(dirname(snapshotPaths.snapshotPath), { recursive: true });
  await writeFile(snapshotPaths.snapshotPath, "snapshot", "utf8");
  await writeFile(snapshotPaths.partialSnapshotPath, "partial", "utf8");
  await writeFile(snapshotPaths.statePath, "state", "utf8");
  await writeFile(snapshotPaths.quoteStatePath, "quote", "utf8");

  await deleteBootstrapSnapshotArtifacts(paths.bitcoinDataDir);

  await assert.rejects(() => access(snapshotPaths.snapshotPath, constants.F_OK), /ENOENT/);
  await assert.rejects(() => access(snapshotPaths.partialSnapshotPath, constants.F_OK), /ENOENT/);
  await assert.rejects(() => access(snapshotPaths.statePath, constants.F_OK), /ENOENT/);
  await assert.rejects(() => access(snapshotPaths.quoteStatePath, constants.F_OK), /ENOENT/);
});

test("reset execution helpers keep the reset decision and entropy-reset loading behavior intact", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-reset-execution");
  const paths = resolveWalletRuntimePathsForTesting({ homeDirectory, platform: "linux" });
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot: paths.stateRoot,
  });
  const state = createWalletState({
    walletRootId: "wallet-root-execution",
  });
  const secretReference = createWalletSecretReference(state.walletRootId);

  await configureTestClientPassword(provider);
  t.after(async () => {
    await lockClientPassword(provider);
  });

  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 99));
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

  const preflight = await preflightReset({
    dataDir: paths.bitcoinDataDir,
    paths,
    provider,
  });
  const loadedWallet = await loadWalletForEntropyReset({
    wallet: preflight.wallet,
    paths,
    provider,
  });
  const decision = await resolveResetExecutionDecision({
    preflight: {
      ...preflight,
      snapshot: {
        ...preflight.snapshot,
        status: "valid",
        shouldPrompt: true,
      },
      bitcoinDataDir: {
        ...preflight.bitcoinDataDir,
        status: "within-reset-scope",
        shouldPrompt: true,
      },
    },
    provider,
    prompter: createScriptedPrompter(["permanently reset", "skip", "n", "yes"]),
    paths,
  });
  const loadedFromDisk = await loadWalletState(
    {
      primaryPath: paths.walletStatePath,
      backupPath: paths.walletStateBackupPath,
    },
    {
      provider,
    },
  );

  assert.equal(loadedWallet.loaded.state.walletRootId, state.walletRootId);
  assert.equal(loadedWallet.access.kind, "provider");
  assert.equal(loadedWallet.access.provider, provider);
  assert.equal(loadedFromDisk.state.walletRootId, state.walletRootId);
  assert.deepEqual(decision, {
    walletChoice: "skip",
    deleteSnapshot: false,
    deleteBitcoinDataDir: true,
    loadedWalletForEntropyReset: null,
  });
  assert.equal(determineWalletAction(true, "skip"), "kept-unchanged");
  assert.equal(determineSnapshotResultStatus({
    snapshotStatus: "invalid",
    deleteSnapshot: false,
  }), "invalid-removed");
  assert.equal(determineBitcoinDataDirResultStatus({
    bitcoinDataDirStatus: "within-reset-scope",
    deleteSnapshot: false,
    deleteBitcoinDataDir: true,
  }), "deleted");
});
