import assert from "node:assert/strict";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { INDEXER_DAEMON_SCHEMA_VERSION, INDEXER_DAEMON_SERVICE_API_VERSION } from "../src/bitcoind/types.js";
import { resolveManagedServicePaths } from "../src/bitcoind/service-paths.js";
import {
  createMiningSuspendDetectorForTesting,
  runForegroundMining,
  runMiningLoopForTesting,
  startBackgroundMining,
  takeOverMiningRuntimeForTesting,
  throwIfMiningSuspendDetectedForTesting,
} from "../src/wallet/mining/runner.js";
import { buildMiningGenerationRequest as buildMiningGenerationRequestForTesting } from "../src/wallet/mining/candidate.js";
import { loadMiningRuntimeStatus, readMiningEvents, saveMiningRuntimeStatus } from "../src/wallet/mining/runtime-artifacts.js";
import { resolveWalletRuntimePathsForTesting, type WalletRuntimePaths } from "../src/wallet/runtime.js";
import { createMemoryWalletSecretProviderForTesting } from "../src/wallet/state/provider.js";
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

function createPrompter() {
  return {
    isInteractive: true,
    writeLine() {},
    async prompt() {
      return "";
    },
    async promptHidden() {
      return "";
    },
  };
}

function createStderrStream() {
  return {
    isTTY: false,
    columns: 80,
    write() {
      return true;
    },
  };
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

function createLoopMiningRpc(overrides: Record<string, unknown> = {}) {
  return createHealthyMiningRpc(overrides);
}

function createLoopMiningCandidate(overrides: Record<string, unknown> = {}) {
  return {
    domainId: 7,
    domainName: "cogdemo",
    localIndex: 0,
    sender: {
      localIndex: 0,
      scriptPubKeyHex: "0014" + "11".repeat(20),
      address: "bc1qfunding",
    },
    sentence: "Under the trees, a monkey helped the youth place a basket on the bike for the hamster.",
    encodedSentenceBytes: Buffer.from("candidate", "utf8"),
    bip39WordIndices: [1899, 1850, 1141, 2043, 155],
    bip39Words: ["under", "tree", "monkey", "youth", "basket"],
    canonicalBlend: 31_054_079n,
    referencedBlockHashDisplay: "11".repeat(32),
    referencedBlockHashInternal: Buffer.from("22".repeat(32), "hex"),
    targetBlockHeight: 101,
    ...overrides,
  } as any;
}

function createSynchronizedLoopReadContext(overrides: Record<string, unknown> = {}) {
  const walletScriptPubKeyHex = "0014" + "11".repeat(20);
  return createLoopReadContext({
    indexer: {
      health: "synced",
      message: null,
      status: null,
      source: "lease",
      daemonInstanceId: "daemon-1",
      snapshotSeq: "seq-100",
      openedAtUnixMs: 1,
      snapshotTip: {
        height: 100,
        blockHashHex: "11".repeat(32),
        previousHashHex: "00".repeat(32),
      },
    },
    nodeHealth: "synced",
    model: {
      walletScriptPubKeyHex,
      domains: [{
        name: "cogdemo",
        anchored: true,
        readOnly: false,
        localRelationship: "local",
        domainId: 7,
        ownerAddress: "bc1qfunding",
        ownerScriptPubKeyHex: walletScriptPubKeyHex,
      }],
    },
    snapshot: {
      daemonInstanceId: "daemon-1",
      snapshotSeq: "seq-100",
      tip: {
        height: 100,
        blockHashHex: "11".repeat(32),
        previousHashHex: "00".repeat(32),
      },
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
    ...overrides,
  });
}

async function startFakeIndexerDaemonStatusServer(
  t: TestContext,
  options: {
    dataDir: string;
    walletRootId: string;
    daemonInstanceId: string;
    snapshotSeq: string;
  },
): Promise<void> {
  const paths = resolveManagedServicePaths(options.dataDir, options.walletRootId);
  await rm(paths.indexerDaemonSocketPath, { force: true }).catch(() => undefined);

  const server = net.createServer((socket) => {
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");

      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          break;
        }

        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length === 0) {
          continue;
        }

        const request = JSON.parse(line) as { id: string; method: string };
        if (request.method !== "GetStatus") {
          socket.write(`${JSON.stringify({
            id: request.id,
            ok: false,
            error: "unsupported_method",
          })}\n`);
          continue;
        }

        socket.write(`${JSON.stringify({
          id: request.id,
          ok: true,
          result: {
            serviceApiVersion: INDEXER_DAEMON_SERVICE_API_VERSION,
            schemaVersion: INDEXER_DAEMON_SCHEMA_VERSION,
            walletRootId: options.walletRootId,
            daemonInstanceId: options.daemonInstanceId,
            binaryVersion: "1.1.4",
            buildId: "test-build",
            processId: 9_001,
            startedAtUnixMs: 1,
            state: "synced",
            heartbeatAtUnixMs: 1,
            rpcReachable: true,
            coreBestHeight: 100,
            coreBestHash: "11".repeat(32),
            appliedTipHeight: 100,
            appliedTipHash: "11".repeat(32),
            snapshotSeq: options.snapshotSeq,
            backlogBlocks: 0,
            reorgDepth: null,
            lastAppliedAtUnixMs: 1,
            activeSnapshotCount: 0,
            lastError: null,
            backgroundFollowActive: true,
            bootstrapPhase: null,
            bootstrapProgress: null,
            cogcoinSyncHeight: 100,
            cogcoinSyncTargetHeight: 100,
          },
        })}\n`);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.indexerDaemonSocketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  t.after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await rm(paths.indexerDaemonSocketPath, { force: true }).catch(() => undefined);
  });
}

function createMiningSuspendTestClock() {
  let monotonicNowMs = 0;
  let nextId = 0;
  const intervals = new Map<number, {
    intervalMs: number;
    callback: () => void;
    nextRunAtMs: number;
    active: boolean;
  }>();

  return {
    now() {
      return monotonicNowMs;
    },
    advance(ms: number, options: { runHeartbeats?: boolean } = {}) {
      const targetMs = monotonicNowMs + ms;
      if (options.runHeartbeats === false) {
        monotonicNowMs = targetMs;
        return;
      }

      while (true) {
        let nextRunAtMs = Number.POSITIVE_INFINITY;
        let nextTimerId: number | null = null;
        for (const [id, interval] of intervals.entries()) {
          if (!interval.active || interval.nextRunAtMs > targetMs || interval.nextRunAtMs >= nextRunAtMs) {
            continue;
          }

          nextRunAtMs = interval.nextRunAtMs;
          nextTimerId = id;
        }

        if (nextTimerId === null) {
          break;
        }

        monotonicNowMs = nextRunAtMs;
        const timer = intervals.get(nextTimerId)!;
        timer.nextRunAtMs += timer.intervalMs;
        timer.callback();
      }

      monotonicNowMs = targetMs;
    },
    scheduler: {
      every(intervalMs: number, callback: () => void) {
        const id = nextId += 1;
        intervals.set(id, {
          intervalMs,
          callback,
          nextRunAtMs: monotonicNowMs + intervalMs,
          active: true,
        });
        return {
          clear() {
            intervals.delete(id);
          },
        };
      },
    },
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
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-runner-mine-fg-bg");
  const paths = createRuntimePaths(homeDirectory);
  const provider = createMemoryWalletSecretProviderForTesting();
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
    provider,
    prompter: createPrompter(),
    builtInSetupEnsured: true,
    paths,
    stderr: createStderrStream(),
    runMiningLoopImpl: async () => {
      events.push("run");
    },
    saveStopSnapshotImpl: async () => {
      events.push("save-stop");
    },
    shutdownGraceMs: 1,
    sleepImpl: async () => undefined,
  });

  assert.equal(
    killLog.calls.filter((call) => call.pid === 7_001 && call.signal === "SIGTERM").length,
    1,
  );
  assert.deepEqual(events, ["run", "save-stop"]);
  const runtime = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(runtime?.runMode, "stopped");
  assert.equal(runtime?.backgroundWorkerPid, null);
});

test("buildMiningGenerationRequestForTesting attaches distinct per-domain prompts", () => {
  const request = buildMiningGenerationRequestForTesting({
    requestId: "request-1",
    targetBlockHeight: 101,
    referencedBlockHashDisplay: "11".repeat(32),
    generatedAtUnixMs: 1,
    extraPrompt: "global fallback",
    domainExtraPrompts: {
      alpha: "focus alpha",
      beta: "focus beta",
    },
    domains: [
      {
        domainId: 7,
        domainName: "alpha",
        requiredWords: ["under", "tree", "monkey", "youth", "basket"],
      },
      {
        domainId: 8,
        domainName: "beta",
        requiredWords: ["able", "breeze", "cabin", "delta", "ember"],
      },
    ],
  });

  assert.equal(request.extraPrompt, "global fallback");
  assert.deepEqual(
    request.rootDomains.map((domain) => ({
      domainName: domain.domainName,
      extraPrompt: domain.extraPrompt,
    })),
    [
      { domainName: "alpha", extraPrompt: "focus alpha" },
      { domainName: "beta", extraPrompt: "focus beta" },
    ],
  );
});

test("runMiningLoop survives a recoverable managed Bitcoin RPC failure and reaches a later healthy cycle", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-runner-loop-recovery");
  const paths = createRuntimePaths(homeDirectory);
  const provider = createMemoryWalletSecretProviderForTesting();
  const abortController = new AbortController();
  const failureMessage = "The managed Bitcoin RPC request to 127.0.0.1:49987 for getblockchaininfo failed: timeout";
  let blockchainCalls = 0;
  let sleepCalls = 0;

  await assert.doesNotReject(async () => {
    await runMiningLoopForTesting({
      dataDir: homeDirectory,
      databasePath: join(homeDirectory, "indexer.sqlite"),
      provider,
      paths,
      runMode: "foreground",
      backgroundWorkerPid: null,
      backgroundWorkerRunId: null,
      signal: abortController.signal,
      openReadContext: async () => createLoopReadContext(),
      attachService: async () => ({
        rpc: {},
        pid: 9_001,
        refreshServiceStatus: async () => ({
          serviceInstanceId: "svc-1",
          processId: 9_001,
        }),
      }) as any,
      probeService: async () => ({
        compatibility: "compatible",
        status: {
          serviceInstanceId: "svc-1",
          processId: 9_001,
        },
        error: null,
      }) as any,
      stopService: async () => {
        throw new Error("stopService should not be used for compatible retryable failures");
      },
      rpcFactory: () => createLoopMiningRpc({
        async getBlockchainInfo() {
          blockchainCalls += 1;
          if (blockchainCalls === 1) {
            throw new Error(failureMessage);
          }

          return {
            blocks: 100,
            bestblockhash: "11".repeat(32),
            initialblockdownload: false,
          };
        },
      }) as any,
      sleepImpl: async () => {
        sleepCalls += 1;
        if (sleepCalls >= 2) {
          abortController.abort();
        }
      },
    });
  });

  const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(blockchainCalls, 2);
  assert.equal(snapshot?.currentPhase, "waiting-indexer");
  assert.equal(snapshot?.lastError, null);
  assert.equal(snapshot?.note, "Mining is waiting for Bitcoin Core and the indexer to align.");
});

test("heartbeat-backed suspend detection ignores long work while heartbeats keep advancing", () => {
  const suspendClock = createMiningSuspendTestClock();
  const detector = createMiningSuspendDetectorForTesting({
    monotonicNow: () => suspendClock.now(),
    nowUnixMs: () => 100_000 + suspendClock.now(),
    scheduler: suspendClock.scheduler,
  });

  suspendClock.advance(16_000);

  assert.doesNotThrow(() => {
    throwIfMiningSuspendDetectedForTesting(detector);
  });
  detector.stop();
});

test("runMiningLoop keeps progressing through long async gate work without false system-resumed events", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-runner-loop-long-gate");
  const paths = createRuntimePaths(homeDirectory);
  const provider = createMemoryWalletSecretProviderForTesting();
  const abortController = new AbortController();
  const suspendClock = createMiningSuspendTestClock();
  const candidate = createLoopMiningCandidate();
  const databasePath = join(homeDirectory, "indexer.sqlite");
  const syncedContext = createSynchronizedLoopReadContext({
    dataDir: homeDirectory,
    databasePath,
  });
  let sleepCalls = 0;
  let gateCalls = 0;

  await startFakeIndexerDaemonStatusServer(t, {
    dataDir: homeDirectory,
    walletRootId: syncedContext.localState.state.walletRootId,
    daemonInstanceId: "daemon-1",
    snapshotSeq: "seq-100",
  });

  await assert.doesNotReject(async () => {
    await runMiningLoopForTesting({
      dataDir: homeDirectory,
      databasePath,
      provider,
      paths,
      runMode: "foreground",
      backgroundWorkerPid: null,
      backgroundWorkerRunId: null,
      signal: abortController.signal,
      openReadContext: async () => syncedContext,
      attachService: async () => ({
        rpc: {},
        pid: 9_001,
        refreshServiceStatus: async () => ({
          serviceInstanceId: "svc-1",
          processId: 9_001,
        }),
      }) as any,
      rpcFactory: () => createLoopMiningRpc({
        async getRawMempoolVerbose() {
          return {
            txids: [],
            mempool_sequence: "seq-100",
          };
        },
      }) as any,
      nowImpl: () => 100_000 + suspendClock.now(),
      sleepImpl: async () => {
        sleepCalls += 1;
        suspendClock.advance(1_000);
        if (sleepCalls >= 2) {
          abortController.abort();
        }
      },
      suspendMonotonicNowImpl: () => suspendClock.now(),
      suspendScheduler: suspendClock.scheduler,
      generateCandidatesForDomainsImpl: async () => [candidate],
      runCompetitivenessGateImpl: async () => {
        gateCalls += 1;
        suspendClock.advance(16_000);
        return {
          allowed: false,
          decision: "suppressed-top5-mempool" as const,
          sameDomainCompetitorSuppressed: false,
          competitivenessGateIndeterminate: false,
          higherRankedCompetitorDomainCount: 5,
          dedupedCompetitorDomainCount: 5,
          mempoolSequenceCacheStatus: "refreshed",
          lastMempoolSequence: "seq-100",
          candidateRank: 6,
          visibleBoardEntries: [],
        };
      },
    });
  });

  const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  const events = await readMiningEvents({
    eventsPath: paths.miningEventsPath,
    all: true,
  });

  assert.equal(gateCalls, 1);
  assert.equal(events.filter((event) => event.kind === "candidate-selected").length, 1);
  assert.equal(events.filter((event) => event.kind === "publish-skipped-top5-mempool").length, 1);
  assert.equal(events.filter((event) => event.kind === "system-resumed").length, 0);
  assert.equal(snapshot?.lastSuspendDetectedAtUnixMs, null);
});

test("runMiningLoop still emits system-resumed after a real heartbeat gap", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-runner-loop-resume");
  const paths = createRuntimePaths(homeDirectory);
  const provider = createMemoryWalletSecretProviderForTesting();
  const abortController = new AbortController();
  const suspendClock = createMiningSuspendTestClock();
  let sleepCalls = 0;

  await assert.doesNotReject(async () => {
    await runMiningLoopForTesting({
      dataDir: homeDirectory,
      databasePath: join(homeDirectory, "indexer.sqlite"),
      provider,
      paths,
      runMode: "foreground",
      backgroundWorkerPid: null,
      backgroundWorkerRunId: null,
      signal: abortController.signal,
      openReadContext: async () => createLoopReadContext(),
      attachService: async () => ({
        rpc: {},
        pid: 9_001,
        refreshServiceStatus: async () => ({
          serviceInstanceId: "svc-1",
          processId: 9_001,
        }),
      }) as any,
      rpcFactory: () => createLoopMiningRpc() as any,
      nowImpl: () => 100_000 + suspendClock.now(),
      sleepImpl: async () => {
        sleepCalls += 1;
        if (sleepCalls === 1) {
          suspendClock.advance(20_000, {
            runHeartbeats: false,
          });
          return;
        }

        suspendClock.advance(2_000);
        abortController.abort();
      },
      suspendMonotonicNowImpl: () => suspendClock.now(),
      suspendScheduler: suspendClock.scheduler,
    });
  });

  const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  const events = await readMiningEvents({
    eventsPath: paths.miningEventsPath,
    all: true,
  });
  const resumeEvent = events.find((event) => event.kind === "system-resumed") ?? null;

  assert.notEqual(resumeEvent, null);
  assert.equal(resumeEvent?.timestampUnixMs, 120_000);
  assert.equal(snapshot?.lastSuspendDetectedAtUnixMs, 120_000);
});

test("runForegroundMining replaces an existing foreground miner in the same runtime", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-runner-mine-fg-fg");
  const paths = createRuntimePaths(homeDirectory);
  const provider = createMemoryWalletSecretProviderForTesting();
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
    provider,
    prompter: createPrompter(),
    builtInSetupEnsured: true,
    paths,
    stderr: createStderrStream(),
    runMiningLoopImpl: async () => {
      events.push("run");
    },
    saveStopSnapshotImpl: async () => {
      events.push("save-stop");
    },
    shutdownGraceMs: 1,
    sleepImpl: async () => undefined,
  });

  assert.equal(
    killLog.calls.filter((call) => call.pid === 8_001 && call.signal === "SIGTERM").length,
    1,
  );
  assert.deepEqual(events, ["run", "save-stop"]);
  assert.equal(await pathExists(paths.miningControlLockPath), false);
});

test("runForegroundMining reuses an injected visualizer without closing it", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-runner-mine-fg-visualizer");
  const paths = createRuntimePaths(homeDirectory);
  const provider = createMemoryWalletSecretProviderForTesting();
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
    provider,
    prompter: createPrompter(),
    builtInSetupEnsured: true,
    paths,
    stderr: createStderrStream(),
    visualizer,
    runMiningLoopImpl: async (options) => {
      receivedVisualizer = options.visualizer ?? null;
      events.push("run");
    },
    saveStopSnapshotImpl: async () => {
      events.push("save-stop");
    },
  });

  assert.equal(receivedVisualizer, visualizer);
  assert.equal(closeCalls, 0);
  assert.deepEqual(events, ["run", "save-stop"]);
});

test("startBackgroundMining replaces an existing background miner and returns started true", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-runner-mine-start-bg");
  const paths = createRuntimePaths(homeDirectory);
  const provider = createMemoryWalletSecretProviderForTesting();
  const killLog = installProcessKillMock(t, {
    livePids: [9_001],
  });
  const spawned: string[][] = [];
  const healthySnapshot = createMiningRuntimeStatus({
    runMode: "background",
    backgroundWorkerPid: 4_242,
    backgroundWorkerRunId: "run-new",
    backgroundWorkerHealth: "healthy",
  });

  await saveMiningRuntimeStatus(
    paths.miningStatusPath,
    createMiningRuntimeStatus({
      runMode: "background",
      backgroundWorkerPid: 9_001,
      backgroundWorkerRunId: "run-old",
      backgroundWorkerHealth: "healthy",
    }),
  );

  const result = await startBackgroundMining({
    dataDir: homeDirectory,
    databasePath: join(homeDirectory, "indexer.sqlite"),
    provider,
    prompter: createPrompter(),
    builtInSetupEnsured: true,
    paths,
    spawnWorkerProcess: ((...args: unknown[]) => {
      spawned.push(args[1] as string[]);
      return {
        pid: 4_242,
        unref() {},
      } as any;
    }) as any,
    waitForBackgroundHealthyImpl: async () => healthySnapshot,
    shutdownGraceMs: 1,
    sleepImpl: async () => undefined,
  });

  assert.equal(result.started, true);
  assert.equal(result.snapshot?.backgroundWorkerPid, 4_242);
  assert.equal(spawned.length, 1);
  assert.equal(
    killLog.calls.filter((call) => call.pid === 9_001 && call.signal === "SIGTERM").length,
    1,
  );
});

test("startBackgroundMining replaces an existing foreground miner in the same runtime", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-runner-mine-start-fg");
  const paths = createRuntimePaths(homeDirectory);
  const provider = createMemoryWalletSecretProviderForTesting();
  const killLog = installProcessKillMock(t, {
    livePids: [9_101],
  });
  const healthySnapshot = createMiningRuntimeStatus({
    runMode: "background",
    backgroundWorkerPid: 5_151,
    backgroundWorkerRunId: "run-new",
    backgroundWorkerHealth: "healthy",
  });

  await writeJsonFile(paths.miningControlLockPath, {
    processId: 9_101,
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

  const result = await startBackgroundMining({
    dataDir: homeDirectory,
    databasePath: join(homeDirectory, "indexer.sqlite"),
    provider,
    prompter: createPrompter(),
    builtInSetupEnsured: true,
    paths,
    spawnWorkerProcess: (() => ({
      pid: 5_151,
      unref() {},
    })) as any,
    waitForBackgroundHealthyImpl: async () => healthySnapshot,
    shutdownGraceMs: 1,
    sleepImpl: async () => undefined,
  });

  assert.equal(result.started, true);
  assert.equal(result.snapshot?.backgroundWorkerPid, 5_151);
  assert.equal(
    killLog.calls.filter((call) => call.pid === 9_101 && call.signal === "SIGTERM").length,
    1,
  );
});

test("takeOverMiningRuntime clears only the current runtime, dedupes pids, and preempts before termination", async (t) => {
  const currentHomeDirectory = await createTrackedTempDirectory(t, "cogcoin-runner-takeover-current");
  const otherHomeDirectory = await createTrackedTempDirectory(t, "cogcoin-runner-takeover-other");
  const currentPaths = createRuntimePaths(currentHomeDirectory);
  const otherPaths = createRuntimePaths(otherHomeDirectory);
  const killLog = installProcessKillMock(t, {
    livePids: [9_201, 9_401],
  });
  const events: string[] = [];

  await writeJsonFile(currentPaths.miningControlLockPath, {
    processId: 9_201,
    acquiredAtUnixMs: 1,
    purpose: "mine-start",
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

  const result = await takeOverMiningRuntimeForTesting({
    paths: currentPaths,
    reason: "mine-start-replace",
    clearControlLockFile: true,
    requestMiningPreemption: async () => {
      events.push("preempt");
      return {
        requestId: "replace-preempt",
        async release() {
          events.push("release");
        },
      };
    },
    shutdownGraceMs: 1,
    sleepImpl: async () => undefined,
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
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-runner-takeover-kill");
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

  const result = await takeOverMiningRuntimeForTesting({
    paths,
    reason: "mine-start-replace",
    shutdownGraceMs: 1,
    sleepImpl: async () => undefined,
  });

  assert.equal(result.replaced, true);
  assert.deepEqual(killLog.timeline, ["SIGTERM:9301", "SIGKILL:9301"]);
  assert.equal(
    killLog.calls.filter((call) => call.pid === 9_301 && call.signal === "SIGKILL").length,
    1,
  );
});
