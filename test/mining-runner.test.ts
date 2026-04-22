import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { INDEXER_DAEMON_SCHEMA_VERSION, INDEXER_DAEMON_SERVICE_API_VERSION } from "../src/bitcoind/types.js";
import { resolveManagedServicePaths } from "../src/bitcoind/service-paths.js";
import { createRpcClient } from "../src/bitcoind/node.js";
import {
  createMiningSuspendDetectorForTesting,
  runMiningLoopForTesting,
  throwIfMiningSuspendDetectedForTesting,
} from "../src/wallet/mining/runner.js";
import { buildMiningGenerationRequest as buildMiningGenerationRequestForTesting } from "../src/wallet/mining/candidate.js";
import { saveClientConfig } from "../src/wallet/mining/config.js";
import { loadMiningRuntimeStatus, readMiningEvents } from "../src/wallet/mining/runtime-artifacts.js";
import { resolveWalletRuntimePathsForTesting, type WalletRuntimePaths } from "../src/wallet/runtime.js";
import {
  createMemoryWalletSecretProviderForTesting,
  createWalletSecretReference,
} from "../src/wallet/state/provider.js";
import { createMiningStopRequestedError } from "../src/wallet/mining/stop.js";
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

async function seedBuiltInMiningConfig(options: {
  paths: WalletRuntimePaths;
  provider: ReturnType<typeof createMemoryWalletSecretProviderForTesting>;
}): Promise<void> {
  const secretReference = createWalletSecretReference("wallet-root");
  await options.provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 9));
  await saveClientConfig({
    path: options.paths.clientConfigPath,
    provider: options.provider,
    secretReference,
    config: {
      schemaVersion: 1,
      mining: {
        builtIn: {
          provider: "openai",
          apiKey: "test-api-key",
          extraPrompt: null,
          modelOverride: "gpt-5.4-mini",
          modelSelectionSource: "catalog",
          updatedAtUnixMs: 1,
        },
        domainExtraPrompts: {},
      },
    },
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
            binaryVersion: "1.1.8",
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


test("buildMiningGenerationRequestForTesting attaches distinct per-domain instructions", () => {
  const request = buildMiningGenerationRequestForTesting({
    requestId: "request-1",
    targetBlockHeight: 101,
    referencedBlockHashDisplay: "11".repeat(32),
    generatedAtUnixMs: 1,
    fallbackInstruction: "global fallback",
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

  assert.equal(request.fallbackInstruction, "global fallback");
  assert.deepEqual(
    request.rootDomains.map((domain) => ({
      domainName: domain.domainName,
      domainInstruction: domain.domainInstruction,
    })),
    [
      { domainName: "alpha", domainInstruction: "focus alpha" },
      { domainName: "beta", domainInstruction: "focus beta" },
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

test("runMiningLoop aborts sentence generation promptly on stop request", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-runner-loop-stop-generation");
  const paths = createRuntimePaths(homeDirectory);
  const provider = createMemoryWalletSecretProviderForTesting();
  const abortController = new AbortController();
  const databasePath = join(homeDirectory, "indexer.sqlite");
  const syncedContext = createSynchronizedLoopReadContext({
    dataDir: homeDirectory,
    databasePath,
  });
  let fetchCalls = 0;
  let sleepCalls = 0;
  let resolveFetchStarted: (() => void) | null = null;
  const fetchStarted = new Promise<void>((resolve) => {
    resolveFetchStarted = resolve;
  });

  await seedBuiltInMiningConfig({
    paths,
    provider,
  });
  await startFakeIndexerDaemonStatusServer(t, {
    dataDir: homeDirectory,
    walletRootId: syncedContext.localState.state.walletRootId,
    daemonInstanceId: "daemon-1",
    snapshotSeq: "seq-100",
  });

  const startedAt = Date.now();
  const runPromise = runMiningLoopForTesting({
    dataDir: homeDirectory,
    databasePath,
    provider,
    paths,
    runMode: "foreground",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    signal: abortController.signal,
    fetchImpl: async (_input, init) => {
      fetchCalls += 1;
      resolveFetchStarted?.();
      return await new Promise<Response>((_resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("provider_timeout_fallback"));
        }, 1_000);
        const signal = init?.signal;
        const handleAbort = () => {
          clearTimeout(timer);
          reject(signal?.reason instanceof Error ? signal.reason : createMiningStopRequestedError());
        };

        if (signal?.aborted) {
          handleAbort();
          return;
        }

        signal?.addEventListener("abort", handleAbort, { once: true });
      });
    },
    openReadContext: async () => syncedContext,
    attachService: async () => ({
      rpc: {},
      pid: 9_001,
      refreshServiceStatus: async () => ({
        serviceInstanceId: "svc-1",
        processId: 9_001,
      }),
    }) as any,
    rpcFactory: () => createLoopMiningRpc() as any,
    sleepImpl: async () => {
      sleepCalls += 1;
    },
  });

  await fetchStarted;
  abortController.abort(createMiningStopRequestedError());
  await assert.doesNotReject(async () => {
    await runPromise;
  });

  const elapsedMs = Date.now() - startedAt;
  assert.equal(fetchCalls, 1);
  assert.equal(sleepCalls, 0);
  assert.ok(
    elapsedMs < 400,
    `expected generation stop to finish before the fallback provider timeout, got ${elapsedMs}ms`,
  );
});

test("runMiningLoop exits on the next competitiveness yield after stop is requested", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-runner-loop-stop-gate");
  const paths = createRuntimePaths(homeDirectory);
  const provider = createMemoryWalletSecretProviderForTesting();
  const abortController = new AbortController();
  const databasePath = join(homeDirectory, "indexer.sqlite");
  const syncedContext = createSynchronizedLoopReadContext({
    dataDir: homeDirectory,
    databasePath,
  });
  const candidate = createLoopMiningCandidate();
  const txids = Array.from({ length: 30 }, (_, index) => `${(index + 1).toString(16).padStart(64, "0")}`);
  let rawTransactionCalls = 0;
  let mempoolEntryCalls = 0;
  let cooperativeYieldCalls = 0;
  let sleepCalls = 0;

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
            txids,
            mempool_sequence: "seq-100",
          };
        },
        async getRawTransaction() {
          rawTransactionCalls += 1;
          return {
            txid: "aa".repeat(32),
            vin: [],
            vout: [],
          };
        },
        async getMempoolEntry() {
          mempoolEntryCalls += 1;
          return {
            fees: {
              base: 0.00001,
              ancestor: 0.00001,
              descendant: 0.00001,
            },
            vsize: 200,
            ancestorsize: 200,
            descendantsize: 200,
          };
        },
      }) as any,
      generateCandidatesForDomainsImpl: async () => [candidate],
      cooperativeYieldEvery: 1,
      cooperativeYieldImpl: async () => {
        cooperativeYieldCalls += 1;
        abortController.abort(createMiningStopRequestedError());
      },
      sleepImpl: async () => {
        sleepCalls += 1;
      },
    });
  });

  assert.equal(cooperativeYieldCalls, 1);
  assert.equal(rawTransactionCalls, 1);
  assert.equal(mempoolEntryCalls, 1);
  assert.equal(sleepCalls, 0);
});

test("runMiningLoop aborts mining-scoped managed RPC calls before the request timeout", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-runner-loop-stop-rpc");
  const paths = createRuntimePaths(homeDirectory);
  const provider = createMemoryWalletSecretProviderForTesting();
  const abortController = new AbortController();
  const cookieFile = join(homeDirectory, ".cookie");
  let resolveBlockchainStarted: (() => void) | null = null;
  const blockchainStarted = new Promise<void>((resolve) => {
    resolveBlockchainStarted = resolve;
  });
  let sleepCalls = 0;

  await writeFile(cookieFile, "user:password\n", "utf8");

  const startedAt = Date.now();
  const runPromise = runMiningLoopForTesting({
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
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile,
        port: 18_443,
      },
      pid: 9_001,
      refreshServiceStatus: async () => ({
        serviceInstanceId: "svc-1",
        processId: 9_001,
      }),
    }) as any,
    rpcFactory: (config) => createRpcClient(config, {
      abortSignal: abortController.signal,
      requestTimeoutMs: 5_000,
      fetchImpl: async (_input, init) => {
        const body = typeof init?.body === "string" ? init.body : "";
        const request = JSON.parse(body) as { method: string };

        if (request.method === "listlockunspent") {
          return new Response(JSON.stringify({
            result: [],
            error: null,
          }), { status: 200 });
        }

        if (request.method === "lockunspent") {
          return new Response(JSON.stringify({
            result: true,
            error: null,
          }), { status: 200 });
        }

        if (request.method === "getnetworkinfo") {
          return new Response(JSON.stringify({
            result: {
              networkactive: true,
              connections_out: 8,
            },
            error: null,
          }), { status: 200 });
        }

        if (request.method === "getmempoolinfo") {
          return new Response(JSON.stringify({
            result: {
              loaded: true,
            },
            error: null,
          }), { status: 200 });
        }

        if (request.method === "getblockchaininfo") {
          resolveBlockchainStarted?.();
          return await new Promise<Response>((_resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error("rpc_timeout_fallback"));
            }, 250);
            const signal = init?.signal;
            const handleAbort = () => {
              clearTimeout(timer);
              reject(signal?.reason instanceof Error ? signal.reason : createMiningStopRequestedError());
            };

            if (signal?.aborted) {
              handleAbort();
              return;
            }

            signal?.addEventListener("abort", handleAbort, { once: true });
          });
        }

        throw new Error(`unexpected_rpc_method_${request.method}`);
      },
    }) as any,
    sleepImpl: async () => {
      sleepCalls += 1;
    },
  });

  await blockchainStarted;
  abortController.abort(createMiningStopRequestedError());
  await assert.doesNotReject(async () => {
    await runPromise;
  });

  const elapsedMs = Date.now() - startedAt;
  assert.equal(sleepCalls, 0);
  assert.ok(
    elapsedMs < 200,
    `expected mining RPC stop to finish before the fallback RPC timeout, got ${elapsedMs}ms`,
  );
});
