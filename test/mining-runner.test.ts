import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { INDEXER_DAEMON_SCHEMA_VERSION, INDEXER_DAEMON_SERVICE_API_VERSION } from "../src/bitcoind/types.js";
import { resolveManagedServicePaths } from "../src/bitcoind/service-paths.js";
import {
  createMiningSuspendDetectorForTesting,
  runMiningLoopForTesting,
  throwIfMiningSuspendDetectedForTesting,
} from "../src/wallet/mining/runner.js";
import { buildMiningGenerationRequest as buildMiningGenerationRequestForTesting } from "../src/wallet/mining/candidate.js";
import { loadMiningRuntimeStatus, readMiningEvents } from "../src/wallet/mining/runtime-artifacts.js";
import { resolveWalletRuntimePathsForTesting, type WalletRuntimePaths } from "../src/wallet/runtime.js";
import { createMemoryWalletSecretProviderForTesting } from "../src/wallet/state/provider.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import {
  createMiningState,
  createWalletReadContext,
  createWalletState,
} from "./current-model-helpers.js";
import { createHealthyMiningRpc } from "./mining-rpc-test-helpers.js";

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
