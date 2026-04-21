import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  runForegroundMining,
  takeOverMiningRuntime,
} from "../src/wallet/mining/supervisor.js";
import { loadMiningRuntimeStatus, saveMiningRuntimeStatus } from "../src/wallet/mining/runtime-artifacts.js";
import { resolveWalletRuntimePathsForTesting, type WalletRuntimePaths } from "../src/wallet/runtime.js";
import { createMemoryWalletSecretProviderForTesting } from "../src/wallet/state/provider.js";
import {
  lockClientPasswordSessionResolved,
  readClientPasswordSessionStatusResolved,
  startClientPasswordSessionWithExpiryResolved,
} from "../src/wallet/state/client-password/session.js";
import { resolveClientPasswordContext } from "../src/wallet/state/client-password/context.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import {
  createMiningRuntimeStatus,
  createMiningState,
  createWalletReadContext,
  createWalletState,
} from "./current-model-helpers.js";
import { createHealthyMiningRpc } from "./mining-rpc-test-helpers.js";

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

function createRuntimePaths(homeDirectory: string): WalletRuntimePaths {
  return resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
}

function createLoopReadContext(overrides: Record<string, unknown> = {}) {
  const walletScriptPubKeyHex = "0014" + "11".repeat(20);
  const state = createWalletState({
    managedCoreWallet: {
      walletName: "wallet.dat",
      internalPassphrase: "passphrase",
      descriptorChecksum: "abcd1234",
      walletAddress: "bc1qfunding",
      walletScriptPubKeyHex,
      proofStatus: "ready",
      lastImportedAtUnixMs: null,
      lastVerifiedAtUnixMs: null,
    },
    domains: [{
      name: "cogdemo",
      domainId: 7,
      currentOwnerScriptPubKeyHex: walletScriptPubKeyHex,
      canonicalChainStatus: "anchored",
      foundingMessageText: null,
      birthTime: null,
    } as any],
    miningState: createMiningState({
      livePublishInMempool: false,
    }),
  });

  return {
    ...createWalletReadContext({
      localState: {
        availability: "ready",
        clientPasswordReadiness: "ready",
        unlockRequired: false,
        walletRootId: state.walletRootId,
        state,
        source: "primary",
        hasPrimaryStateFile: true,
        hasBackupStateFile: false,
        message: null,
      },
      snapshot: {
        state: {
          consensus: {
            domainIdsByName: new Map([["cogdemo", 7]]),
            domainsById: new Map([[7, {
              domainId: 7,
              name: "cogdemo",
              anchored: true,
              anchorHeight: 100,
              endpoint: null,
            }]]),
            balances: new Map(),
          },
          history: {
            foundingMessageByDomain: new Map(),
            blockWinnersByHeight: new Map(),
          },
        },
      },
      indexer: {
        health: "catching-up",
        message: "Indexer daemon is still catching up to the managed Bitcoin tip.",
        status: null,
        source: "lease",
        daemonInstanceId: "daemon-1",
        snapshotSeq: "seq-100",
        openedAtUnixMs: 1,
        snapshotTip: null,
      },
      nodeStatus: {
        chain: "mainnet",
        nodeBestHeight: 100,
        nodeBestHashHex: "11".repeat(32),
        walletReplica: {
          proofStatus: "ready",
        },
        serviceStatus: {
          serviceInstanceId: "svc-1",
          processId: 9_001,
        },
      },
      model: {
        walletScriptPubKeyHex,
        domains: [],
      },
      ...overrides,
    }),
    close: async () => undefined,
  } as any;
}

function createSupervisorRuntime(paths: WalletRuntimePaths, provider: ReturnType<typeof createMemoryWalletSecretProviderForTesting>) {
  return {
    provider,
    paths,
    openReadContext: async () => createLoopReadContext(),
    attachService: async () => ({
      rpc: {},
      pid: 9_001,
      refreshServiceStatus: async () => ({
        serviceInstanceId: "svc-1",
        processId: 9_001,
      }),
    }) as any,
    rpcFactory: () => createHealthyMiningRpc() as any,
  };
}

function installProcessKillMock(
  t: TestContext,
  options: {
    livePids?: readonly number[];
    stubbornPids?: readonly number[];
  } = {},
) {
  const originalKill = process.kill;
  const alive = new Set([...(options.livePids ?? []), ...(options.stubbornPids ?? [])]);
  const stubborn = new Set(options.stubbornPids ?? []);
  const calls: Array<{ pid: number; signal: number | NodeJS.Signals | undefined }> = [];
  const timeline: string[] = [];

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

    if (signal === "SIGTERM") {
      timeline.push(`SIGTERM:${pid}`);
      if (!stubborn.has(pid)) {
        alive.delete(pid);
      }
      return true;
    }

    if (signal === "SIGKILL") {
      timeline.push(`SIGKILL:${pid}`);
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
    timeline,
  };
}

test("runForegroundMining replaces an existing background miner in the same runtime", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-supervisor-mine-fg-bg");
  const paths = createRuntimePaths(homeDirectory);
  const provider = createMemoryWalletSecretProviderForTesting();
  const runtime = createSupervisorRuntime(paths, provider);
  const killLog = installProcessKillMock(t, {
    livePids: [7_001],
  });
  const events: string[] = [];

  await saveMiningRuntimeStatus(
    paths.miningStatusPath,
    createMiningRuntimeStatus({
      runMode: "background",
      backgroundWorkerPid: 7_001,
      backgroundWorkerRunId: "run-old",
      backgroundWorkerHealth: "healthy",
    }),
  );

  await runForegroundMining({
    dataDir: homeDirectory,
    databasePath: join(homeDirectory, "indexer.sqlite"),
    runtime,
    visualizer: {
      close() {},
    } as any,
    shutdownGraceMs: 1,
    deps: {
      runMiningLoop: async () => {
        events.push("run");
      },
      saveStopSnapshot: async () => {
        events.push("save-stop");
      },
      sleep: async () => undefined,
    },
  });

  assert.equal(
    killLog.calls.filter((call) => call.pid === 7_001 && call.signal === "SIGTERM").length,
    1,
  );
  assert.deepEqual(events, ["run", "save-stop"]);
  const runtimeStatus = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(runtimeStatus?.runMode, "stopped");
  assert.equal(runtimeStatus?.backgroundWorkerPid, null);
});

test("runForegroundMining replaces an existing foreground miner in the same runtime", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-supervisor-mine-fg-fg");
  const paths = createRuntimePaths(homeDirectory);
  const provider = createMemoryWalletSecretProviderForTesting();
  const runtime = createSupervisorRuntime(paths, provider);
  const killLog = installProcessKillMock(t, {
    livePids: [8_001],
  });
  const events: string[] = [];

  await writeJsonFile(paths.miningControlLockPath, {
    processId: 8_001,
    acquiredAtUnixMs: 1,
    purpose: "mine-foreground",
    walletRootId: "wallet-root",
  });
  await saveMiningRuntimeStatus(
    paths.miningStatusPath,
    createMiningRuntimeStatus({
      runMode: "foreground",
      note: "existing foreground miner",
    }),
  );

  await runForegroundMining({
    dataDir: homeDirectory,
    databasePath: join(homeDirectory, "indexer.sqlite"),
    runtime,
    visualizer: {
      close() {},
    } as any,
    shutdownGraceMs: 1,
    deps: {
      runMiningLoop: async () => {
        events.push("run");
      },
      saveStopSnapshot: async () => {
        events.push("save-stop");
      },
      sleep: async () => undefined,
    },
  });

  assert.equal(
    killLog.calls.filter((call) => call.pid === 8_001 && call.signal === "SIGTERM").length,
    1,
  );
  assert.deepEqual(events, ["run", "save-stop"]);
  assert.equal(await pathExists(paths.miningControlLockPath), false);
});

test("runForegroundMining reuses an injected visualizer without closing it", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-supervisor-mine-fg-visualizer");
  const paths = createRuntimePaths(homeDirectory);
  const provider = createMemoryWalletSecretProviderForTesting();
  const runtime = createSupervisorRuntime(paths, provider);
  const events: string[] = [];
  let receivedVisualizer: unknown = null;
  let closeCalls = 0;

  const visualizer = {
    close() {
      closeCalls += 1;
    },
  } as any;

  await runForegroundMining({
    dataDir: homeDirectory,
    databasePath: join(homeDirectory, "indexer.sqlite"),
    runtime,
    visualizer,
    deps: {
      runMiningLoop: async (options) => {
        receivedVisualizer = options.visualizer ?? null;
        events.push("run");
      },
      saveStopSnapshot: async () => {
        events.push("save-stop");
      },
    },
  });

  assert.equal(receivedVisualizer, visualizer);
  assert.equal(closeCalls, 0);
  assert.deepEqual(events, ["run", "save-stop"]);
});

test("runForegroundMining clears client-password sessions after a SIGTERM-driven shutdown", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-supervisor-mine-fg-sigterm");
  const paths = createRuntimePaths(homeDirectory);
  const provider = createMemoryWalletSecretProviderForTesting();
  const runtime = createSupervisorRuntime(paths, provider);
  const sessionContext = resolveClientPasswordContext({
    platform: "linux",
    stateRoot: paths.stateRoot,
    runtimeRoot: paths.runtimeRoot,
    directoryPath: join(paths.stateRoot, "secrets"),
    runtimeErrorCode: "wallet_secret_provider_linux_runtime_error",
  });
  const signalListenerCount = process.listenerCount("SIGTERM");

  t.after(async () => {
    await lockClientPasswordSessionResolved(sessionContext);
  });

  await startClientPasswordSessionWithExpiryResolved({
    ...sessionContext,
    derivedKey: Buffer.alloc(32, 43),
    unlockUntilUnixMs: null,
  });

  await runForegroundMining({
    dataDir: homeDirectory,
    databasePath: join(homeDirectory, "indexer.sqlite"),
    runtime,
    visualizer: {
      close() {},
    } as any,
    deps: {
      runMiningLoop: async (options) => {
        process.emit("SIGTERM");
        assert.equal(options.signal?.aborted, true);
      },
      saveStopSnapshot: async () => undefined,
    },
  });

  assert.equal(process.listenerCount("SIGTERM"), signalListenerCount);
  assert.deepEqual(await readClientPasswordSessionStatusResolved(sessionContext), {
    unlocked: false,
    unlockUntilUnixMs: null,
  });
});

test("takeOverMiningRuntime clears only the current runtime, dedupes pids, and preempts before termination", async (t) => {
  const currentHomeDirectory = await createTrackedTempDirectory(t, "cogcoin-supervisor-takeover-current");
  const otherHomeDirectory = await createTrackedTempDirectory(t, "cogcoin-supervisor-takeover-other");
  const currentPaths = createRuntimePaths(currentHomeDirectory);
  const otherPaths = createRuntimePaths(otherHomeDirectory);
  const killLog = installProcessKillMock(t, {
    livePids: [9_201, 9_401],
  });
  const events: string[] = [];

  await writeJsonFile(currentPaths.miningControlLockPath, {
    processId: 9_201,
    acquiredAtUnixMs: 1,
    purpose: "mine-foreground",
    walletRootId: "wallet-a",
  });
  await writeJsonFile(join(currentPaths.miningRoot, "generation-request.json"), {
    schemaVersion: 1,
    requestId: "replace-1",
    requestedAtUnixMs: 1,
    reason: "test",
  });
  await writeJsonFile(join(currentPaths.miningRoot, "generation-activity.json"), {
    schemaVersion: 1,
    generationActive: true,
    generationOwnerPid: 9_202,
    runId: "run-old",
    generationStartedAtUnixMs: 1,
    generationEndedAtUnixMs: null,
    acknowledgedRequestId: null,
    updatedAtUnixMs: 1,
  });
  await saveMiningRuntimeStatus(
    currentPaths.miningStatusPath,
    createMiningRuntimeStatus({
      walletRootId: "wallet-a",
      runMode: "background",
      backgroundWorkerPid: 9_201,
      backgroundWorkerRunId: "run-old",
      backgroundWorkerHealth: "healthy",
      currentPhase: "generating",
    }),
  );

  await writeJsonFile(otherPaths.miningControlLockPath, {
    processId: 9_401,
    acquiredAtUnixMs: 1,
    purpose: "mine-foreground",
    walletRootId: "wallet-b",
  });
  await saveMiningRuntimeStatus(
    otherPaths.miningStatusPath,
    createMiningRuntimeStatus({
      walletRootId: "wallet-b",
      runMode: "background",
      backgroundWorkerPid: 9_401,
      backgroundWorkerRunId: "run-other",
      backgroundWorkerHealth: "healthy",
    }),
  );

  const result = await takeOverMiningRuntime({
    paths: currentPaths,
    reason: "mine-foreground-replace",
    clearControlLockFile: true,
    shutdownGraceMs: 1,
    deps: {
      requestMiningPreemption: async () => {
        events.push("preempt");
        return {
          requestId: "replace-preempt",
          async release() {
            events.push("release");
          },
        };
      },
      sleep: async () => undefined,
    },
  });

  assert.equal(result.replaced, true);
  assert.deepEqual(events, ["preempt", "release"]);
  assert.deepEqual(killLog.timeline, ["SIGTERM:9201"]);
  assert.equal(
    killLog.calls.filter((call) => call.pid === 9_201 && call.signal === "SIGTERM").length,
    1,
  );
  assert.equal(
    killLog.calls.filter((call) => call.pid === 9_202 && call.signal === "SIGTERM").length,
    0,
  );
  assert.equal(
    killLog.calls.filter((call) => call.pid === 9_401 && call.signal === "SIGTERM").length,
    0,
  );
  assert.equal(await pathExists(currentPaths.miningControlLockPath), false);
  assert.equal(await pathExists(join(currentPaths.miningRoot, "generation-request.json")), false);
  assert.equal(await pathExists(join(currentPaths.miningRoot, "generation-activity.json")), false);
  const currentRuntime = await loadMiningRuntimeStatus(currentPaths.miningStatusPath);
  assert.equal(currentRuntime?.runMode, "stopped");
  assert.equal(currentRuntime?.backgroundWorkerPid, null);
  assert.equal(await pathExists(otherPaths.miningControlLockPath), true);
  const otherRuntime = await loadMiningRuntimeStatus(otherPaths.miningStatusPath);
  assert.equal(otherRuntime?.runMode, "background");
  assert.equal(otherRuntime?.backgroundWorkerPid, 9_401);
});

test("takeOverMiningRuntime uses SIGKILL only when SIGTERM does not stop the miner", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-supervisor-takeover-kill");
  const paths = createRuntimePaths(homeDirectory);
  const killLog = installProcessKillMock(t, {
    stubbornPids: [9_301],
  });

  await saveMiningRuntimeStatus(
    paths.miningStatusPath,
    createMiningRuntimeStatus({
      runMode: "background",
      backgroundWorkerPid: 9_301,
      backgroundWorkerRunId: "run-old",
      backgroundWorkerHealth: "healthy",
    }),
  );

  const result = await takeOverMiningRuntime({
    paths,
    reason: "mine-foreground-replace",
    shutdownGraceMs: 1,
    deps: {
      sleep: async () => undefined,
    },
  });

  assert.equal(result.replaced, true);
  assert.deepEqual(killLog.timeline, ["SIGTERM:9301", "SIGKILL:9301"]);
  assert.equal(
    killLog.calls.filter((call) => call.pid === 9_301 && call.signal === "SIGKILL").length,
    1,
  );
});
