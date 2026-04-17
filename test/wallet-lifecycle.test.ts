import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  INDEXER_DAEMON_SCHEMA_VERSION,
  INDEXER_DAEMON_SERVICE_API_VERSION,
} from "../src/bitcoind/types.js";
import { deriveWalletMaterialFromMnemonic } from "../src/wallet/material.js";
import { loadMiningRuntimeStatus, saveMiningRuntimeStatus } from "../src/wallet/mining/runtime-artifacts.js";
import { inspectWalletLocalState } from "../src/wallet/read/index.js";
import { repairWallet } from "../src/wallet/lifecycle.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  createMemoryWalletSecretProviderForTesting,
  createDefaultWalletSecretProviderForTesting,
  createWalletSecretReference,
  lockClientPassword,
} from "../src/wallet/state/provider.js";
import { loadWalletState, saveWalletState } from "../src/wallet/state/storage.js";
import type { WalletStateV1 } from "../src/wallet/types.js";
import { createMiningRuntimeStatus, createMiningState, createWalletState } from "./current-model-helpers.js";
import { configureTestClientPassword } from "./client-password-test-helpers.js";

function createRepairWalletState(overrides: {
  walletRootId?: string;
  miningState?: Partial<WalletStateV1["miningState"]>;
} = {}): WalletStateV1 {
  const material = deriveWalletMaterialFromMnemonic(`${"abandon ".repeat(23)}art`);
  const walletRootId = overrides.walletRootId ?? "wallet-root";

  return {
    schemaVersion: 5,
    stateRevision: 1,
    lastWrittenAtUnixMs: 1,
    walletRootId,
    network: "mainnet",
    localScriptPubKeyHexes: [material.funding.scriptPubKeyHex],
    mnemonic: {
      phrase: material.mnemonic.phrase,
      language: material.mnemonic.language,
    },
    keys: {
      ...material.keys,
    },
    descriptor: {
      ...material.descriptor,
    },
    funding: {
      ...material.funding,
    },
    walletBirthTime: 123,
    managedCoreWallet: {
      walletName: `cogcoin-${walletRootId}`,
      internalPassphrase: "repair-passphrase",
      descriptorChecksum: null,
      walletAddress: material.funding.address,
      walletScriptPubKeyHex: material.funding.scriptPubKeyHex,
      proofStatus: "ready",
      lastImportedAtUnixMs: null,
      lastVerifiedAtUnixMs: null,
    },
    domains: [],
    miningState: createMiningState(overrides.miningState),
    pendingMutations: [],
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createFakeIndexerDaemon(walletRootId: string) {
  const handle = {
    token: "snapshot-token",
    expiresAtUnixMs: 10_000,
    serviceApiVersion: INDEXER_DAEMON_SERVICE_API_VERSION,
    binaryVersion: "test-binary",
    buildId: "build-1",
    walletRootId,
    daemonInstanceId: "daemon-after",
    schemaVersion: INDEXER_DAEMON_SCHEMA_VERSION,
    processId: 77_777,
    startedAtUnixMs: 1,
    state: "synced",
    heartbeatAtUnixMs: 5_000,
    rpcReachable: true,
    coreBestHeight: 10,
    coreBestHash: "ab".repeat(32),
    appliedTipHeight: 10,
    appliedTipHash: "cd".repeat(32),
    snapshotSeq: "seq-1",
    backlogBlocks: 0,
    reorgDepth: 0,
    lastAppliedAtUnixMs: 4_000,
    activeSnapshotCount: 1,
    lastError: null,
    tipHeight: 10,
    tipHash: "cd".repeat(32),
    openedAtUnixMs: 4_500,
  } as const;

  return {
    async getStatus() {
      return {
        serviceApiVersion: INDEXER_DAEMON_SERVICE_API_VERSION,
        binaryVersion: "test-binary",
        buildId: "build-1",
        updatedAtUnixMs: 5_000,
        walletRootId,
        daemonInstanceId: "daemon-after",
        schemaVersion: INDEXER_DAEMON_SCHEMA_VERSION,
        state: "synced",
        processId: 77_777,
        startedAtUnixMs: 1,
        heartbeatAtUnixMs: 5_000,
        ipcReady: true,
        rpcReachable: true,
        coreBestHeight: 10,
        coreBestHash: "ab".repeat(32),
        appliedTipHeight: 10,
        appliedTipHash: "cd".repeat(32),
        snapshotSeq: "seq-1",
        backlogBlocks: 0,
        reorgDepth: 0,
        lastAppliedAtUnixMs: 4_000,
        activeSnapshotCount: 0,
        lastError: null,
      };
    },
    async openSnapshot() {
      return handle;
    },
    async readSnapshot(token: string) {
      assert.equal(token, handle.token);
      return {
        token: handle.token,
        stateBase64: "",
        serviceApiVersion: INDEXER_DAEMON_SERVICE_API_VERSION,
        schemaVersion: INDEXER_DAEMON_SCHEMA_VERSION,
        walletRootId,
        daemonInstanceId: handle.daemonInstanceId,
        processId: handle.processId,
        startedAtUnixMs: handle.startedAtUnixMs,
        snapshotSeq: handle.snapshotSeq,
        tipHeight: handle.tipHeight,
        tipHash: handle.tipHash,
        openedAtUnixMs: handle.openedAtUnixMs,
        tip: {
          height: 10,
          blockHashHex: handle.tipHash,
          previousHashHex: "ef".repeat(32),
          stateHashHex: "12".repeat(32),
        },
        expiresAtUnixMs: handle.expiresAtUnixMs,
      };
    },
    async closeSnapshot() {},
    async pauseBackgroundFollow() {},
    async resumeBackgroundFollow() {},
    async close() {},
  };
}

function createRepairDependencies(state: WalletStateV1) {
  const normalizedPublicDescriptor = state.descriptor.publicExternal.replace(/#[A-Za-z0-9]+$/, "");

  return {
    assumeYes: true,
    probeBitcoindService: async () => ({
      compatibility: "unreachable",
      status: null,
      error: null,
    }) as any,
    attachService: async () => ({
      rpc: {} as any,
      refreshServiceStatus: async () => ({ state: "ready" }),
      stop: async () => undefined,
    }) as any,
    rpcFactory: () => ({
      getDescriptorInfo: async (descriptor: string) => ({
        descriptor,
        checksum: "abcd1234",
      }),
      createWallet: async () => ({}),
      walletPassphrase: async () => null,
      importDescriptors: async () => [{ success: true }],
      walletLock: async () => null,
      listUnspent: async () => [],
      getWalletInfo: async () => ({
        walletname: state.managedCoreWallet.walletName,
        private_keys_enabled: false,
        descriptors: true,
      }),
      loadWallet: async () => ({
        name: state.managedCoreWallet.walletName,
        warning: "",
      }),
      unloadWallet: async () => null,
      listWallets: async () => [state.managedCoreWallet.walletName],
      listDescriptors: async () => ({
        descriptors: [{ desc: `${normalizedPublicDescriptor}#abcd1234` }],
      }),
      deriveAddresses: async () => [state.funding.address],
      getBlockchainInfo: async () => ({
        blocks: 10,
        headers: 10,
      }),
    }) as any,
    probeIndexerDaemon: async () => ({
      compatibility: "unreachable",
      status: null,
      client: null,
      error: null,
    }) as any,
    attachIndexerDaemon: async () => createFakeIndexerDaemon(state.walletRootId) as any,
  };
}

function installProcessKillMock(t: TestContext, livePids: readonly number[]) {
  const originalKill = process.kill;
  const alive = new Set(livePids);
  const calls: Array<{ pid: number; signal: number | NodeJS.Signals | undefined }> = [];

  (process as typeof process & {
    kill: typeof process.kill;
  }).kill = ((pid: number, signal?: number | NodeJS.Signals) => {
    calls.push({ pid, signal });

    if (pid === process.pid) {
      return true;
    }

    if (!alive.has(pid)) {
      const error = Object.assign(new Error("process not found"), {
        code: "ESRCH",
      });
      throw error;
    }

    if (signal === undefined || signal === 0) {
      return true;
    }

    if (signal === "SIGTERM" || signal === "SIGKILL") {
      alive.delete(pid);
      return true;
    }

    return true;
  }) as typeof process.kill;

  t.after(() => {
    (process as typeof process & {
      kill: typeof process.kill;
    }).kill = originalKill;
  });

  return {
    calls,
  };
}

async function createRepairFixture(t: TestContext, options: {
  walletState?: WalletStateV1;
} = {}) {
  const homeDirectory = await mkdtemp(join(tmpdir(), "cogcoin-wallet-repair-"));
  const paths = resolveWalletRuntimePathsForTesting({ homeDirectory, platform: "linux" });
  const provider = createMemoryWalletSecretProviderForTesting();
  const state = options.walletState ?? createRepairWalletState();
  const secretReference = createWalletSecretReference(state.walletRootId);

  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 47));
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

  return {
    databasePath: join(homeDirectory, "indexer.sqlite"),
    dataDir: homeDirectory,
    paths,
    provider,
    state,
  };
}

test("provider-backed Linux local-file wallets load after client password setup", async (t) => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "cogcoin-wallet-lifecycle-linux-"));
  const paths = resolveWalletRuntimePathsForTesting({ homeDirectory, platform: "linux" });
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot: paths.stateRoot,
  });
  const secretReference = createWalletSecretReference("wallet-root");

  await configureTestClientPassword(provider);
  t.after(async () => {
    await lockClientPassword(provider);
  });
  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 47));
  await saveWalletState(
    {
      primaryPath: paths.walletStatePath,
      backupPath: paths.walletStateBackupPath,
    },
    createWalletState(),
    {
      provider,
      secretReference,
    },
  );

  const status = await inspectWalletLocalState({
    paths,
    secretProvider: provider,
  });

  assert.equal(status.availability, "ready");
  assert.equal(status.state?.walletRootId, "wallet-root");
  assert.equal(status.source, "primary");
  assert.equal(status.message, null);
});

test("repair kills recorded background mining and clears mining control artifacts", async (t) => {
  const walletState = createRepairWalletState({
    miningState: {
      runMode: "background",
      state: "live",
    },
  });
  const fixture = await createRepairFixture(t, {
    walletState,
  });
  const killLog = installProcessKillMock(t, [4_111]);

  await writeJsonFile(fixture.paths.miningControlLockPath, {
    processId: 4_111,
    acquiredAtUnixMs: 1,
    purpose: "mine-foreground",
    walletRootId: fixture.state.walletRootId,
  });
  await writeJsonFile(join(fixture.paths.miningRoot, "generation-request.json"), {
    schemaVersion: 1,
    requestId: "repair-1",
    requestedAtUnixMs: 1,
    reason: "wallet-repair",
  });
  await saveMiningRuntimeStatus(
    fixture.paths.miningStatusPath,
    createMiningRuntimeStatus({
      runMode: "background",
      backgroundWorkerPid: 4_111,
      backgroundWorkerRunId: "run-1",
      backgroundWorkerHeartbeatAtUnixMs: 1,
      backgroundWorkerHealth: "healthy",
      currentPhase: "generating",
      miningState: "live",
      note: "background mining running",
    }),
  );

  const result = await repairWallet({
    dataDir: fixture.dataDir,
    databasePath: fixture.databasePath,
    provider: fixture.provider,
    paths: fixture.paths,
    ...createRepairDependencies(fixture.state),
  });

  assert.equal(result.miningPreRepairRunMode, "background");
  assert.equal(
    killLog.calls.filter((call) => call.pid === 4_111 && call.signal === "SIGTERM").length,
    1,
  );
  assert.equal(await pathExists(fixture.paths.miningControlLockPath), false);
  assert.equal(await pathExists(join(fixture.paths.miningRoot, "generation-request.json")), false);
  const runtime = await loadMiningRuntimeStatus(fixture.paths.miningStatusPath);
  assert.equal(runtime?.runMode, "stopped");
  assert.equal(runtime?.backgroundWorkerPid, null);
  assert.equal(runtime?.backgroundWorkerRunId, null);
  assert.equal(runtime?.backgroundWorkerHeartbeatAtUnixMs, null);
  assert.equal(runtime?.note, "Background mining stopped for wallet repair.");

  const saved = await loadWalletState(
    {
      primaryPath: fixture.paths.walletStatePath,
      backupPath: fixture.paths.walletStateBackupPath,
    },
    {
      provider: fixture.provider,
    },
  );
  assert.equal(saved.state.miningState.runMode, "stopped");
});

test("repair kills a foreground mining lock owner without using mining preemption", async (t) => {
  const fixture = await createRepairFixture(t);
  const killLog = installProcessKillMock(t, [5_222]);
  let preemptionCalled = false;

  await writeJsonFile(fixture.paths.miningControlLockPath, {
    processId: 5_222,
    acquiredAtUnixMs: 1,
    purpose: "mine-foreground",
    walletRootId: fixture.state.walletRootId,
  });

  const result = await repairWallet({
    dataDir: fixture.dataDir,
    databasePath: fixture.databasePath,
    provider: fixture.provider,
    paths: fixture.paths,
    requestMiningPreemption: async () => {
      preemptionCalled = true;
      throw new Error("mining_preemption_timeout");
    },
    ...createRepairDependencies(fixture.state),
  });

  assert.equal(preemptionCalled, false);
  assert.equal(result.miningPreRepairRunMode, "foreground");
  assert.equal(
    killLog.calls.filter((call) => call.pid === 5_222 && call.signal === "SIGTERM").length,
    1,
  );
  assert.equal(await pathExists(fixture.paths.miningControlLockPath), false);
  const runtime = await loadMiningRuntimeStatus(fixture.paths.miningStatusPath);
  assert.equal(runtime?.runMode, "stopped");
  assert.equal(runtime?.backgroundWorkerPid, null);
});

test("repair kills the generation activity owner when present", async (t) => {
  const fixture = await createRepairFixture(t);
  const killLog = installProcessKillMock(t, [6_333]);

  await writeJsonFile(join(fixture.paths.miningRoot, "generation-activity.json"), {
    schemaVersion: 1,
    generationActive: true,
    generationOwnerPid: 6_333,
    runId: "run-2",
    generationStartedAtUnixMs: 1,
    generationEndedAtUnixMs: null,
    acknowledgedRequestId: null,
    updatedAtUnixMs: 1,
  });

  const result = await repairWallet({
    dataDir: fixture.dataDir,
    databasePath: fixture.databasePath,
    provider: fixture.provider,
    paths: fixture.paths,
    ...createRepairDependencies(fixture.state),
  });

  assert.equal(result.miningPreRepairRunMode, "foreground");
  assert.equal(
    killLog.calls.filter((call) => call.pid === 6_333 && call.signal === "SIGTERM").length,
    1,
  );
  assert.equal(await pathExists(join(fixture.paths.miningRoot, "generation-activity.json")), false);
});

test("repair dedupes duplicate mining owner pids before terminating", async (t) => {
  const walletState = createRepairWalletState({
    miningState: {
      runMode: "background",
      state: "live",
    },
  });
  const fixture = await createRepairFixture(t, {
    walletState,
  });
  const killLog = installProcessKillMock(t, [9_555]);

  await writeJsonFile(fixture.paths.miningControlLockPath, {
    processId: 9_555,
    acquiredAtUnixMs: 1,
    purpose: "mine-foreground",
    walletRootId: fixture.state.walletRootId,
  });
  await writeJsonFile(join(fixture.paths.miningRoot, "generation-activity.json"), {
    schemaVersion: 1,
    generationActive: true,
    generationOwnerPid: 9_555,
    runId: "run-3",
    generationStartedAtUnixMs: 1,
    generationEndedAtUnixMs: null,
    acknowledgedRequestId: null,
    updatedAtUnixMs: 1,
  });
  await saveMiningRuntimeStatus(
    fixture.paths.miningStatusPath,
    createMiningRuntimeStatus({
      runMode: "background",
      backgroundWorkerPid: 9_555,
      backgroundWorkerRunId: "run-3",
      backgroundWorkerHeartbeatAtUnixMs: 1,
      backgroundWorkerHealth: "healthy",
      currentPhase: "generating",
      miningState: "live",
    }),
  );

  await repairWallet({
    dataDir: fixture.dataDir,
    databasePath: fixture.databasePath,
    provider: fixture.provider,
    paths: fixture.paths,
    ...createRepairDependencies(fixture.state),
  });

  assert.equal(
    killLog.calls.filter((call) => call.pid === 9_555 && call.signal === "SIGTERM").length,
    1,
  );
});

test("repair tolerates already-dead mining pids, clears artifacts, and writes a stopped runtime snapshot", async (t) => {
  const walletState = createRepairWalletState({
    miningState: {
      runMode: "background",
      state: "live",
    },
  });
  const fixture = await createRepairFixture(t, {
    walletState,
  });
  const killLog = installProcessKillMock(t, []);

  await writeJsonFile(join(fixture.paths.miningRoot, "generation-request.json"), {
    schemaVersion: 1,
    requestId: "repair-2",
    requestedAtUnixMs: 1,
    reason: "wallet-repair",
  });
  await writeJsonFile(join(fixture.paths.miningRoot, "generation-activity.json"), {
    schemaVersion: 1,
    generationActive: true,
    generationOwnerPid: 8_555,
    runId: "run-4",
    generationStartedAtUnixMs: 1,
    generationEndedAtUnixMs: null,
    acknowledgedRequestId: null,
    updatedAtUnixMs: 1,
  });
  await saveMiningRuntimeStatus(
    fixture.paths.miningStatusPath,
    createMiningRuntimeStatus({
      runMode: "background",
      backgroundWorkerPid: 7_444,
      backgroundWorkerRunId: "run-4",
      backgroundWorkerHeartbeatAtUnixMs: 1,
      backgroundWorkerHealth: "healthy",
      currentPhase: "generating",
      miningState: "live",
      note: "stale runtime",
    }),
  );

  const result = await repairWallet({
    dataDir: fixture.dataDir,
    databasePath: fixture.databasePath,
    provider: fixture.provider,
    paths: fixture.paths,
    ...createRepairDependencies(fixture.state),
  });

  assert.equal(result.miningPreRepairRunMode, "stopped");
  assert.equal(
    killLog.calls.filter((call) => call.signal === "SIGTERM" || call.signal === "SIGKILL").length,
    0,
  );
  assert.equal(await pathExists(join(fixture.paths.miningRoot, "generation-request.json")), false);
  assert.equal(await pathExists(join(fixture.paths.miningRoot, "generation-activity.json")), false);
  const runtime = await loadMiningRuntimeStatus(fixture.paths.miningStatusPath);
  assert.equal(runtime?.runMode, "stopped");
  assert.equal(runtime?.backgroundWorkerPid, null);
  assert.equal(runtime?.backgroundWorkerRunId, null);
  assert.equal(runtime?.backgroundWorkerHeartbeatAtUnixMs, null);
});
