import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english.js";
import { displayToInternalBlockhash, getWords } from "@cogcoin/scoring";

import { INDEXER_DAEMON_SCHEMA_VERSION, INDEXER_DAEMON_SERVICE_API_VERSION } from "../src/bitcoind/types.js";
import { resolveManagedServicePaths } from "../src/bitcoind/service-paths.js";
import {
  clearMiningPublishState,
  miningPublishIsInMempool,
  miningPublishMayStillExist,
  normalizeMiningStateRecord,
} from "../src/wallet/mining/state.js";
import {
  performMiningCycleForTesting,
} from "../src/wallet/mining/runner.js";
import {
  MINING_NETWORK_SETTLE_WINDOW_MS,
  MINING_TIP_SETTLE_WINDOW_MS,
} from "../src/wallet/mining/constants.js";
import {
  cacheSelectedCandidateForTip as cacheSelectedCandidateForTipForTesting,
  createMiningRuntimeLoopState as createMiningLoopStateForTesting,
  getSelectedCandidateForTip as getSelectedCandidateForTipForTesting,
  resetMiningUiForTip as resetMiningUiForTipForTesting,
  livePublishTargetsCandidateTip,
} from "../src/wallet/mining/engine-state.js";
import {
  handleDetectedMiningRuntimeResume as handleDetectedMiningRuntimeResumeForTesting,
} from "../src/wallet/mining/lifecycle.js";
import {
  createMiningPlan as createMiningPlanForTesting,
  publishCandidate as publishCandidateForTesting,
  reconcileLiveMiningState as reconcileLiveMiningStateForTesting,
  resolveMiningConflictOutpoint as resolveMiningConflictOutpointForTesting,
} from "../src/wallet/mining/publish.js";
import {
  applyMiningRuntimeStatusOverrides,
  buildMiningRuntimeStatusSnapshot as buildMiningRuntimeStatusSnapshotForTesting,
  buildPrePublishStatusOverrides as buildPrePublishStatusOverridesForTesting,
} from "../src/wallet/mining/projection.js";
import {
  refreshMiningCandidateFromCurrentState as refreshMiningCandidateFromCurrentStateForTesting,
  resolveEligibleAnchoredRoots as resolveEligibleAnchoredRootsForTesting,
} from "../src/wallet/mining/candidate.js";
import {
  clearMiningGateCache,
  runCompetitivenessGate,
  topologicallyOrderAncestorTxidsForTesting,
} from "../src/wallet/mining/competitiveness.js";
import {
  loadMiningVisibleFollowBlockTimes as loadMiningVisibleFollowBlockTimesForTesting,
  resolveFundingDisplaySats as resolveFundingDisplaySatsForTesting,
  resolveSettledBoard as resolveSettledBoardForTesting,
  syncMiningVisualizerBlockTimes as syncMiningVisualizerBlockTimesForTesting,
} from "../src/wallet/mining/visualizer-sync.js";
import {
  loadMiningRuntimeStatus,
  readMiningEvents,
} from "../src/wallet/mining/runtime-artifacts.js";
import { createMiningEventRecord } from "../src/wallet/mining/events.js";
import { serializeMine } from "../src/wallet/cogop/index.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  closeMiningMempoolIndexSubscribersForTesting,
  clearMiningMempoolIndexCacheForTesting,
  ensureMiningMempoolRawTxSubscriber,
  hydrateMiningMempoolIndex,
  parseRawTransactionForMiningMempoolIndexTesting,
  pruneMiningMempoolIndexServicesForWallet,
  readMiningMempoolIndexStateDiagnosticsForTesting,
} from "../src/wallet/mining/mempool-index.js";
import {
  createMemoryWalletSecretProviderForTesting,
  createWalletSecretReference,
} from "../src/wallet/state/provider.js";
import { MiningProviderRequestError } from "../src/wallet/mining/sentences.js";
import type { MiningFollowVisualizerState } from "../src/wallet/mining/visualizer.js";
import {
  createMiningControlPlaneView,
  createMiningRuntimeStatus,
  createMiningState,
  createWalletReadContext,
  createWalletState,
} from "./current-model-helpers.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import { createHealthyMiningRpc } from "./mining-rpc-test-helpers.js";
import { CURRENT_CLIENT_VERSION } from "./version-helpers.js";

const MANAGED_CORE_WALLET_LOCKED_ERROR =
  "bitcoind_rpc_walletprocesspsbt_-13_Please enter the wallet passphrase with walletpassphrase first.";

test("mining event records preserve optional timing duration and metrics", () => {
  const event = createMiningEventRecord("timing-wallet-build", "Built mining wallet transaction.", {
    durationMs: 12.5,
    metrics: {
      outcome: "success",
      utxoCount: 2,
      hasConflictOutpoint: false,
      cacheStatus: null,
    },
  });

  assert.equal(event.schemaVersion, 1);
  assert.equal(event.durationMs, 12.5);
  assert.deepEqual(event.metrics, {
    outcome: "success",
    utxoCount: 2,
    hasConflictOutpoint: false,
    cacheStatus: null,
  });
});

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

  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });

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
            binaryVersion: CURRENT_CLIENT_VERSION,
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
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await rm(paths.indexerDaemonSocketPath, { force: true }).catch(() => undefined);
  });
}

function buildStatusSnapshotForTesting(
  view: any,
  overrides: Parameters<typeof applyMiningRuntimeStatusOverrides>[0]["overrides"] = {},
) {
  return applyMiningRuntimeStatusOverrides({
    runtime: view.runtime,
    provider: view.provider,
    overrides,
  });
}

function shouldKeepCurrentTipLivePublishForTesting(options: {
  liveState: Parameters<typeof livePublishTargetsCandidateTip>[0]["liveState"];
  candidate: {
    domainId: number;
    sender: {
      localIndex: number;
      scriptPubKeyHex: string;
      address: string;
    };
    encodedSentenceBytes: Uint8Array;
    referencedBlockHashDisplay: string;
    targetBlockHeight: number;
  };
}): boolean {
  return livePublishTargetsCandidateTip(options as Parameters<typeof livePublishTargetsCandidateTip>[0]);
}

test("mining runtime snapshot clears stale waiting-indexer carryover when services are healthy", async () => {
  const context = createWalletReadContext({
    nodeStatus: {
      ready: true,
      chain: "mainnet",
      nodeBestHeight: 125,
      nodeBestHashHex: "12".repeat(32),
      walletReplica: {
        proofStatus: "ready",
      },
    },
    indexer: {
      health: "synced",
      message: null,
      status: {
        state: "synced",
        heartbeatAtUnixMs: 2_000,
        updatedAtUnixMs: 2_100,
        coreBestHeight: 125,
        coreBestHash: "12".repeat(32),
        appliedTipHeight: 125,
        appliedTipHash: "12".repeat(32),
        reorgDepth: null,
        daemonInstanceId: "daemon-1",
        snapshotSeq: "seq-status",
      },
      source: "lease",
      daemonInstanceId: "daemon-1",
      snapshotSeq: "seq-lease",
      openedAtUnixMs: 1_900,
      snapshotTip: {
        height: 125,
        blockHashHex: "12".repeat(32),
        previousHashHex: "11".repeat(32),
        stateHashHex: null,
      },
    },
  }) as any;

  const snapshot = await buildMiningRuntimeStatusSnapshotForTesting({
    nowUnixMs: 3_000,
    localState: context.localState,
    bitcoind: context.bitcoind,
    nodeStatus: context.nodeStatus,
    provider: createMiningControlPlaneView().provider,
    nodeHealth: "synced",
    indexer: context.indexer,
    tipsAligned: true,
    lastEventAtUnixMs: null,
    existingRuntime: createMiningRuntimeStatus({
      currentPhase: "waiting-indexer",
      targetBlockHeight: 100,
      referencedBlockHashDisplay: "00".repeat(32),
      lastError: "stale indexer wait",
      note: "Mining is waiting for Bitcoin Core and the indexer to align.",
    }),
  });

  assert.equal(snapshot.currentPhase, "idle");
  assert.equal(snapshot.targetBlockHeight, 126);
  assert.equal(snapshot.referencedBlockHashDisplay, "12".repeat(32));
  assert.equal(snapshot.lastError, null);
  assert.equal(snapshot.note, null);
  assert.equal(snapshot.indexerTipHeight, 125);
  assert.equal(snapshot.indexerTipHash, "12".repeat(32));
  assert.equal(snapshot.indexerStatusTipHeight, 125);
  assert.equal(snapshot.indexerStatusTipHash, "12".repeat(32));
  assert.equal(snapshot.indexerObservedAtUnixMs, 2_100);
});

test("mining runtime snapshot clears stale waiting-bitcoin-network carryover when node publishing is healthy", async () => {
  const context = createWalletReadContext({
    nodeStatus: {
      ready: true,
      chain: "mainnet",
      nodeBestHeight: 130,
      nodeBestHashHex: "13".repeat(32),
      walletReplica: {
        proofStatus: "ready",
      },
    },
    indexer: {
      health: "synced",
      message: null,
      status: {
        state: "synced",
        heartbeatAtUnixMs: 4_000,
        updatedAtUnixMs: 4_100,
        coreBestHeight: 130,
        coreBestHash: "13".repeat(32),
        appliedTipHeight: 130,
        appliedTipHash: "13".repeat(32),
        reorgDepth: null,
      },
      source: "lease",
      snapshotTip: {
        height: 130,
        blockHashHex: "13".repeat(32),
        previousHashHex: "12".repeat(32),
        stateHashHex: null,
      },
    },
  }) as any;

  const snapshot = await buildMiningRuntimeStatusSnapshotForTesting({
    nowUnixMs: 5_000,
    localState: context.localState,
    bitcoind: context.bitcoind,
    nodeStatus: context.nodeStatus,
    provider: createMiningControlPlaneView().provider,
    nodeHealth: "synced",
    indexer: context.indexer,
    tipsAligned: true,
    lastEventAtUnixMs: null,
    existingRuntime: createMiningRuntimeStatus({
      currentPhase: "waiting-bitcoin-network",
      targetBlockHeight: 100,
      referencedBlockHashDisplay: "00".repeat(32),
      lastError: "stale rpc wait",
      note: "Mining is waiting for the local Bitcoin node to become publishable.",
    }),
  });

  assert.equal(snapshot.currentPhase, "idle");
  assert.equal(snapshot.targetBlockHeight, 131);
  assert.equal(snapshot.referencedBlockHashDisplay, "13".repeat(32));
  assert.equal(snapshot.lastError, null);
  assert.equal(snapshot.note, null);
});

test("mining runtime snapshot preserves active provider wait and live publish metadata", async () => {
  const walletState = createWalletState({
    miningState: createMiningState({
      currentPublishState: "in-mempool",
      currentBlockTargetHeight: 141,
      currentReferencedBlockHashDisplay: "14".repeat(32),
      currentDomain: "cogdemo",
      currentDomainId: 7,
      currentSentence: "Live sentence",
      currentScore: "123",
      currentTxid: "aa".repeat(32),
      currentWtxid: "bb".repeat(32),
      livePublishInMempool: true,
    }),
  });
  const context = createWalletReadContext({
    localState: {
      availability: "ready",
      clientPasswordReadiness: "ready",
      unlockRequired: false,
      walletRootId: walletState.walletRootId,
      state: walletState,
      source: "primary",
      hasPrimaryStateFile: true,
      hasBackupStateFile: false,
      message: null,
    },
    nodeStatus: {
      ready: true,
      chain: "mainnet",
      nodeBestHeight: 140,
      nodeBestHashHex: "14".repeat(32),
      walletReplica: {
        proofStatus: "ready",
      },
    },
  }) as any;

  const providerWaitSnapshot = await buildMiningRuntimeStatusSnapshotForTesting({
    nowUnixMs: 6_000,
    localState: {
      ...context.localState,
      state: createWalletState({
        miningState: createMiningState({
          livePublishInMempool: false,
        }),
      }),
    },
    bitcoind: context.bitcoind,
    nodeStatus: context.nodeStatus,
    provider: createMiningControlPlaneView().provider,
    nodeHealth: "synced",
    indexer: context.indexer,
    tipsAligned: true,
    lastEventAtUnixMs: null,
    existingRuntime: createMiningRuntimeStatus({
      currentPhase: "waiting-provider",
      providerState: "rate-limited",
      lastError: "rate limit",
    }),
  });
  assert.equal(providerWaitSnapshot.currentPhase, "waiting-provider");
  assert.equal(providerWaitSnapshot.providerState, "rate-limited");
  assert.equal(providerWaitSnapshot.lastError, "rate limit");

  const livePublishSnapshot = await buildMiningRuntimeStatusSnapshotForTesting({
    nowUnixMs: 7_000,
    localState: context.localState,
    bitcoind: context.bitcoind,
    nodeStatus: context.nodeStatus,
    provider: createMiningControlPlaneView().provider,
    nodeHealth: "synced",
    indexer: context.indexer,
    tipsAligned: true,
    lastEventAtUnixMs: null,
    existingRuntime: createMiningRuntimeStatus({
      currentPhase: "publishing",
      currentDomainName: "old-domain",
      currentTxid: "cc".repeat(32),
    }),
  });
  assert.equal(livePublishSnapshot.currentDomainName, "cogdemo");
  assert.equal(livePublishSnapshot.currentSentenceDisplay, "Live sentence");
  assert.equal(livePublishSnapshot.currentTxid, "aa".repeat(32));
  assert.equal(livePublishSnapshot.livePublishInMempool, true);
  assert.equal(livePublishSnapshot.targetBlockHeight, 141);
  assert.equal(livePublishSnapshot.referencedBlockHashDisplay, "14".repeat(32));
  assert.equal(livePublishSnapshot.attemptTargetBlockHeight, 141);
  assert.equal(livePublishSnapshot.attemptReferencedBlockHashDisplay, "14".repeat(32));
  assert.equal(livePublishSnapshot.livePublishTargetBlockHeight, 141);
  assert.equal(livePublishSnapshot.livePublishReferencedBlockHashDisplay, "14".repeat(32));
  assert.equal(livePublishSnapshot.livePublishTxid, "aa".repeat(32));
  assert.equal(livePublishSnapshot.livePublishStaleToCoreTip, false);
});

test("mining runtime snapshot separates stale live publish metadata from the current Core target", async () => {
  const oldHashHex = "14".repeat(32);
  const freshHashHex = "15".repeat(32);
  const walletState = createWalletState({
    miningState: createMiningState({
      state: "paused-stale",
      currentPublishState: "in-mempool",
      currentBlockTargetHeight: 141,
      currentReferencedBlockHashDisplay: oldHashHex,
      currentDomain: "cogdemo",
      currentDomainId: 7,
      currentSentence: "Old live sentence",
      currentScore: "123",
      currentTxid: "aa".repeat(32),
      currentWtxid: "bb".repeat(32),
      livePublishInMempool: true,
      currentPublishDecision: "paused-stale-mempool",
    }),
  });
  const context = createWalletReadContext({
    localState: {
      availability: "ready",
      clientPasswordReadiness: "ready",
      unlockRequired: false,
      walletRootId: walletState.walletRootId,
      state: walletState,
      source: "primary",
      hasPrimaryStateFile: true,
      hasBackupStateFile: false,
      message: null,
    },
    nodeStatus: {
      ready: true,
      chain: "mainnet",
      nodeBestHeight: 141,
      nodeBestHashHex: freshHashHex,
      walletReplica: {
        proofStatus: "ready",
      },
    },
    indexer: {
      health: "synced",
      message: null,
      status: {
        state: "synced",
        heartbeatAtUnixMs: 1,
        updatedAtUnixMs: 1,
        ipcReady: true,
        rpcReachable: true,
        coreBestHeight: 141,
        coreBestHash: freshHashHex,
        appliedTipHeight: 141,
        appliedTipHash: freshHashHex,
        reorgDepth: null,
      },
      source: "lease",
      daemonInstanceId: "daemon-1",
      snapshotSeq: "seq-141",
      openedAtUnixMs: 1,
      snapshotTip: {
        height: 141,
        blockHashHex: freshHashHex,
        previousHashHex: oldHashHex,
        stateHashHex: null,
      },
    },
  }) as any;

  const snapshot = await buildMiningRuntimeStatusSnapshotForTesting({
    nowUnixMs: 8_000,
    localState: context.localState,
    bitcoind: context.bitcoind,
    nodeStatus: context.nodeStatus,
    provider: createMiningControlPlaneView().provider,
    nodeHealth: "synced",
    indexer: context.indexer,
    tipsAligned: true,
    lastEventAtUnixMs: null,
    existingRuntime: createMiningRuntimeStatus({
      currentPhase: "publishing",
      targetBlockHeight: 141,
      referencedBlockHashDisplay: oldHashHex,
      currentTxid: "cc".repeat(32),
      livePublishInMempool: true,
    }),
  });

  assert.equal(snapshot.targetBlockHeight, 142);
  assert.equal(snapshot.referencedBlockHashDisplay, freshHashHex);
  assert.equal(snapshot.attemptTargetBlockHeight, 142);
  assert.equal(snapshot.attemptReferencedBlockHashDisplay, freshHashHex);
  assert.equal(snapshot.attemptIndexerSnapshotSeq, "seq-141");
  assert.equal(snapshot.livePublishTargetBlockHeight, 141);
  assert.equal(snapshot.livePublishReferencedBlockHashDisplay, oldHashHex);
  assert.equal(snapshot.livePublishTxid, "aa".repeat(32));
  assert.equal(snapshot.livePublishDecision, "paused-stale-mempool");
  assert.equal(snapshot.livePublishStaleToCoreTip, true);
});

async function runCompetitivenessGateForTesting(options: {
  rpc: Parameters<typeof runCompetitivenessGate>[0]["rpc"];
  readContext: Parameters<typeof runCompetitivenessGate>[0]["readContext"];
  candidate: Parameters<typeof runCompetitivenessGate>[0]["candidate"];
  currentTxid: string | null;
  assaySentencesImpl?: Parameters<typeof runCompetitivenessGate>[0]["assaySentencesImpl"];
  cooperativeYieldImpl?: Parameters<typeof runCompetitivenessGate>[0]["cooperativeYield"];
  cooperativeYieldEvery?: Parameters<typeof runCompetitivenessGate>[0]["cooperativeYieldEvery"];
  onWarmupProgress?: Parameters<typeof runCompetitivenessGate>[0]["onWarmupProgress"];
  runId?: Parameters<typeof runCompetitivenessGate>[0]["runId"];
  appendEvent?: Parameters<typeof runCompetitivenessGate>[0]["appendEvent"];
  mempoolIndex?: Parameters<typeof runCompetitivenessGate>[0]["mempoolIndex"];
}) {
  return await runCompetitivenessGate({
    rpc: options.rpc,
    readContext: options.readContext,
    candidate: options.candidate,
    currentTxid: options.currentTxid,
    assaySentencesImpl: options.assaySentencesImpl,
    cooperativeYield: options.cooperativeYieldImpl,
    cooperativeYieldEvery: options.cooperativeYieldEvery,
    onWarmupProgress: options.onWarmupProgress,
    runId: options.runId,
    appendEvent: options.appendEvent,
    mempoolIndex: options.mempoolIndex,
  });
}

test.afterEach(async () => {
  await closeMiningMempoolIndexSubscribersForTesting();
  clearMiningGateCache(null);
  clearMiningMempoolIndexCacheForTesting();
});

function resolveWordIndices(words: readonly string[]): number[] {
  return words.map((word) => {
    const index = englishWordlist.indexOf(word);
    assert.notEqual(index, -1, `missing bip39 word: ${word}`);
    return index;
  });
}

function resolveDerivedWords(previousHashDisplay: string, domainId: number): string[] {
  return [...getWords(domainId, Buffer.from(displayToInternalBlockhash(previousHashDisplay), "hex"))];
}

function createSettledBoardEntry(
  rank: number,
  domainName: string,
  sentence: string,
  requiredWords: readonly string[] = [],
) {
  return {
    rank,
    domainName,
    sentence,
    requiredWords,
  };
}

function createTestMiningCandidate(overrides: Record<string, unknown> = {}) {
  const bip39Words = ["under", "tree", "monkey", "youth", "basket"] as const;
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
    bip39WordIndices: resolveWordIndices(bip39Words),
    bip39Words,
    canonicalBlend: 1000n,
    referencedBlockHashDisplay: "11".repeat(32),
    referencedBlockHashInternal: Buffer.from("22".repeat(32), "hex"),
    targetBlockHeight: 101,
    ...overrides,
  } as any;
}

function createTestMiningCandidateProvenance(overrides: Record<string, unknown> = {}) {
  return {
    walletRootId: "wallet-root",
    walletScriptPubKeyHex: "0014" + "11".repeat(20),
    indexerDaemonInstanceId: "daemon-1",
    indexerSnapshotSeq: "seq-100",
    snapshotTipHeight: 100,
    snapshotTipHash: "11".repeat(32),
    authorizationRole: "owner",
    ...overrides,
  };
}

let gateWalletRootCounter = 0;

function createEncodedMiningSentence(fill: string): Uint8Array {
  assert.equal(fill.length, 1, "encoded mining sentence helper expects a single fill character");
  return Buffer.from(fill.repeat(60), "utf8");
}

function createGateCandidate(overrides: Record<string, unknown> = {}) {
  const sentenceFill = typeof overrides["sentenceFill"] === "string"
    ? overrides["sentenceFill"] as string
    : "l";
  const bip39Words = ["abandon", "ability", "able", "about", "above"] as const;
  const walletScriptPubKeyHex = typeof overrides["walletScriptPubKeyHex"] === "string"
    ? overrides["walletScriptPubKeyHex"] as string
    : "0014" + "11".repeat(20);

  return createTestMiningCandidate({
    domainId: 7,
    domainName: "cogdemo",
    sender: {
      localIndex: 0,
      scriptPubKeyHex: walletScriptPubKeyHex,
      address: "bc1qfunding",
    },
    sentence: sentenceFill.repeat(60),
    encodedSentenceBytes: createEncodedMiningSentence(sentenceFill),
    bip39WordIndices: resolveWordIndices(bip39Words),
    bip39Words,
    canonicalBlend: 100n,
    ...overrides,
  });
}

function createMinePayloadScriptHex(
  domainId: number,
  referencedBlockHashInternal: Uint8Array,
  sentenceFill: string,
): string {
  const payloadHex = createMinePayloadHex(domainId, referencedBlockHashInternal, sentenceFill);
  return `6a${(payloadHex.length / 2).toString(16).padStart(2, "0")}${payloadHex}`;
}

function createMinePayloadHex(
  domainId: number,
  referencedBlockHashInternal: Uint8Array,
  sentenceFill: string,
): string {
  return Buffer.from(
    serializeMine(domainId, referencedBlockHashInternal, createEncodedMiningSentence(sentenceFill)).opReturnData,
  ).toString("hex");
}

function createRawTransactionHexForIndex(scriptHex: string): string {
  return [
    "01000000",
    "01",
    "11".repeat(32),
    "00000000",
    "00",
    "ffffffff",
    "01",
    "0000000000000000",
    (scriptHex.length / 2).toString(16).padStart(2, "0"),
    scriptHex,
    "00000000",
  ].join("");
}

function createMineTransaction(options: {
  txid: string;
  domainId: number;
  senderScriptPubKeyHex: string;
  referencedBlockHashInternal: Uint8Array;
  sentenceFill: string;
  parentTxid?: string | null;
}) {
  return {
    txid: options.txid,
    vin: [{
      txid: options.parentTxid ?? "ff".repeat(32),
      prevout: {
        scriptPubKey: {
          hex: options.senderScriptPubKeyHex,
        },
      },
    }],
    vout: [{
      n: 0,
      value: 0,
      scriptPubKey: {
        hex: createMinePayloadScriptHex(
          options.domainId,
          options.referencedBlockHashInternal,
          options.sentenceFill,
        ),
      },
    }],
  };
}

function createNonCogTransaction(txid: string) {
  return {
    txid,
    vin: [{
      txid: "ff".repeat(32),
      prevout: {
        scriptPubKey: {
          hex: "0014" + "22".repeat(20),
        },
      },
    }],
    vout: [{
      n: 0,
      value: 0,
      scriptPubKey: {
        hex: "6a0161",
      },
    }],
  };
}

function createGateReadContext(options: {
  domains: Array<{
    domainId: number;
    name: string;
    ownerScriptPubKeyHex?: string;
    delegateScriptPubKeyHex?: string | null;
    minerScriptPubKeyHex?: string | null;
    anchored?: boolean;
  }>;
  walletScriptPubKeyHex?: string;
}) {
  const walletScriptPubKeyHex = options.walletScriptPubKeyHex ?? "0014" + "11".repeat(20);
  const walletRootId = `wallet-root-gate-${gateWalletRootCounter += 1}`;
  const state = createWalletState({
    walletRootId,
    funding: {
      address: "bc1qfunding",
      scriptPubKeyHex: walletScriptPubKeyHex,
    },
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
    domains: options.domains.map((domain) => ({
      name: domain.name,
      domainId: domain.domainId,
      currentOwnerScriptPubKeyHex: domain.ownerScriptPubKeyHex ?? walletScriptPubKeyHex,
      canonicalChainStatus: (domain.anchored ?? true) ? "anchored" : "unanchored",
      foundingMessageText: null,
      birthTime: null,
    }) as any),
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
        walletRootId,
        state,
        source: "primary",
        hasPrimaryStateFile: true,
        hasBackupStateFile: false,
        message: null,
      },
      model: {
        walletAddress: state.funding.address,
        walletScriptPubKeyHex,
        domains: options.domains.map((domain) => ({
          name: domain.name,
          anchored: domain.anchored ?? true,
          readOnly: false,
          localRelationship: (domain.ownerScriptPubKeyHex ?? walletScriptPubKeyHex) === walletScriptPubKeyHex
            ? "local"
            : "external",
          domainId: domain.domainId,
          ownerAddress: (domain.ownerScriptPubKeyHex ?? walletScriptPubKeyHex) === walletScriptPubKeyHex
            ? state.funding.address
            : null,
          ownerScriptPubKeyHex: domain.ownerScriptPubKeyHex ?? walletScriptPubKeyHex,
          delegateScriptPubKeyHex: domain.delegateScriptPubKeyHex ?? null,
          minerScriptPubKeyHex: domain.minerScriptPubKeyHex ?? null,
        })),
      },
      snapshot: {
        state: {
          consensus: {
            nextDomainId: Math.max(...options.domains.map((domain) => domain.domainId)) + 1,
            domainIdsByName: new Map(options.domains.map((domain) => [domain.name, domain.domainId])),
            domainsById: new Map(options.domains.map((domain) => [domain.domainId, {
              domainId: domain.domainId,
              name: domain.name,
              anchored: domain.anchored ?? true,
              anchorHeight: 100,
              ownerScriptPubKey: Buffer.from(domain.ownerScriptPubKeyHex ?? walletScriptPubKeyHex, "hex"),
              endpoint: null,
              delegate: domain.delegateScriptPubKeyHex === undefined || domain.delegateScriptPubKeyHex === null
                ? null
                : Buffer.from(domain.delegateScriptPubKeyHex, "hex"),
              miner: domain.minerScriptPubKeyHex === undefined || domain.minerScriptPubKeyHex === null
                ? null
                : Buffer.from(domain.minerScriptPubKeyHex, "hex"),
            }])),
            balances: new Map(),
          },
          history: {
            foundingMessageByDomain: new Map(),
            blockWinnersByHeight: new Map(),
          },
        },
      },
      indexer: {
        health: "synced",
        message: null,
        status: null,
        source: "lease",
        daemonInstanceId: "daemon-1",
        snapshotSeq: "seq-1",
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
      },
    }),
    close: async () => undefined,
  } as any;
}

function createGateRpc(options: {
  txids: string[];
  rawTransactions: Record<string, ReturnType<typeof createMineTransaction>>;
  mempoolEntries?: Record<string, unknown>;
  failMempoolVerbose?: boolean;
}) {
  return {
    async getRawMempoolVerbose() {
      if (options.failMempoolVerbose) {
        throw new Error("mempool unavailable");
      }

      return {
        txids: options.txids,
        mempool_sequence: "seq-1",
      };
    },
    async getRawMempoolEntries() {
      return Object.fromEntries(options.txids.map((txid) => [txid, options.mempoolEntries?.[txid] ?? {
        vsize: 200,
        fees: {
          base: 0.00001,
          ancestor: 0.00001,
          descendant: 0.00001,
        },
        ancestorsize: 200,
        descendantsize: 200,
      }]));
    },
    async getRawTransaction(txid: string) {
      const tx = options.rawTransactions[txid];
      if (tx === undefined) {
        throw new Error(`missing raw transaction ${txid}`);
      }
      return tx;
    },
    async getMempoolEntry(txid: string) {
      return options.mempoolEntries?.[txid] ?? {
        vsize: 200,
        fees: {
          base: 0.00001,
          ancestor: 0.00001,
          descendant: 0.00001,
        },
        ancestorsize: 200,
        descendantsize: 200,
      };
    },
  };
}

test("resolveEligibleAnchoredRoots includes owner, delegate, and designated miner authorizations", () => {
  const walletScriptPubKeyHex = "0014" + "11".repeat(20);
  const externalScriptPubKeyHex = "0014" + "22".repeat(20);
  const context = createGateReadContext({
    walletScriptPubKeyHex,
    domains: [
      { domainId: 7, name: "owner" },
      {
        domainId: 8,
        name: "delegate",
        ownerScriptPubKeyHex: externalScriptPubKeyHex,
        delegateScriptPubKeyHex: walletScriptPubKeyHex,
      },
      {
        domainId: 9,
        name: "miner",
        ownerScriptPubKeyHex: externalScriptPubKeyHex,
        minerScriptPubKeyHex: walletScriptPubKeyHex,
      },
      {
        domainId: 10,
        name: "external",
        ownerScriptPubKeyHex: externalScriptPubKeyHex,
      },
      { domainId: 11, name: "unanchored", anchored: false },
      { domainId: 12, name: "owner-child" },
    ],
  });

  assert.deepEqual(resolveEligibleAnchoredRootsForTesting(context), [
    {
      domainId: 7,
      domainName: "owner",
      localIndex: 0,
      sender: {
        localIndex: 0,
        scriptPubKeyHex: walletScriptPubKeyHex,
        address: "bc1qfunding",
      },
    },
    {
      domainId: 8,
      domainName: "delegate",
      localIndex: 0,
      sender: {
        localIndex: 0,
        scriptPubKeyHex: walletScriptPubKeyHex,
        address: "bc1qfunding",
      },
    },
    {
      domainId: 9,
      domainName: "miner",
      localIndex: 0,
      sender: {
        localIndex: 0,
        scriptPubKeyHex: walletScriptPubKeyHex,
        address: "bc1qfunding",
      },
    },
  ]);
});

function createGateAssayStub(scores: Record<string, bigint | null>) {
  return async (_domainId: number, _referencedBlockHashInternal: Uint8Array, sentences: string[]) =>
    sentences.map((sentence, index) => {
      const score = Object.prototype.hasOwnProperty.call(scores, sentence)
        ? scores[sentence]
        : 1n;
      return {
        sentence,
        rank: index + 1,
        gatesPass: score !== null,
        encodedSentenceBytes: score === null ? null : Buffer.from(sentence, "utf8"),
        canonicalBlend: score,
        bip39WordIndices: resolveWordIndices(["abandon", "ability", "able", "about", "above"]),
        bip39Words: ["abandon", "ability", "able", "about", "above"],
      };
    }) as any;
}

function createReadyMiningReadContext(options: {
  miningState?: ReturnType<typeof createMiningState>;
  close?: () => Promise<void>;
  readContextOverrides?: Record<string, unknown>;
}) {
  const walletScriptPubKeyHex = "0014" + "11".repeat(20);
  const readContextOverrides = options.readContextOverrides ?? {};
  const modelOverride = readContextOverrides["model"];
  const mergedReadContextOverrides = {
    ...readContextOverrides,
    ...(modelOverride !== undefined && modelOverride !== null && typeof modelOverride === "object" && !Array.isArray(modelOverride)
      ? {
        model: {
          walletAddress: "bc1qfunding",
          ...(modelOverride as Record<string, unknown>),
        },
      }
      : {}),
  };
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
    miningState: options.miningState ?? createMiningState(),
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
      model: {
        walletAddress: state.managedCoreWallet.walletAddress,
        walletScriptPubKeyHex: state.managedCoreWallet.walletScriptPubKeyHex,
        domains: [{
          name: "cogdemo",
          anchored: true,
          readOnly: false,
          localRelationship: "local",
          domainId: 7,
          ownerAddress: "bc1qfunding",
          ownerScriptPubKeyHex: state.managedCoreWallet.walletScriptPubKeyHex,
        }],
      },
      snapshot: {
        tip: {
          height: 100,
          blockHashHex: "11".repeat(32),
          previousHashHex: "00".repeat(32),
          stateHashHex: null,
        },
        state: {
          consensus: {
            domainIdsByName: new Map([["cogdemo", 7]]),
            domainsById: new Map([[7, {
              domainId: 7,
              name: "cogdemo",
              anchored: true,
              anchorHeight: 100,
              ownerScriptPubKey: Buffer.from(walletScriptPubKeyHex, "hex"),
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
        health: "synced",
        message: null,
        status: {
          state: "synced",
          heartbeatAtUnixMs: 1,
          updatedAtUnixMs: 1,
          ipcReady: true,
          rpcReachable: true,
          coreBestHeight: 100,
          coreBestHash: "11".repeat(32),
          appliedTipHeight: 100,
          appliedTipHash: "11".repeat(32),
          reorgDepth: null,
        },
        source: "lease",
        daemonInstanceId: "daemon-1",
        snapshotSeq: "seq-100",
        openedAtUnixMs: 1,
        snapshotTip: {
          height: 100,
          blockHashHex: "11".repeat(32),
          previousHashHex: "00".repeat(32),
          stateHashHex: null,
        },
      },
      nodeStatus: {
        chain: "mainnet",
        nodeBestHeight: 100,
        nodeBestHashHex: "11".repeat(32),
        walletReplica: {
          proofStatus: "ready",
        },
      },
      ...mergedReadContextOverrides,
    }),
    close: options.close ?? (async () => undefined),
  } as any;
}

function createManagedBitcoindTimeoutMessage(method = "getblockchaininfo"): string {
  return `The managed Bitcoin RPC request to 127.0.0.1:49987 for ${method} failed: timeout`;
}

function createRecoveryReadContext(overrides: Record<string, unknown> = {}) {
  return createReadyMiningReadContext({
    miningState: createMiningState({
      livePublishInMempool: false,
    }),
    readContextOverrides: {
      indexer: {
        health: "synced",
        message: null,
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
        walletScriptPubKeyHex: "0014" + "11".repeat(20),
        domains: [],
      },
      ...overrides,
    },
  });
}

function createProviderRetryReadContext() {
  return createReadyMiningReadContext({
    miningState: createMiningState({
      livePublishInMempool: false,
    }),
    readContextOverrides: {
      snapshot: {
        tip: {
          height: 100,
          blockHashHex: "11".repeat(32),
          previousHashHex: "00".repeat(32),
          stateHashHex: null,
        },
        state: {
          consensus: {
            domainIdsByName: new Map([["cogdemo", 7]]),
            domainsById: new Map([[7, {
              domainId: 7,
              name: "cogdemo",
              anchored: true,
              anchorHeight: 100,
              ownerScriptPubKey: Buffer.from("0014" + "11".repeat(20), "hex"),
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
          stateHashHex: null,
        },
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
      nodeHealth: "synced",
    },
  });
}

test("normalizeMiningStateRecord accepts legacy liveMiningFamilyInMempool snapshots", () => {
  const normalized = normalizeMiningStateRecord({
    ...createMiningState({
      currentTxid: "aa".repeat(32),
      currentPublishState: "in-mempool",
    }),
    livePublishInMempool: null,
    liveMiningFamilyInMempool: true,
  } as any);

  assert.equal(normalized.livePublishInMempool, true);
  assert.equal(miningPublishIsInMempool(normalized), true);
  assert.equal(miningPublishMayStillExist(normalized), true);
});

test("clearMiningPublishState resets the live publish markers", () => {
  const cleared = clearMiningPublishState(createMiningState({
    state: "live",
    currentPublishState: "in-mempool",
    currentTxid: "bb".repeat(32),
    livePublishInMempool: true,
    currentPublishDecision: "restored-live-publish",
  }));

  assert.equal(cleared.state, "idle");
  assert.equal(cleared.currentPublishState, "none");
  assert.equal(cleared.livePublishInMempool, false);
  assert.equal(cleared.currentTxid, null);
  assert.equal(cleared.currentPublishDecision, null);
});

function createRepairRequiredMiningState(
  overrides: Partial<ReturnType<typeof createMiningState>> = {},
): ReturnType<typeof createMiningState> {
  return createMiningState({
    runMode: "foreground",
    state: "repair-required",
    pauseReason: "wallet-conflict-observed",
    currentPublishState: "in-mempool",
    currentTxid: "aa".repeat(32),
    currentWtxid: "bb".repeat(32),
    currentDomain: "cogdemo",
    currentDomainId: 7,
    currentDomainIndex: 0,
    currentSenderScriptPubKeyHex: "0014" + "11".repeat(20),
    currentBlockTargetHeight: 101,
    currentReferencedBlockHashDisplay: "11".repeat(32),
    livePublishInMempool: false,
    currentPublishDecision: "repair-required-wallet-conflict",
    ...overrides,
  });
}

test("reconcileLiveMiningState auto-clears repair-required mining state without a tracked txid", async () => {
  let listUnspentCalls = 0;
  const state = createWalletState({
    miningState: createRepairRequiredMiningState({
      currentTxid: null,
      currentPublishState: "broadcast-unknown",
      currentPublishDecision: "repair-required-broadcast-conflict",
    }),
  });

  const result = await reconcileLiveMiningStateForTesting({
    state,
    rpc: createHealthyMiningRpc({
      async listUnspent() {
        listUnspentCalls += 1;
        return [];
      },
      async getTransaction() {
        throw new Error("getTransaction should not be needed without a tracked txid");
      },
    }) as any,
    nodeBestHash: null,
    nodeBestHeight: null,
  });

  assert.equal(result.state.miningState.state, "idle");
  assert.equal(result.state.miningState.currentPublishState, "none");
  assert.equal(result.state.miningState.currentTxid, null);
  assert.equal(result.state.miningState.livePublishInMempool, false);
  assert.equal(result.state.miningState.currentPublishDecision, "repair-auto-cleared-empty-publish");
  assert.equal(listUnspentCalls, 1);
});

test("reconcileLiveMiningState auto-clears repair-required mining state with no publish marker", async () => {
  const state = createWalletState({
    miningState: createRepairRequiredMiningState({
      currentPublishState: "none",
      currentPublishDecision: "repair-required-wallet-conflict",
    }),
  });

  const result = await reconcileLiveMiningStateForTesting({
    state,
    rpc: createHealthyMiningRpc() as any,
    nodeBestHash: null,
    nodeBestHeight: null,
  });

  assert.equal(result.state.miningState.state, "idle");
  assert.equal(result.state.miningState.currentPublishState, "none");
  assert.equal(result.state.miningState.currentTxid, null);
  assert.equal(result.state.miningState.currentPublishDecision, "repair-auto-cleared-empty-publish");
});

test("reconcileLiveMiningState keeps confirmed tracked mining tx behavior", async () => {
  const txid = "aa".repeat(32);
  const state = createWalletState({
    miningState: createRepairRequiredMiningState({
      currentTxid: txid,
      currentPublishState: "broadcast-unknown",
      currentPublishDecision: "repair-required-broadcast-conflict",
    }),
  });

  const result = await reconcileLiveMiningStateForTesting({
    state,
    rpc: createHealthyMiningRpc({
      async getRawMempoolVerbose() {
        return {
          txids: [],
          mempool_sequence: "seq-1",
        };
      },
      async getTransaction(_walletName: string, requestedTxid: string) {
        assert.equal(requestedTxid, txid);
        return {
          txid,
          confirmations: 2,
          walletconflicts: [],
        };
      },
    }) as any,
    nodeBestHash: "11".repeat(32),
    nodeBestHeight: 100,
  });

  assert.equal(result.state.miningState.state, "idle");
  assert.equal(result.state.miningState.currentPublishState, "none");
  assert.equal(result.state.miningState.currentTxid, null);
  assert.equal(result.state.miningState.currentPublishDecision, "tx-confirmed-while-down");
});

test("reconcileLiveMiningState restores repair-required tracked txs that are back in mempool", async () => {
  const txid = "aa".repeat(32);
  const scenarios = [
    {
      runMode: "foreground" as const,
      referencedBlockHashDisplay: "11".repeat(32),
      targetBlockHeight: 101,
      expectedState: "live",
      expectedPauseReason: null,
      expectedDecision: "restored-live-publish",
    },
    {
      runMode: "stopped" as const,
      referencedBlockHashDisplay: "11".repeat(32),
      targetBlockHeight: 101,
      expectedState: "paused",
      expectedPauseReason: "user-stopped",
      expectedDecision: "restored-live-publish",
    },
    {
      runMode: "foreground" as const,
      referencedBlockHashDisplay: "22".repeat(32),
      targetBlockHeight: 102,
      expectedState: "paused-stale",
      expectedPauseReason: "stale-block-context",
      expectedDecision: "paused-stale-mempool",
    },
  ];

  for (const scenario of scenarios) {
    const state = createWalletState({
      miningState: createRepairRequiredMiningState({
        runMode: scenario.runMode,
        currentTxid: txid,
        currentReferencedBlockHashDisplay: scenario.referencedBlockHashDisplay,
        currentBlockTargetHeight: scenario.targetBlockHeight,
      }),
    });

    const result = await reconcileLiveMiningStateForTesting({
      state,
      rpc: createHealthyMiningRpc({
        async getRawMempoolVerbose() {
          return {
            txids: [txid],
            mempool_sequence: "seq-1",
          };
        },
        async getTransaction() {
          return {
            txid,
            confirmations: 0,
            walletconflicts: [],
          };
        },
      }) as any,
      nodeBestHash: "11".repeat(32),
      nodeBestHeight: 100,
    });

    assert.equal(result.state.miningState.state, scenario.expectedState);
    assert.equal(result.state.miningState.pauseReason, scenario.expectedPauseReason);
    assert.equal(result.state.miningState.currentPublishState, "in-mempool");
    assert.equal(result.state.miningState.currentTxid, txid);
    assert.equal(result.state.miningState.livePublishInMempool, true);
    assert.equal(result.state.miningState.currentPublishDecision, scenario.expectedDecision);
  }
});

test("reconcileLiveMiningState auto-clears repair-required mining state after a confirmed wallet conflict", async () => {
  const txid = "aa".repeat(32);
  const conflictTxid = "cc".repeat(32);
  let listUnspentCalls = 0;
  const state = createWalletState({
    miningState: createRepairRequiredMiningState({
      currentTxid: txid,
      currentPublishState: "broadcast-unknown",
      pauseReason: "broadcast-unknown-conflict",
      currentPublishDecision: "repair-required-broadcast-conflict",
    }),
  });

  const result = await reconcileLiveMiningStateForTesting({
    state,
    rpc: createHealthyMiningRpc({
      async listUnspent() {
        listUnspentCalls += 1;
        return [];
      },
      async getRawMempoolVerbose() {
        return {
          txids: [],
          mempool_sequence: "seq-1",
        };
      },
      async getTransaction(_walletName: string, requestedTxid: string) {
        if (requestedTxid === txid) {
          return {
            txid,
            confirmations: 0,
            walletconflicts: [conflictTxid],
          };
        }

        assert.equal(requestedTxid, conflictTxid);
        return {
          txid: conflictTxid,
          confirmations: 1,
          walletconflicts: [],
        };
      },
    }) as any,
    nodeBestHash: "11".repeat(32),
    nodeBestHeight: 100,
  });

  assert.equal(result.state.miningState.state, "idle");
  assert.equal(result.state.miningState.currentPublishState, "none");
  assert.equal(result.state.miningState.currentTxid, null);
  assert.equal(result.state.miningState.livePublishInMempool, false);
  assert.equal(result.state.miningState.currentPublishDecision, "repair-auto-cleared-confirmed-conflict");
  assert.equal(listUnspentCalls, 1);
});

test("reconcileLiveMiningState keeps repair-required mining state for unconfirmed wallet conflicts", async () => {
  const txid = "aa".repeat(32);
  const conflictTxid = "cc".repeat(32);
  const state = createWalletState({
    miningState: createRepairRequiredMiningState({
      currentTxid: txid,
      currentPublishState: "in-mempool",
    }),
  });

  const result = await reconcileLiveMiningStateForTesting({
    state,
    rpc: createHealthyMiningRpc({
      async getRawMempoolVerbose() {
        return {
          txids: [],
          mempool_sequence: "seq-1",
        };
      },
      async getTransaction(_walletName: string, requestedTxid: string) {
        return {
          txid: requestedTxid,
          confirmations: 0,
          walletconflicts: requestedTxid === txid ? [conflictTxid] : [],
        };
      },
    }) as any,
    nodeBestHash: "11".repeat(32),
    nodeBestHeight: 100,
  });

  assert.equal(result.state.miningState.state, "repair-required");
  assert.equal(result.state.miningState.pauseReason, "wallet-conflict-observed");
  assert.equal(result.state.miningState.currentPublishState, "in-mempool");
  assert.equal(result.state.miningState.currentTxid, txid);
  assert.equal(result.state.miningState.livePublishInMempool, false);
  assert.equal(result.state.miningState.currentPublishDecision, "repair-required-wallet-conflict");
});

test("reconcileLiveMiningState keeps repair-required mining state when conflict lookup fails", async () => {
  const txid = "aa".repeat(32);
  const conflictTxid = "cc".repeat(32);
  const state = createWalletState({
    miningState: createRepairRequiredMiningState({
      currentTxid: txid,
      currentPublishState: "broadcast-unknown",
      pauseReason: "broadcast-unknown-conflict",
      currentPublishDecision: "repair-required-broadcast-conflict",
    }),
  });

  const result = await reconcileLiveMiningStateForTesting({
    state,
    rpc: createHealthyMiningRpc({
      async getRawMempoolVerbose() {
        return {
          txids: [],
          mempool_sequence: "seq-1",
        };
      },
      async getTransaction(_walletName: string, requestedTxid: string) {
        if (requestedTxid === txid) {
          return {
            txid,
            confirmations: 0,
            walletconflicts: [conflictTxid],
          };
        }

        throw new Error("conflict transaction is temporarily unavailable");
      },
    }) as any,
    nodeBestHash: "11".repeat(32),
    nodeBestHeight: 100,
  });

  assert.equal(result.state.miningState.state, "repair-required");
  assert.equal(result.state.miningState.pauseReason, "broadcast-unknown-conflict");
  assert.equal(result.state.miningState.currentPublishState, "broadcast-unknown");
  assert.equal(result.state.miningState.currentTxid, txid);
  assert.equal(result.state.miningState.currentPublishDecision, "repair-required-broadcast-conflict");
});

test("same-tip live publishes are kept but stale-tip publishes are replaceable", () => {
  const sameTip = shouldKeepCurrentTipLivePublishForTesting({
    liveState: createMiningState({
      currentPublishState: "in-mempool",
      currentTxid: "cc".repeat(32),
      livePublishInMempool: true,
      currentReferencedBlockHashDisplay: "11".repeat(32),
      currentBlockTargetHeight: 101,
    }),
    candidate: {
      domainId: 1,
      sender: {
        localIndex: 0,
        scriptPubKeyHex: "0014" + "11".repeat(20),
        address: "bc1qtest",
      },
      encodedSentenceBytes: Buffer.from("local sentence", "utf8"),
      referencedBlockHashDisplay: "11".repeat(32),
      targetBlockHeight: 101,
    },
  });
  const staleTip = shouldKeepCurrentTipLivePublishForTesting({
    liveState: createMiningState({
      currentPublishState: "in-mempool",
      currentTxid: "dd".repeat(32),
      livePublishInMempool: true,
      currentReferencedBlockHashDisplay: "11".repeat(32),
      currentBlockTargetHeight: 101,
    }),
    candidate: {
      domainId: 1,
      sender: {
        localIndex: 0,
        scriptPubKeyHex: "0014" + "11".repeat(20),
        address: "bc1qtest",
      },
      encodedSentenceBytes: Buffer.from("local sentence", "utf8"),
      referencedBlockHashDisplay: "22".repeat(32),
      targetBlockHeight: 102,
    },
  });

  assert.equal(sameTip, true);
  assert.equal(staleTip, false);
});

test("mining board resolves the latest mined block winners and falls back when domain metadata is missing", () => {
  const rank1Words = ["under", "tree", "monkey", "youth", "basket"] as const;
  const rank2Words = englishWordlist.slice(20, 25);
  const snapshotState = {
    consensus: {
      domainsById: new Map([
        [7, {
          domainId: 7,
          name: "cogdemo",
          anchored: true,
          anchorHeight: 99,
          endpoint: null,
        }],
      ]),
    },
    history: {
      blockWinnersByHeight: new Map([
        [100, [
          {
            height: 100,
            rank: 1,
            domainId: 7,
            creditedScriptPubKeyHex: "0014" + "11".repeat(20),
            rewardCogtoshi: 123_000_000n,
            canonicalBlend: 1000n,
            sentenceHex: "",
            sentenceText: "Under the trees, a monkey helped.",
            bip39WordIndices: resolveWordIndices(rank1Words),
            txIndex: 0,
            txidHex: "aa".repeat(32),
          },
          {
            height: 100,
            rank: 2,
            domainId: 8,
            creditedScriptPubKeyHex: "0014" + "22".repeat(20),
            rewardCogtoshi: 61_500_000n,
            canonicalBlend: 999n,
            sentenceHex: "",
            sentenceText: "Youth carried the basket home.",
            bip39WordIndices: resolveWordIndices(rank2Words),
            txIndex: 1,
            txidHex: "bb".repeat(32),
          },
        ]],
      ]),
      foundingMessageByDomain: new Map(),
    },
  } as any;

  const settled = resolveSettledBoardForTesting({
    snapshotState,
    snapshotTipHeight: 100,
    nodeBestHeight: 100,
  });

  assert.equal(settled.settledBlockHeight, 100);
  assert.deepEqual(settled.settledBoardEntries, [
    createSettledBoardEntry(1, "cogdemo", "Under the trees, a monkey helped.", rank1Words),
    createSettledBoardEntry(2, "domain-8", "Youth carried the basket home.", rank2Words),
  ]);
});

test("mining board derives per-winner settled required words from the settled block previous hash when history omits them", () => {
  const snapshotTipPreviousHashHex = "11".repeat(32);
  const snapshotState = {
    consensus: {
      domainsById: new Map([
        [7, {
          domainId: 7,
          name: "cogdemo",
          anchored: true,
          anchorHeight: 99,
          endpoint: null,
        }],
        [8, {
          domainId: 8,
          name: "betademo",
          anchored: true,
          anchorHeight: 99,
          endpoint: null,
        }],
      ]),
    },
    history: {
      blockWinnersByHeight: new Map([
        [100, [
          {
            height: 100,
            rank: 1,
            domainId: 7,
            creditedScriptPubKeyHex: "0014" + "11".repeat(20),
            rewardCogtoshi: 123_000_000n,
            canonicalBlend: 1000n,
            sentenceHex: "",
            sentenceText: "First settled sentence.",
            txIndex: 0,
            txidHex: "aa".repeat(32),
          },
          {
            height: 100,
            rank: 2,
            domainId: 8,
            creditedScriptPubKeyHex: "0014" + "22".repeat(20),
            rewardCogtoshi: 61_500_000n,
            canonicalBlend: 999n,
            sentenceHex: "",
            sentenceText: "Second settled sentence.",
            txIndex: 1,
            txidHex: "bb".repeat(32),
          },
        ]],
      ]),
      foundingMessageByDomain: new Map(),
    },
  } as any;

  const settled = resolveSettledBoardForTesting({
    snapshotState,
    snapshotTipHeight: 100,
    snapshotTipPreviousHashHex,
    nodeBestHeight: 100,
  });

  assert.deepEqual(settled.settledBoardEntries, [
    createSettledBoardEntry(1, "cogdemo", "First settled sentence.", resolveDerivedWords(snapshotTipPreviousHashHex, 7)),
    createSettledBoardEntry(2, "betademo", "Second settled sentence.", resolveDerivedWords(snapshotTipPreviousHashHex, 8)),
  ]);
  assert.notDeepEqual(
    settled.settledBoardEntries[0]?.requiredWords,
    settled.settledBoardEntries[1]?.requiredWords,
  );
});

test("mining board stays pinned to the indexed snapshot block until the snapshot catches up", () => {
  const snapshotState = {
    consensus: {
      domainsById: new Map([
        [7, {
          domainId: 7,
          name: "cogdemo",
          anchored: true,
          anchorHeight: 100,
          endpoint: null,
        }],
      ]),
    },
    history: {
      blockWinnersByHeight: new Map([
        [100, [{
          height: 100,
          rank: 1,
          domainId: 7,
          creditedScriptPubKeyHex: "0014" + "11".repeat(20),
          rewardCogtoshi: 123_000_000n,
          canonicalBlend: 1000n,
          sentenceHex: "",
          sentenceText: "Settled prior block sentence.",
          bip39WordIndices: resolveWordIndices(["under", "tree", "monkey", "youth", "basket"]),
          txIndex: 0,
          txidHex: "aa".repeat(32),
        }]],
      ]),
      foundingMessageByDomain: new Map(),
    },
  } as any;

  const settled = resolveSettledBoardForTesting({
    snapshotState,
    snapshotTipHeight: 100,
    nodeBestHeight: 101,
  });

  assert.equal(settled.settledBlockHeight, 100);
  assert.deepEqual(settled.settledBoardEntries, [
    createSettledBoardEntry(1, "cogdemo", "Settled prior block sentence.", ["under", "tree", "monkey", "youth", "basket"]),
  ]);
});

test("mining board falls back to the latest prior non-empty board when the indexed tip has no winner history yet", () => {
  const snapshotState = {
    consensus: {
      domainsById: new Map([
        [7, {
          domainId: 7,
          name: "cogdemo",
          anchored: true,
          anchorHeight: 100,
          endpoint: null,
        }],
      ]),
    },
    history: {
      blockWinnersByHeight: new Map([
        [100, [{
          height: 100,
          rank: 1,
          domainId: 7,
          creditedScriptPubKeyHex: "0014" + "11".repeat(20),
          rewardCogtoshi: 123_000_000n,
          canonicalBlend: 1000n,
          sentenceHex: "",
          sentenceText: "Prior non-empty settled sentence.",
          bip39WordIndices: resolveWordIndices(["under", "tree", "monkey", "youth", "basket"]),
          txIndex: 0,
          txidHex: "aa".repeat(32),
        }]],
      ]),
      foundingMessageByDomain: new Map(),
    },
  } as any;

  const settled = resolveSettledBoardForTesting({
    snapshotState,
    snapshotTipHeight: 101,
    nodeBestHeight: 101,
  });

  assert.equal(settled.settledBlockHeight, 100);
  assert.deepEqual(settled.settledBoardEntries, [
    createSettledBoardEntry(1, "cogdemo", "Prior non-empty settled sentence.", ["under", "tree", "monkey", "youth", "basket"]),
  ]);
});

test("mining board falls back to the snapshot tip height when the node best height is unavailable", () => {
  const snapshotState = {
    consensus: {
      domainsById: new Map([
        [7, {
          domainId: 7,
          name: "cogdemo",
          anchored: true,
          anchorHeight: 99,
          endpoint: null,
        }],
      ]),
    },
    history: {
      blockWinnersByHeight: new Map([
        [100, [{
          height: 100,
          rank: 1,
          domainId: 7,
          creditedScriptPubKeyHex: "0014" + "11".repeat(20),
          rewardCogtoshi: 123_000_000n,
          canonicalBlend: 1000n,
          sentenceHex: "",
          sentenceText: "Snapshot tip sentence.",
          bip39WordIndices: resolveWordIndices(["under", "tree", "monkey", "youth", "basket"]),
          txIndex: 0,
          txidHex: "aa".repeat(32),
        }]],
      ]),
      foundingMessageByDomain: new Map(),
    },
  } as any;

  const settled = resolveSettledBoardForTesting({
    snapshotState,
    snapshotTipHeight: 100,
    nodeBestHeight: null,
  });

  assert.equal(settled.settledBlockHeight, 100);
  assert.deepEqual(settled.settledBoardEntries, [
    createSettledBoardEntry(1, "cogdemo", "Snapshot tip sentence.", ["under", "tree", "monkey", "youth", "basket"]),
  ]);
});

test("performMiningCycle keeps the prior settled board pinned across tip rollover until the new tip winners are available", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-board-stale");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const previousTipHash = "10".repeat(32);
  const snapshotTipHash = "11".repeat(32);
  const currentTipHash = "12".repeat(32);
  const loopState = createMiningLoopStateForTesting();
  loopState.currentTipKey = `${previousTipHash}:101`;
  loopState.ui.settledBlockHeight = 100;
  loopState.ui.settledBoardEntries = [
    createSettledBoardEntry(1, "cogdemo", "Prior settled sentence."),
  ];
  loopState.ui.provisionalRequiredWords = ["under", "tree", "monkey", "youth", "basket"];
  loopState.ui.provisionalEntry = {
    domainName: "cogdemo",
    sentence: "Old tip provisional sentence.",
  };
  loopState.ui.latestSentence = "Old tip provisional sentence.";

  const rpc = {
    async listLockUnspent() {
      return [];
    },
    async lockUnspent() {
      return true;
    },
    async listUnspent() {
      return [];
    },
    async getBlock(hashHex: string) {
      if (hashHex === snapshotTipHash) {
        return {
          hash: snapshotTipHash,
          height: 100,
          time: 1_700_000_100,
        };
      }

      if (hashHex === currentTipHash) {
        return {
          hash: currentTipHash,
          height: 101,
          time: 1_700_000_101,
        };
      }

      throw new Error(`unexpected getBlock ${hashHex}`);
    },
    async getBlockchainInfo() {
      return {
        blocks: 101,
        bestblockhash: currentTipHash,
        initialblockdownload: false,
      };
    },
    async getNetworkInfo() {
      return {
        networkactive: true,
        connections_out: 8,
      };
    },
    async getMempoolInfo() {
      return {
        loaded: true,
      };
    },
  };

  const catchingUpContext = createReadyMiningReadContext({
    miningState: createMiningState({
      livePublishInMempool: false,
    }),
    readContextOverrides: {
      snapshot: {
        tip: {
          height: 100,
          blockHashHex: snapshotTipHash,
          previousHashHex: null,
          stateHashHex: null,
        },
        state: {
          consensus: {
            domainIdsByName: new Map([["cogdemo", 7]]),
            domainsById: new Map([[7, {
              domainId: 7,
              name: "cogdemo",
              anchored: true,
              anchorHeight: 100,
              ownerScriptPubKey: Buffer.from("0014" + "11".repeat(20), "hex"),
              endpoint: null,
            }]]),
            balances: new Map(),
          },
          history: {
            foundingMessageByDomain: new Map(),
            blockWinnersByHeight: new Map([
              [100, [{
                height: 100,
                rank: 1,
                domainId: 7,
                creditedScriptPubKeyHex: "0014" + "11".repeat(20),
                rewardCogtoshi: 123_000_000n,
                canonicalBlend: 1000n,
                sentenceHex: "",
                sentenceText: "Prior settled sentence.",
                bip39WordIndices: resolveWordIndices(["under", "tree", "monkey", "youth", "basket"]),
                txIndex: 0,
                txidHex: "aa".repeat(32),
              }]],
            ]),
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
        snapshotTip: {
          height: 100,
          blockHashHex: snapshotTipHash,
          previousHashHex: null,
          stateHashHex: null,
        },
      },
      nodeStatus: {
        chain: "mainnet",
        nodeBestHeight: 101,
        nodeBestHashHex: currentTipHash,
        walletReplica: {
          proofStatus: "ready",
        },
      },
      model: {
        walletScriptPubKeyHex: "0014" + "11".repeat(20),
        domains: [],
      },
    },
  });

  await performMiningCycleForTesting({
    dataDir: homeDirectory,
    databasePath: `${homeDirectory}/client.sqlite`,
    provider,
    paths,
    runMode: "foreground",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    openReadContext: async () => catchingUpContext,
    attachService: async () => ({ rpc: {} } as any),
    rpcFactory: () => rpc as any,
    loopState,
  });

  const waitingSnapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(waitingSnapshot?.currentPhase, "waiting-indexer");
  assert.equal(loopState.ui.settledBlockHeight, 100);
  assert.deepEqual(loopState.ui.settledBoardEntries, [
    createSettledBoardEntry(1, "cogdemo", "Prior settled sentence.", ["under", "tree", "monkey", "youth", "basket"]),
  ]);
  assert.deepEqual(loopState.ui.provisionalRequiredWords, []);
  assert.deepEqual(loopState.ui.provisionalEntry, {
    domainName: null,
    sentence: null,
  });
  assert.equal(loopState.ui.latestSentence, null);

  const missingWinnersContext = createReadyMiningReadContext({
    miningState: createMiningState({
      livePublishInMempool: false,
    }),
    readContextOverrides: {
      snapshot: {
        tip: {
          height: 101,
          blockHashHex: currentTipHash,
          previousHashHex: snapshotTipHash,
          stateHashHex: null,
        },
        state: {
          consensus: {
            domainIdsByName: new Map([["cogdemo", 7]]),
            domainsById: new Map([[7, {
              domainId: 7,
              name: "cogdemo",
              anchored: true,
              anchorHeight: 100,
              ownerScriptPubKey: Buffer.from("0014" + "11".repeat(20), "hex"),
              endpoint: null,
            }]]),
            balances: new Map(),
          },
          history: {
            foundingMessageByDomain: new Map(),
            blockWinnersByHeight: new Map([
              [100, [{
                height: 100,
                rank: 1,
                domainId: 7,
                creditedScriptPubKeyHex: "0014" + "11".repeat(20),
                rewardCogtoshi: 123_000_000n,
                canonicalBlend: 1000n,
                sentenceHex: "",
                sentenceText: "Prior settled sentence.",
                bip39WordIndices: resolveWordIndices(["under", "tree", "monkey", "youth", "basket"]),
                txIndex: 0,
                txidHex: "aa".repeat(32),
              }]],
            ]),
          },
        },
      },
      indexer: {
        health: "synced",
        message: null,
        status: null,
        source: "lease",
        daemonInstanceId: "daemon-1",
        snapshotSeq: "seq-101",
        openedAtUnixMs: 2,
        snapshotTip: {
          height: 101,
          blockHashHex: currentTipHash,
          previousHashHex: snapshotTipHash,
          stateHashHex: null,
        },
      },
      nodeStatus: {
        chain: "mainnet",
        nodeBestHeight: 101,
        nodeBestHashHex: currentTipHash,
        walletReplica: {
          proofStatus: "ready",
        },
      },
      model: {
        walletScriptPubKeyHex: "0014" + "11".repeat(20),
        domains: [],
      },
    },
  });

  await performMiningCycleForTesting({
    dataDir: homeDirectory,
    databasePath: `${homeDirectory}/client.sqlite`,
    provider,
    paths,
    runMode: "foreground",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    openReadContext: async () => missingWinnersContext,
    attachService: async () => ({ rpc: {} } as any),
    rpcFactory: () => rpc as any,
    loopState,
  });

  assert.equal(loopState.ui.settledBlockHeight, 100);
  assert.deepEqual(loopState.ui.settledBoardEntries, [
    createSettledBoardEntry(1, "cogdemo", "Prior settled sentence.", ["under", "tree", "monkey", "youth", "basket"]),
  ]);
  assert.deepEqual(loopState.ui.provisionalRequiredWords, []);
  assert.deepEqual(loopState.ui.provisionalEntry, {
    domainName: null,
    sentence: null,
  });
  assert.equal(loopState.ui.latestSentence, null);

  const syncedContext = createReadyMiningReadContext({
    miningState: createMiningState({
      livePublishInMempool: false,
    }),
    readContextOverrides: {
      snapshot: {
        tip: {
          height: 101,
          blockHashHex: currentTipHash,
          previousHashHex: snapshotTipHash,
          stateHashHex: null,
        },
        state: {
          consensus: {
            domainIdsByName: new Map([["cogdemo", 7]]),
            domainsById: new Map([[7, {
              domainId: 7,
              name: "cogdemo",
              anchored: true,
              anchorHeight: 100,
              ownerScriptPubKey: Buffer.from("0014" + "11".repeat(20), "hex"),
              endpoint: null,
            }]]),
            balances: new Map(),
          },
          history: {
            foundingMessageByDomain: new Map(),
            blockWinnersByHeight: new Map([
              [101, [{
                height: 101,
                rank: 1,
                domainId: 7,
                creditedScriptPubKeyHex: "0014" + "11".repeat(20),
                rewardCogtoshi: 123_000_000n,
                canonicalBlend: 1001n,
                sentenceHex: "",
                sentenceText: "Caught-up settled sentence.",
                bip39WordIndices: resolveWordIndices(["under", "tree", "monkey", "youth", "basket"]),
                txIndex: 0,
                txidHex: "bb".repeat(32),
              }]],
            ]),
          },
        },
      },
      indexer: {
        health: "synced",
        message: null,
        status: null,
        source: "lease",
        daemonInstanceId: "daemon-1",
        snapshotSeq: "seq-101",
        openedAtUnixMs: 2,
        snapshotTip: {
          height: 101,
          blockHashHex: currentTipHash,
          previousHashHex: snapshotTipHash,
          stateHashHex: null,
        },
      },
      nodeStatus: {
        chain: "mainnet",
        nodeBestHeight: 101,
        nodeBestHashHex: currentTipHash,
        walletReplica: {
          proofStatus: "ready",
        },
      },
      model: {
        walletScriptPubKeyHex: "0014" + "11".repeat(20),
        domains: [],
      },
    },
  });

  await performMiningCycleForTesting({
    dataDir: homeDirectory,
    databasePath: `${homeDirectory}/client.sqlite`,
    provider,
    paths,
    runMode: "foreground",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    openReadContext: async () => syncedContext,
    attachService: async () => ({ rpc: {} } as any),
    rpcFactory: () => rpc as any,
    loopState,
  });

  assert.equal(loopState.ui.settledBlockHeight, 101);
  assert.deepEqual(loopState.ui.settledBoardEntries, [
    createSettledBoardEntry(1, "cogdemo", "Caught-up settled sentence.", ["under", "tree", "monkey", "youth", "basket"]),
  ]);
});

test("performMiningCycle marks a fresh tip settle window while waiting for the indexer to catch up", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-tip-settle");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const loopState = createMiningLoopStateForTesting();
  const snapshotTipHash = "11".repeat(32);
  const currentTipHash = "12".repeat(32);

  await performMiningCycleForTesting({
    dataDir: homeDirectory,
    databasePath: `${homeDirectory}/client.sqlite`,
    provider,
    paths,
    runMode: "foreground",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    openReadContext: async () => createReadyMiningReadContext({
      miningState: createMiningState({
        livePublishInMempool: false,
      }),
      readContextOverrides: {
        snapshot: {
          tip: {
            height: 100,
            blockHashHex: snapshotTipHash,
            previousHashHex: null,
            stateHashHex: null,
          },
          state: {
            consensus: {
              domainIdsByName: new Map([["cogdemo", 7]]),
              domainsById: new Map([[7, {
                domainId: 7,
                name: "cogdemo",
                anchored: true,
                anchorHeight: 100,
                ownerScriptPubKey: Buffer.from("0014" + "11".repeat(20), "hex"),
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
          snapshotTip: {
            height: 100,
            blockHashHex: snapshotTipHash,
            previousHashHex: null,
            stateHashHex: null,
          },
        },
        nodeStatus: {
          chain: "mainnet",
          nodeBestHeight: 101,
          nodeBestHashHex: currentTipHash,
          walletReplica: {
            proofStatus: "ready",
          },
        },
        model: {
          walletScriptPubKeyHex: "0014" + "11".repeat(20),
          domains: [],
        },
      },
    }),
    attachService: async () => ({
      rpc: {},
      pid: 9_001,
      refreshServiceStatus: async () => ({
        serviceInstanceId: "svc-1",
        processId: 9_001,
      }),
    }) as any,
    rpcFactory: () => createHealthyMiningRpc() as any,
    loopState,
    nowImpl: () => 1_000,
  });

  const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(snapshot?.currentPhase, "waiting-indexer");
  assert.equal(snapshot?.tipSettledUntilUnixMs, 1_000 + MINING_TIP_SETTLE_WINDOW_MS);
  assert.equal(snapshot?.reconnectSettledUntilUnixMs, null);
});

test("performMiningCycle waits instead of crashing when mining read context is missing snapshot and model", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-missing-ready-context");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const loopState = createMiningLoopStateForTesting();
  const state = createWalletState({
    miningState: createMiningState({
      livePublishInMempool: false,
    }),
  });

  await assert.doesNotReject(async () => {
    await performMiningCycleForTesting({
      dataDir: homeDirectory,
      databasePath: `${homeDirectory}/client.sqlite`,
      provider,
      paths,
      runMode: "foreground",
      backgroundWorkerPid: null,
      backgroundWorkerRunId: null,
      openReadContext: async () => ({
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
          snapshot: null,
          model: null,
        }),
        close: async () => undefined,
      }),
      attachService: async () => ({ rpc: {} } as any),
      rpcFactory: () => createHealthyMiningRpc() as any,
      loopState,
    });
  });

  const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(snapshot?.currentPhase, "waiting-indexer");
  assert.equal(snapshot?.lastError, null);
  assert.equal(snapshot?.readinessBlocker, "indexer-snapshot");
  assert.equal(snapshot?.note, "Mining is waiting for a coherent indexer snapshot lease.");
});

test("performMiningCycle retries publish-time snapshot lease loss without marking the tip attempted", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-publish-snapshot-loss");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const loopState = createMiningLoopStateForTesting();
  const readyReadContext = createReadyMiningReadContext({
    miningState: createMiningState({
      livePublishInMempool: false,
    }),
    readContextOverrides: {
      dataDir: homeDirectory,
      databasePath: `${homeDirectory}/client.sqlite`,
      snapshot: {
        daemonInstanceId: "daemon-1",
        snapshotSeq: "seq-100",
        tip: {
          height: 100,
          blockHashHex: "11".repeat(32),
          previousHashHex: "00".repeat(32),
          stateHashHex: null,
        },
        state: {
          consensus: {
            domainIdsByName: new Map([["cogdemo", 7]]),
            domainsById: new Map([[7, {
              domainId: 7,
              name: "cogdemo",
              anchored: true,
              anchorHeight: 100,
              ownerScriptPubKey: Buffer.from("0014" + "11".repeat(20), "hex"),
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
          stateHashHex: null,
        },
      },
      nodeHealth: "synced",
    },
  });
  const missingSnapshotContext = {
    ...createWalletReadContext({
      localState: readyReadContext.localState,
      nodeStatus: readyReadContext.nodeStatus,
      nodeHealth: "synced",
      snapshot: null,
      model: null,
      indexer: {
        health: "unavailable",
        message: "snapshot unavailable",
        status: {
          state: "synced",
          heartbeatAtUnixMs: 1,
          updatedAtUnixMs: 1,
          ipcReady: true,
          rpcReachable: true,
          coreBestHeight: 100,
          coreBestHash: "11".repeat(32),
          appliedTipHeight: 100,
          appliedTipHash: "11".repeat(32),
          reorgDepth: null,
        },
        source: "status-file",
        daemonInstanceId: "daemon-1",
        snapshotSeq: "seq-100",
        openedAtUnixMs: null,
        snapshotTip: null,
      },
    }),
    close: async () => undefined,
  } as any;
  const contexts = [readyReadContext, missingSnapshotContext];

  await startFakeIndexerDaemonStatusServer(t, {
    dataDir: homeDirectory,
    walletRootId: readyReadContext.localState.state.walletRootId,
    daemonInstanceId: "daemon-1",
    snapshotSeq: "seq-100",
  });

  await performMiningCycleForTesting({
    dataDir: homeDirectory,
    databasePath: `${homeDirectory}/client.sqlite`,
    provider,
    paths,
    runMode: "foreground",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    openReadContext: async () => contexts.shift()!,
    attachService: async () => ({ rpc: {}, pid: 9_001 }) as any,
    rpcFactory: () => createHealthyMiningRpc() as any,
    loopState,
    nowImpl: () => 1_000,
    generateCandidatesForDomainsImpl: async () => [createTestMiningCandidate({
      provenance: createTestMiningCandidateProvenance(),
    })],
    runCompetitivenessGateImpl: async () => ({
      allowed: true,
      decision: "allowed",
      sameDomainCompetitorSuppressed: false,
      higherRankedCompetitorDomainCount: 0,
      dedupedCompetitorDomainCount: 0,
      competitivenessGateIndeterminate: false,
      mempoolSequenceCacheStatus: "reused",
      lastMempoolSequence: "seq-1",
      visibleBoardEntries: [],
      candidateRank: 1,
    }) as any,
  });

  const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  const events = await readMiningEvents({
    eventsPath: paths.miningEventsPath,
    all: true,
  });
  assert.equal(loopState.attemptedTipKey, null);
  assert.equal(snapshot?.currentPhase, "waiting-indexer");
  assert.equal(snapshot?.readinessBlocker, "indexer-snapshot");
  assert.equal(snapshot?.currentPublishDecision, "publish-retry-pending");
  assert.equal(snapshot?.note, "Mining is waiting for a coherent indexer snapshot lease before broadcasting the selected candidate.");
  assert.equal(events.some((event) =>
    event.kind === "timing-prepublish-status-write"
    && event.metrics?.outcome === "success"
    && event.durationMs !== undefined
  ), true);
});

test("performMiningCycle retries a synced status-file indexer view before waiting for snapshot lease", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-status-file-retry-wait");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const loopState = createMiningLoopStateForTesting();
  const state = createWalletState({
    miningState: createMiningState({
      livePublishInMempool: false,
    }),
  });
  let openCalls = 0;
  let closeCalls = 0;

  const createStatusFileContext = () => ({
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
      nodeStatus: {
        ready: true,
        chain: "mainnet",
        nodeBestHeight: 100,
        nodeBestHashHex: "11".repeat(32),
        walletReplica: {
          proofStatus: "ready",
        },
      },
      nodeHealth: "synced",
      snapshot: null,
      model: null,
      indexer: {
        health: "unavailable",
        message: "indexer_boom",
        status: {
          state: "synced",
          heartbeatAtUnixMs: 1_000,
          updatedAtUnixMs: 1_100,
          ipcReady: true,
          rpcReachable: true,
          coreBestHeight: 100,
          coreBestHash: "11".repeat(32),
          appliedTipHeight: 100,
          appliedTipHash: "11".repeat(32),
          reorgDepth: null,
        },
        source: "status-file",
        daemonInstanceId: "daemon-status",
        snapshotSeq: "seq-status",
        openedAtUnixMs: null,
        snapshotTip: null,
      },
    }),
    close: async () => {
      closeCalls += 1;
    },
  }) as any;

  await performMiningCycleForTesting({
    dataDir: homeDirectory,
    databasePath: `${homeDirectory}/client.sqlite`,
    provider,
    paths,
    runMode: "foreground",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    openReadContext: async () => {
      openCalls += 1;
      return createStatusFileContext();
    },
    attachService: async () => ({ rpc: {} } as any),
    rpcFactory: () => createHealthyMiningRpc() as any,
    loopState,
  });

  const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(openCalls, 4);
  assert.equal(closeCalls, 4);
  assert.equal(snapshot?.currentPhase, "waiting-indexer");
  assert.equal(snapshot?.readinessBlocker, "indexer-snapshot");
  assert.equal(snapshot?.indexerDaemonState, "synced");
  assert.equal(snapshot?.indexerHealth, "unavailable");
  assert.equal(snapshot?.indexerTruthSource, "status-file");
  assert.equal(snapshot?.indexerStatusTipHeight, 100);
  assert.equal(snapshot?.indexerStatusTipHash, "11".repeat(32));
  assert.equal(snapshot?.lastError, "indexer_boom");
  assert.equal(snapshot?.note, "Mining is waiting for a coherent indexer snapshot lease.");
});

test("performMiningCycle clears waiting-indexer after retrying into a coherent snapshot lease", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-status-file-retry-success");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const loopState = createMiningLoopStateForTesting();
  const state = createWalletState({
    miningState: createMiningState({
      livePublishInMempool: false,
    }),
  });
  const statusFileContext = {
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
      nodeStatus: {
        ready: true,
        chain: "mainnet",
        nodeBestHeight: 100,
        nodeBestHashHex: "11".repeat(32),
        walletReplica: {
          proofStatus: "ready",
        },
      },
      nodeHealth: "synced",
      snapshot: null,
      model: null,
      indexer: {
        health: "unavailable",
        message: "indexer_boom",
        status: {
          state: "synced",
          heartbeatAtUnixMs: 1_000,
          updatedAtUnixMs: 1_100,
          ipcReady: true,
          rpcReachable: true,
          coreBestHeight: 100,
          coreBestHash: "11".repeat(32),
          appliedTipHeight: 100,
          appliedTipHash: "11".repeat(32),
          reorgDepth: null,
        },
        source: "status-file",
        daemonInstanceId: "daemon-status",
        snapshotSeq: "seq-status",
        openedAtUnixMs: null,
        snapshotTip: null,
      },
    }),
    close: async () => undefined,
  } as any;
  const readyContext = createReadyMiningReadContext({
    miningState: state.miningState,
    readContextOverrides: {
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
      model: {
        walletScriptPubKeyHex: "0014" + "11".repeat(20),
        domains: [],
      },
    },
  });
  const contexts = [statusFileContext, readyContext];

  await performMiningCycleForTesting({
    dataDir: homeDirectory,
    databasePath: `${homeDirectory}/client.sqlite`,
    provider,
    paths,
    runMode: "foreground",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    openReadContext: async () => contexts.shift()!,
    attachService: async () => ({ rpc: {} } as any),
    rpcFactory: () => createHealthyMiningRpc() as any,
    loopState,
  });

  const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(contexts.length, 0);
  assert.equal(snapshot?.readinessBlocker, null);
  assert.notEqual(snapshot?.note, "Mining is waiting for Bitcoin Core and the indexer to align.");
  assert.notEqual(snapshot?.note, "Mining is waiting for a coherent indexer snapshot lease.");
});

test("performMiningCycle uses align wording only for real Core/indexer tip mismatch", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-tip-mismatch");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const loopState = createMiningLoopStateForTesting();

  await performMiningCycleForTesting({
    dataDir: homeDirectory,
    databasePath: `${homeDirectory}/client.sqlite`,
    provider,
    paths,
    runMode: "foreground",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    openReadContext: async () => createReadyMiningReadContext({
      readContextOverrides: {
        snapshot: {
          tip: {
            height: 99,
            blockHashHex: "10".repeat(32),
            previousHashHex: "00".repeat(32),
            stateHashHex: null,
          },
          state: {
            consensus: {
              domainIdsByName: new Map(),
              domainsById: new Map(),
              balances: new Map(),
            },
            history: {
              foundingMessageByDomain: new Map(),
              blockWinnersByHeight: new Map(),
            },
          },
        },
        indexer: {
          health: "synced",
          message: null,
          status: {
            state: "synced",
            heartbeatAtUnixMs: 1_000,
            updatedAtUnixMs: 1_100,
            ipcReady: true,
            rpcReachable: true,
            coreBestHeight: 100,
            coreBestHash: "11".repeat(32),
            appliedTipHeight: 99,
            appliedTipHash: "10".repeat(32),
            reorgDepth: null,
          },
          source: "lease",
          daemonInstanceId: "daemon-1",
          snapshotSeq: "seq-99",
          openedAtUnixMs: 900,
          snapshotTip: {
            height: 99,
            blockHashHex: "10".repeat(32),
            previousHashHex: "00".repeat(32),
            stateHashHex: null,
          },
        },
      },
    }),
    attachService: async () => ({ rpc: {} } as any),
    rpcFactory: () => createHealthyMiningRpc() as any,
    loopState,
  });

  const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(snapshot?.currentPhase, "waiting-indexer");
  assert.equal(snapshot?.readinessBlocker, "tip-alignment");
  assert.equal(snapshot?.note, "Mining is waiting for Bitcoin Core and the indexer to align.");
});

test("performMiningCycle continues after auto-clearing an empty repair-required mining publish", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-auto-clear-empty-repair");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  await provider.storeSecret(createWalletSecretReference("wallet-root").keyId, Buffer.alloc(32, 9));
  const loopState = createMiningLoopStateForTesting();
  const miningState = createRepairRequiredMiningState({
    currentTxid: null,
    currentPublishState: "broadcast-unknown",
    currentPublishDecision: "repair-required-broadcast-conflict",
  });

  await performMiningCycleForTesting({
    dataDir: homeDirectory,
    databasePath: `${homeDirectory}/client.sqlite`,
    provider,
    paths,
    runMode: "foreground",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    openReadContext: async () => createReadyMiningReadContext({
      miningState,
      readContextOverrides: {
        model: {
          walletScriptPubKeyHex: "0014" + "11".repeat(20),
          domains: [],
        },
      },
    }),
    attachService: async () => ({
      rpc: {},
      pid: 9_001,
      refreshServiceStatus: async () => ({
        serviceInstanceId: "svc-1",
        processId: 9_001,
      }),
    }) as any,
    rpcFactory: () => createHealthyMiningRpc() as any,
    loopState,
  });

  const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(snapshot?.miningState, "idle");
  assert.equal(snapshot?.currentPhase, "idle");
  assert.equal(snapshot?.currentPublishState, "none");
  assert.equal(snapshot?.currentTxid, null);
  assert.equal(snapshot?.note, "No locally controlled anchored root domains are currently eligible to mine.");
  assert.notEqual(snapshot?.note, "Mining is blocked until the current mining publish is repaired or reconciled.");
});

test("performMiningCycle keeps blocking when repair-required mining conflict is still unconfirmed", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-unconfirmed-conflict-blocked");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  await provider.storeSecret(createWalletSecretReference("wallet-root").keyId, Buffer.alloc(32, 9));
  const loopState = createMiningLoopStateForTesting();
  const txid = "aa".repeat(32);
  const conflictTxid = "cc".repeat(32);

  await performMiningCycleForTesting({
    dataDir: homeDirectory,
    databasePath: `${homeDirectory}/client.sqlite`,
    provider,
    paths,
    runMode: "foreground",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    openReadContext: async () => createReadyMiningReadContext({
      miningState: createRepairRequiredMiningState({
        currentTxid: txid,
        currentPublishState: "in-mempool",
      }),
    }),
    attachService: async () => ({
      rpc: {},
      pid: 9_001,
      refreshServiceStatus: async () => ({
        serviceInstanceId: "svc-1",
        processId: 9_001,
      }),
    }) as any,
    rpcFactory: () => createHealthyMiningRpc({
      async getRawMempoolVerbose() {
        return {
          txids: [],
          mempool_sequence: "seq-1",
        };
      },
      async getTransaction(_walletName: string, requestedTxid: string) {
        return {
          txid: requestedTxid,
          confirmations: 0,
          walletconflicts: requestedTxid === txid ? [conflictTxid] : [],
        };
      },
    }) as any,
    loopState,
  });

  const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(snapshot?.miningState, "repair-required");
  assert.equal(snapshot?.currentPhase, "waiting");
  assert.equal(snapshot?.currentPublishState, "in-mempool");
  assert.equal(snapshot?.currentTxid, txid);
  assert.equal(snapshot?.currentPublishDecision, "repair-required-wallet-conflict");
  assert.equal(snapshot?.pauseReason, "wallet-conflict-observed");
  assert.equal(snapshot?.note, "Mining is blocked until the current mining publish is repaired or reconciled.");
});

test("performMiningCycle waits instead of throwing on recoverable managed Bitcoin RPC failures", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-rpc-recovery");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const loopState = createMiningLoopStateForTesting();
  const failureMessage = createManagedBitcoindTimeoutMessage();
  let attachCalls = 0;
  let probeCalls = 0;
  let stopCalls = 0;

  await assert.doesNotReject(async () => {
    await performMiningCycleForTesting({
      dataDir: homeDirectory,
      databasePath: `${homeDirectory}/client.sqlite`,
      provider,
      paths,
      runMode: "foreground",
      backgroundWorkerPid: null,
      backgroundWorkerRunId: null,
      openReadContext: async () => createRecoveryReadContext(),
      attachService: async () => {
        attachCalls += 1;
        return {
          rpc: {},
          pid: 9_001,
          refreshServiceStatus: async () => ({
            serviceInstanceId: "svc-1",
            processId: 9_001,
          }),
        } as any;
      },
      probeService: async () => {
        probeCalls += 1;
        return {
          compatibility: "compatible",
          status: {
            serviceInstanceId: "svc-1",
            processId: 9_001,
          },
          error: null,
        } as any;
      },
      stopService: async () => {
        stopCalls += 1;
        return {
          status: "not-running",
          walletRootId: "wallet-root",
        } as any;
      },
      rpcFactory: () => createHealthyMiningRpc({
        async getBlockchainInfo() {
          throw new Error(failureMessage);
        },
      }) as any,
      loopState,
      nowImpl: () => 1_000,
    });
  });

  const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(snapshot?.currentPhase, "waiting-bitcoin-network");
  assert.equal(snapshot?.lastError, failureMessage);
  assert.equal(
    snapshot?.note,
    "Mining lost contact with the local Bitcoin RPC service and is waiting for it to recover.",
  );
  assert.equal(loopState.attemptedTipKey, null);
  assert.equal(attachCalls, 1);
  assert.equal(probeCalls, 1);
  assert.equal(stopCalls, 0);
});

test("performMiningCycle waits while managed bitcoind is warming up", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-bitcoind-warmup");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const loopState = createMiningLoopStateForTesting();
  let probeCalls = 0;
  let stopCalls = 0;

  await assert.doesNotReject(async () => {
    await performMiningCycleForTesting({
      dataDir: homeDirectory,
      databasePath: `${homeDirectory}/client.sqlite`,
      provider,
      paths,
      runMode: "foreground",
      backgroundWorkerPid: null,
      backgroundWorkerRunId: null,
      openReadContext: async () => createRecoveryReadContext(),
      attachService: async () => {
        throw new Error("managed_bitcoind_service_starting");
      },
      probeService: async () => {
        probeCalls += 1;
        return {
          compatibility: "starting",
          status: {
            serviceInstanceId: "svc-starting",
            processId: process.pid,
          },
          error: "bitcoind_rpc_getblockchaininfo_-28_Loading block index…",
        } as any;
      },
      stopService: async () => {
        stopCalls += 1;
        return {
          status: "stopped",
          walletRootId: "wallet-root",
        } as any;
      },
      rpcFactory: () => {
        throw new Error("rpcFactory should not be used when bitcoind is warming");
      },
      loopState,
      nowImpl: () => 1_000,
    });
  });

  const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(snapshot?.currentPhase, "waiting-bitcoin-network");
  assert.equal(snapshot?.lastError, "managed_bitcoind_service_starting");
  assert.equal(
    snapshot?.note,
    "Mining lost contact with the local Bitcoin RPC service and is waiting for it to recover.",
  );
  assert.equal(probeCalls, 1);
  assert.equal(stopCalls, 0);
});

test("performMiningCycle waits through the live-pid grace window and throttles managed bitcoind restarts", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-rpc-grace");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const loopState = createMiningLoopStateForTesting();
  let attachCalls = 0;
  let stopCalls = 0;

  const runCycle = async (nowUnixMs: number) => {
    await performMiningCycleForTesting({
      dataDir: homeDirectory,
      databasePath: `${homeDirectory}/client.sqlite`,
      provider,
      paths,
      runMode: "foreground",
      backgroundWorkerPid: null,
      backgroundWorkerRunId: null,
      openReadContext: async () => createRecoveryReadContext(),
      attachService: async () => {
        attachCalls += 1;
        throw new Error("managed_bitcoind_service_start_timeout");
      },
      probeService: async () => ({
        compatibility: "unreachable",
        status: {
          serviceInstanceId: "svc-1",
          processId: process.pid,
        },
        error: null,
      }) as any,
      stopService: async () => {
        stopCalls += 1;
        return {
          status: "stopped",
          walletRootId: "wallet-root",
        } as any;
      },
      rpcFactory: () => {
        throw new Error("rpcFactory should not be used when attachService fails");
      },
      loopState,
      nowImpl: () => nowUnixMs,
    });
  };

  await runCycle(1_000);
  assert.equal(stopCalls, 0);

  await runCycle(10_000);
  assert.equal(stopCalls, 0);

  await runCycle(17_000);
  assert.equal(stopCalls, 1);

  await runCycle(20_000);
  assert.equal(stopCalls, 1);
  assert.equal(attachCalls, 5);
});

test("performMiningCycle immediately reattaches managed bitcoind when no live pid remains", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-rpc-reattach");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const loopState = createMiningLoopStateForTesting();
  const candidate = createTestMiningCandidate();
  let attachCalls = 0;
  let stopCalls = 0;

  cacheSelectedCandidateForTipForTesting(loopState, "tip-1", candidate);

  await performMiningCycleForTesting({
    dataDir: homeDirectory,
    databasePath: `${homeDirectory}/client.sqlite`,
    provider,
    paths,
    runMode: "foreground",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    openReadContext: async () => createRecoveryReadContext(),
    attachService: async () => {
      attachCalls += 1;
      if (attachCalls === 1) {
        throw new Error("managed_bitcoind_service_start_timeout");
      }

      return {
        rpc: {},
        pid: 9_002,
        refreshServiceStatus: async () => ({
          serviceInstanceId: "svc-2",
          processId: 9_002,
        }),
      } as any;
    },
    probeService: async () => ({
      compatibility: "unreachable",
      status: {
        serviceInstanceId: "svc-1",
        processId: null,
      },
      error: null,
    }) as any,
    stopService: async () => {
      stopCalls += 1;
      return {
        status: "not-running",
        walletRootId: "wallet-root",
      } as any;
    },
    rpcFactory: () => {
      throw new Error("rpcFactory should not be used when attachService fails");
    },
    loopState,
    nowImpl: () => 1_000,
  });

  const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(snapshot?.currentPhase, "waiting-bitcoin-network");
  assert.equal(attachCalls, 2);
  assert.equal(stopCalls, 0);
  assert.equal(snapshot?.reconnectSettledUntilUnixMs, 1_000 + MINING_NETWORK_SETTLE_WINDOW_MS);
  assert.equal(getSelectedCandidateForTipForTesting(loopState, "tip-1"), null);
  assert.deepEqual(loopState.ui.provisionalRequiredWords, []);
  assert.deepEqual(loopState.ui.provisionalEntry, {
    domainName: null,
    sentence: null,
  });
  assert.equal(loopState.ui.latestSentence, null);
});

test("performMiningCycle clears transient recovery errors once Bitcoin RPC recovers", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-rpc-clear");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const loopState = createMiningLoopStateForTesting();
  const failureMessage = createManagedBitcoindTimeoutMessage();

  await performMiningCycleForTesting({
    dataDir: homeDirectory,
    databasePath: `${homeDirectory}/client.sqlite`,
    provider,
    paths,
    runMode: "foreground",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    openReadContext: async () => createRecoveryReadContext(),
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
    stopService: async () => ({
      status: "not-running",
      walletRootId: "wallet-root",
    }) as any,
    rpcFactory: () => createHealthyMiningRpc({
      async getBlockchainInfo() {
        throw new Error(failureMessage);
      },
    }) as any,
    loopState,
    nowImpl: () => 1_000,
  });

  await performMiningCycleForTesting({
    dataDir: homeDirectory,
    databasePath: `${homeDirectory}/client.sqlite`,
    provider,
    paths,
    runMode: "foreground",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    openReadContext: async () => createRecoveryReadContext({
      indexer: {
        health: "catching-up",
        message: "Indexer daemon is still catching up to the managed Bitcoin tip.",
        status: null,
        source: "lease",
        daemonInstanceId: "daemon-1",
        snapshotSeq: "seq-100",
        openedAtUnixMs: 2,
        snapshotTip: null,
      },
    }),
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
    stopService: async () => ({
      status: "not-running",
      walletRootId: "wallet-root",
    }) as any,
    rpcFactory: () => createHealthyMiningRpc() as any,
    loopState,
    nowImpl: () => 2_000,
  });

  const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(snapshot?.currentPhase, "waiting-indexer");
  assert.equal(snapshot?.lastError, null);
  assert.equal(snapshot?.readinessBlocker, "indexer-daemon");
  assert.equal(snapshot?.note, "Mining is waiting for managed indexer readiness.");
});

test("performMiningCycle does not downgrade a tolerated 2-block header lead into waiting-bitcoin-network", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-header-lead-tolerated");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const loopState = createMiningLoopStateForTesting() as any;
  loopState.providerWaitState = "backoff";
  loopState.providerWaitLastError = "provider temporarily unavailable";
  loopState.providerWaitNextRetryAtUnixMs = 31_000;

  await performMiningCycleForTesting({
    dataDir: homeDirectory,
    databasePath: `${homeDirectory}/client.sqlite`,
    provider,
    paths,
    runMode: "foreground",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    openReadContext: async () => createRecoveryReadContext({
      model: {
        walletScriptPubKeyHex: "0014" + "11".repeat(20),
        domains: [{
          name: "cogdemo",
          anchored: true,
          readOnly: false,
          localRelationship: "local",
          domainId: 7,
          ownerAddress: "bc1qfunding",
          ownerScriptPubKeyHex: "0014" + "11".repeat(20),
        }],
      },
      nodeHealth: "synced",
      nodeMessage: "Bitcoin headers can briefly lead validated blocks; a short 1-2 block lead is normal and is being tolerated.",
      nodeStatus: {
        chain: "mainnet",
        nodeBestHeight: 100,
        nodeBestHashHex: "11".repeat(32),
        nodeHeaderHeight: 102,
        walletReplica: {
          proofStatus: "ready",
        },
        serviceStatus: {
          serviceInstanceId: "svc-1",
          processId: 9_001,
        },
      },
    }),
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
    stopService: async () => ({
      status: "not-running",
      walletRootId: "wallet-root",
    }) as any,
    rpcFactory: () => createHealthyMiningRpc() as any,
    loopState,
    nowImpl: () => 1_000,
  });

  const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(snapshot?.currentPhase, "waiting-provider");
  assert.equal(snapshot?.providerState, "backoff");
  assert.equal(
    snapshot?.note,
    "Mining is waiting because the sentence provider had a transient failure and will be retried automatically.",
  );
});

test("performMiningCycle still blocks mining on a 3-block header lead", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-header-lead-catching-up");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const loopState = createMiningLoopStateForTesting() as any;
  loopState.providerWaitState = "backoff";
  loopState.providerWaitLastError = "provider temporarily unavailable";
  loopState.providerWaitNextRetryAtUnixMs = 31_000;

  await performMiningCycleForTesting({
    dataDir: homeDirectory,
    databasePath: `${homeDirectory}/client.sqlite`,
    provider,
    paths,
    runMode: "foreground",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    openReadContext: async () => createRecoveryReadContext({
      nodeHealth: "catching-up",
      nodeMessage: "Bitcoin Core is still catching up to headers.",
      nodeStatus: {
        chain: "mainnet",
        nodeBestHeight: 100,
        nodeBestHashHex: "11".repeat(32),
        nodeHeaderHeight: 103,
        walletReplica: {
          proofStatus: "ready",
        },
        serviceStatus: {
          serviceInstanceId: "svc-1",
          processId: 9_001,
        },
      },
    }),
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
    stopService: async () => ({
      status: "not-running",
      walletRootId: "wallet-root",
    }) as any,
    rpcFactory: () => createHealthyMiningRpc() as any,
    loopState,
    nowImpl: () => 1_000,
  });

  const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(snapshot?.currentPhase, "waiting-bitcoin-network");
  assert.equal(snapshot?.note, "Mining is waiting for the local Bitcoin node to become publishable.");
});

test("performMiningCycle pauses before generation when mining funding is insufficient", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-funding-gate");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const loopState = createMiningLoopStateForTesting();
  let generateCalls = 0;

  await performMiningCycleForTesting({
    dataDir: homeDirectory,
    databasePath: `${homeDirectory}/client.sqlite`,
    provider,
    paths,
    runMode: "foreground",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    openReadContext: async () => createProviderRetryReadContext(),
    attachService: async () => ({ rpc: {}, pid: 9_001 }) as any,
    rpcFactory: () => createHealthyMiningRpc({
      async walletCreateFundedPsbt() {
        throw new Error("bitcoind_rpc_walletcreatefundedpsbt_-4_Insufficient funds");
      },
    }) as any,
    loopState,
    nowImpl: () => 1_000,
    generateCandidatesForDomainsImpl: async () => {
      generateCalls += 1;
      return [createTestMiningCandidate()];
    },
  });

  const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(generateCalls, 0);
  assert.equal(loopState.attemptedTipKey, null);
  assert.equal(snapshot?.currentPhase, "waiting");
  assert.equal(snapshot?.currentPublishDecision, "publish-paused-insufficient-funds");
  assert.equal(snapshot?.note, "Insufficient BTC to mine.");
  assert.equal(snapshot?.lastError, "Bitcoin Core could not fund the next mining publish with safe BTC.");
});

test("performMiningCycle keeps current target fields after no-candidate skip with stale live publish", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-no-candidate-current-target");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const loopState = createMiningLoopStateForTesting();
  const oldHashHex = "11".repeat(32);
  const freshHashHex = "22".repeat(32);
  const liveTxid = "aa".repeat(32);
  const readContext = createReadyMiningReadContext({
    miningState: createMiningState({
      runMode: "foreground",
      state: "paused-stale",
      pauseReason: "stale-block-context",
      currentPublishState: "in-mempool",
      currentDomain: "cogdemo",
      currentDomainId: 7,
      currentSentence: "old tip sentence",
      currentScore: "1000",
      currentTxid: liveTxid,
      currentWtxid: "bb".repeat(32),
      currentBlockTargetHeight: 101,
      currentReferencedBlockHashDisplay: oldHashHex,
      livePublishInMempool: true,
      currentPublishDecision: "paused-stale-mempool",
    }),
  });
  readContext.dataDir = homeDirectory;
  readContext.databasePath = `${homeDirectory}/client.sqlite`;
  readContext.nodeStatus = {
    chain: "mainnet",
    nodeBestHeight: 101,
    nodeBestHashHex: freshHashHex,
    walletReplica: {
      proofStatus: "ready",
    },
    serviceStatus: {
      serviceInstanceId: "svc-1",
      processId: 9_001,
    },
  } as any;
  readContext.indexer = {
    ...readContext.indexer,
    health: "synced",
    message: null,
    status: {
      state: "synced",
      heartbeatAtUnixMs: 1,
      updatedAtUnixMs: 1,
      ipcReady: true,
      rpcReachable: true,
      coreBestHeight: 101,
      coreBestHash: freshHashHex,
      appliedTipHeight: 101,
      appliedTipHash: freshHashHex,
      reorgDepth: null,
    },
    source: "lease",
    daemonInstanceId: "daemon-1",
    snapshotSeq: "seq-101",
    openedAtUnixMs: 1,
    snapshotTip: {
      height: 101,
      blockHashHex: freshHashHex,
      previousHashHex: oldHashHex,
      stateHashHex: null,
    },
  };
  readContext.snapshot = {
    ...readContext.snapshot,
    daemonInstanceId: "daemon-1",
    snapshotSeq: "seq-101",
    openedAtUnixMs: 1,
    tip: {
      height: 101,
      blockHashHex: freshHashHex,
      previousHashHex: oldHashHex,
      stateHashHex: null,
    },
  };

  await performMiningCycleForTesting({
    dataDir: homeDirectory,
    databasePath: `${homeDirectory}/client.sqlite`,
    provider,
    paths,
    runMode: "foreground",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    openReadContext: async () => readContext,
    attachService: async () => ({ rpc: {}, pid: 9_001 }) as any,
    rpcFactory: () => createHealthyMiningRpc({
      async getBlockchainInfo() {
        return {
          blocks: 101,
          bestblockhash: freshHashHex,
          initialblockdownload: false,
        };
      },
      async getRawMempoolVerbose() {
        return {
          txids: [liveTxid],
          mempool_sequence: "seq-live",
        };
      },
      async getTransaction() {
        return {
          confirmations: 0,
          walletconflicts: [],
        };
      },
    }) as any,
    loopState,
    nowImpl: () => 1_000,
    generateCandidatesForDomainsImpl: async () => [],
  });

  const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(snapshot?.currentPhase, "idle");
  assert.equal(snapshot?.currentPublishDecision, "publish-skipped-no-candidate");
  assert.equal(snapshot?.targetBlockHeight, 102);
  assert.equal(snapshot?.referencedBlockHashDisplay, freshHashHex);
  assert.equal(snapshot?.attemptTargetBlockHeight, 102);
  assert.equal(snapshot?.attemptReferencedBlockHashDisplay, freshHashHex);
  assert.equal(snapshot?.attemptIndexerSnapshotSeq, "seq-101");
  assert.equal(snapshot?.livePublishTargetBlockHeight, 101);
  assert.equal(snapshot?.livePublishReferencedBlockHashDisplay, oldHashHex);
  assert.equal(snapshot?.livePublishTxid, liveTxid);
  assert.equal(snapshot?.livePublishDecision, "paused-stale-mempool");
  assert.equal(snapshot?.livePublishStaleToCoreTip, true);
});

test("performMiningCycle keeps the insufficient-funding blocker active across repeated cycles", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-funding-gate-repeat");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const loopState = createMiningLoopStateForTesting();
  let generateCalls = 0;

  const runCycle = async (nowUnixMs: number) => {
    await performMiningCycleForTesting({
      dataDir: homeDirectory,
      databasePath: `${homeDirectory}/client.sqlite`,
      provider,
      paths,
      runMode: "foreground",
      backgroundWorkerPid: null,
      backgroundWorkerRunId: null,
      openReadContext: async () => createProviderRetryReadContext(),
      attachService: async () => ({ rpc: {}, pid: 9_001 }) as any,
      rpcFactory: () => createHealthyMiningRpc({
        async walletCreateFundedPsbt() {
          throw new Error("bitcoind_rpc_walletcreatefundedpsbt_-4_Insufficient funds");
        },
      }) as any,
      loopState,
      nowImpl: () => nowUnixMs,
      generateCandidatesForDomainsImpl: async () => {
        generateCalls += 1;
        return [createTestMiningCandidate()];
      },
    });
  };

  await runCycle(1_000);
  await runCycle(2_000);

  const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(generateCalls, 0);
  assert.equal(loopState.attemptedTipKey, null);
  assert.equal(snapshot?.currentPhase, "waiting");
  assert.equal(snapshot?.currentPublishDecision, "publish-paused-insufficient-funds");
  assert.equal(snapshot?.note, "Insufficient BTC to mine.");
  assert.equal(snapshot?.lastError, "Bitcoin Core could not fund the next mining publish with safe BTC.");
});

test("performMiningCycle persists competitiveness gate diagnostics on indeterminate skips", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-gate-diagnostics");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const loopState = createMiningLoopStateForTesting();
  const readContext = createProviderRetryReadContext();
  readContext.dataDir = homeDirectory;
  readContext.databasePath = `${homeDirectory}/client.sqlite`;
  readContext.snapshot.daemonInstanceId = "daemon-1";
  readContext.snapshot.snapshotSeq = "seq-100";
  const diagnostics = {
    visibleMempoolTxCount: 12,
    indexedContextCount: 9,
    negativeTxCount: 2,
    unknownTxCount: 3,
    hydratedTxCount: 7,
    mempoolEntryCount: 8,
    missingEntryCount: 1,
    cacheStatus: "index-warming" as const,
    mempoolSequence: "seq-42",
    candidateRank: null,
    higherRankedCompetitorDomainCount: 0,
    dedupedCompetitorDomainCount: 0,
  };

  await startFakeIndexerDaemonStatusServer(t, {
    dataDir: homeDirectory,
    walletRootId: readContext.localState.state.walletRootId,
    daemonInstanceId: "daemon-1",
    snapshotSeq: "seq-100",
  });

  await performMiningCycleForTesting({
    dataDir: homeDirectory,
    databasePath: `${homeDirectory}/client.sqlite`,
    provider,
    paths,
    runMode: "foreground",
    foregroundRunId: "run-1",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: "run-1",
    openReadContext: async () => readContext,
    attachService: async () => ({ rpc: {}, pid: 9_001 }) as any,
    rpcFactory: () => createHealthyMiningRpc() as any,
    loopState,
    nowImpl: () => 10_000,
    generateCandidatesForDomainsImpl: async () => [createTestMiningCandidate()],
    runCompetitivenessGateImpl: async () => ({
      allowed: false,
      decision: "indeterminate-mempool-gate",
      sameDomainCompetitorSuppressed: false,
      higherRankedCompetitorDomainCount: 0,
      dedupedCompetitorDomainCount: 0,
      competitivenessGateIndeterminate: true,
      indeterminateReason: "mempool_index_hydration_incomplete",
      diagnostics,
      mempoolSequenceCacheStatus: "index-warming",
      lastMempoolSequence: "seq-42",
      visibleBoardEntries: [],
      candidateRank: null,
    }),
  });

  const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  const events = await readMiningEvents({
    eventsPath: paths.miningEventsPath,
    all: true,
  });
  const skippedEvent = events.find((event) => event.kind === "publish-skipped-gate-indeterminate") ?? null;

  assert.equal(snapshot?.currentPhase, "waiting");
  assert.equal(snapshot?.currentPublishDecision, "indeterminate-mempool-gate");
  assert.equal(snapshot?.competitivenessGateReason, "mempool_index_hydration_incomplete");
  assert.deepEqual(snapshot?.competitivenessGateDiagnostics, diagnostics);
  assert.equal(snapshot?.lastCompetitivenessGateAtUnixMs, 10_000);
  assert.equal(snapshot?.lastMempoolSequence, "seq-42");
  assert.equal(snapshot?.mempoolSequenceCacheStatus, "index-warming");
  assert.match(
    snapshot?.note ?? "",
    /mempool competitiveness gate could not be verified safely \(mempool_index_hydration_incomplete\)/,
  );
  assert.notEqual(skippedEvent, null);
  assert.equal(skippedEvent?.reason, "mempool_index_hydration_incomplete");
  assert.match(skippedEvent?.message ?? "", /visible=12/);
  assert.match(skippedEvent?.message ?? "", /missingEntries=1/);
  assert.equal(events.some((event) =>
    event.kind === "timing-mempool-gate-start"
    && event.runId === "run-1"
    && event.metrics?.outcome === "started"
  ), true);
  assert.equal(events.some((event) =>
    event.kind === "timing-mempool-gate-end"
    && event.runId === "run-1"
    && event.metrics?.outcome === "success"
    && event.metrics?.allowed === false
    && event.metrics?.decision === "indeterminate-mempool-gate"
    && event.durationMs !== undefined
  ), true);
});

test("pre-publish status overrides clear stale competitiveness gate diagnostics", () => {
  const state = createWalletState({
    miningState: createMiningState({
      livePublishInMempool: false,
    }),
  });
  const selectedCandidate = createTestMiningCandidate();

  const overrides = buildPrePublishStatusOverridesForTesting({
    state,
    candidate: selectedCandidate,
  });

  assert.equal(overrides.competitivenessGateReason, null);
  assert.equal(overrides.competitivenessGateDiagnostics, null);
});

test("performMiningCycle retries managed Core wallet relocks on later ticks without regenerating candidates", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-managed-core-relock-cycle");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const loopState = createMiningLoopStateForTesting();
  const readContextOverrides = {
    dataDir: homeDirectory,
    databasePath: `${homeDirectory}/client.sqlite`,
    snapshot: {
      daemonInstanceId: "daemon-1",
      snapshotSeq: "seq-100",
      tip: {
        height: 100,
        blockHashHex: "11".repeat(32),
        previousHashHex: "00".repeat(32),
        stateHashHex: null,
      },
      state: {
        consensus: {
          domainIdsByName: new Map([["cogdemo", 7]]),
          domainsById: new Map([[7, {
            domainId: 7,
            name: "cogdemo",
            anchored: true,
            anchorHeight: 100,
            ownerScriptPubKey: Buffer.from("0014" + "11".repeat(20), "hex"),
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
        stateHashHex: null,
      },
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
    nodeHealth: "synced",
  };
  const readContext = createReadyMiningReadContext({
    miningState: createMiningState({
      livePublishInMempool: false,
    }),
    readContextOverrides,
  });
  const publishableSentence = "a".repeat(60);
  const candidate = createTestMiningCandidate({
    sentence: publishableSentence,
    encodedSentenceBytes: Buffer.from(publishableSentence, "utf8"),
  });
  let generateCalls = 0;
  let gateCalls = 0;
  let walletPassphraseCalls = 0;
  let walletProcessPsbtCalls = 0;
  let walletLockCalls = 0;

  await startFakeIndexerDaemonStatusServer(t, {
    dataDir: homeDirectory,
    walletRootId: readContext.localState.state.walletRootId,
    daemonInstanceId: "daemon-1",
    snapshotSeq: "seq-100",
  });

  await provider.storeSecret(
    createWalletSecretReference(readContext.localState.state.walletRootId).keyId,
    new Uint8Array(32).fill(7),
  );

  const runCycle = async (nowUnixMs: number) => {
    await performMiningCycleForTesting({
      dataDir: homeDirectory,
      databasePath: `${homeDirectory}/client.sqlite`,
      provider,
      paths,
      runMode: "foreground",
      backgroundWorkerPid: null,
      backgroundWorkerRunId: null,
      openReadContext: async () => createReadyMiningReadContext({
        miningState: createMiningState({
          livePublishInMempool: false,
        }),
        readContextOverrides,
      }),
      attachService: async () => ({ rpc: {}, pid: 9_001 }) as any,
      rpcFactory: () => createHealthyMiningRpc({
        async walletPassphrase() {
          walletPassphraseCalls += 1;
          return null;
        },
        async walletProcessPsbt() {
          walletProcessPsbtCalls += 1;
          if (walletProcessPsbtCalls <= 4) {
            throw new Error(MANAGED_CORE_WALLET_LOCKED_ERROR);
          }

          return {
            psbt: "signed-psbt",
            complete: true,
          };
        },
        async walletLock() {
          walletLockCalls += 1;
          return null;
        },
        async finalizePsbt() {
          return {
            complete: true,
            hex: "raw-hex",
          };
        },
        async decodeRawTransaction() {
          return {
            txid: "bb".repeat(32),
            hash: "cc".repeat(32),
          } as never;
        },
        async testMempoolAccept() {
          return [{ allowed: true }];
        },
        async sendRawTransaction() {
          return "bb".repeat(32);
        },
      }, {
        fundingScriptPubKeyHex: readContext.localState.state.funding.scriptPubKeyHex,
      }) as any,
      loopState,
      nowImpl: () => nowUnixMs,
      generateCandidatesForDomainsImpl: async () => {
        generateCalls += 1;
        return [candidate];
      },
      runCompetitivenessGateImpl: async () => {
        gateCalls += 1;
        return {
          allowed: true,
          decision: "allowed",
          sameDomainCompetitorSuppressed: false,
          higherRankedCompetitorDomainCount: 0,
          dedupedCompetitorDomainCount: 0,
          competitivenessGateIndeterminate: false,
          mempoolSequenceCacheStatus: null,
          lastMempoolSequence: null,
          visibleBoardEntries: [],
          candidateRank: 1,
        } as any;
      },
    });
  };

  await runCycle(1_000);
  let snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(snapshot?.currentPhase, "waiting");
  assert.equal(snapshot?.currentPublishDecision, "publish-retry-pending");
  assert.equal(snapshot?.note, "Mining temporarily lost the managed Bitcoin wallet unlock and is retrying.");
  assert.equal(snapshot?.lastError, MANAGED_CORE_WALLET_LOCKED_ERROR);
  assert.equal(generateCalls, 1);
  assert.equal(gateCalls, 1);

  await runCycle(2_000);
  snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(snapshot?.currentPhase, "waiting");
  assert.equal(snapshot?.currentPublishDecision, "publish-retry-pending");
  assert.equal(snapshot?.note, "Mining temporarily lost the managed Bitcoin wallet unlock and is retrying.");
  assert.equal(snapshot?.lastError, MANAGED_CORE_WALLET_LOCKED_ERROR);
  assert.equal(generateCalls, 1);
  assert.equal(gateCalls, 1);

  await runCycle(3_000);
  snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(snapshot?.currentPhase, "waiting");
  assert.equal(snapshot?.currentPublishDecision, "broadcast");
  assert.equal(snapshot?.lastError, null);
  assert.match(snapshot?.note ?? "", /Waiting for the next block/i);
  assert.equal(generateCalls, 1);
  assert.equal(gateCalls, 1);
  assert.equal(walletPassphraseCalls, 5);
  assert.equal(walletProcessPsbtCalls, 5);
  assert.equal(walletLockCalls, 3);
});

test("performMiningCycle backs off transient provider failures and retries without marking the tip attempted", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-provider-backoff");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const loopState = createMiningLoopStateForTesting();
  const timeoutMessage = "The built-in OpenAI mining provider timed out after 30 seconds.";
  let generateCalls = 0;

  const runCycle = async (nowUnixMs: number) => {
    await performMiningCycleForTesting({
      dataDir: homeDirectory,
      databasePath: `${homeDirectory}/client.sqlite`,
      provider,
      paths,
      runMode: "foreground",
      backgroundWorkerPid: null,
      backgroundWorkerRunId: null,
      openReadContext: async () => createProviderRetryReadContext(),
      attachService: async () => ({ rpc: {}, pid: 9_001 }) as any,
      rpcFactory: () => createHealthyMiningRpc() as any,
      loopState,
      nowImpl: () => nowUnixMs,
      generateCandidatesForDomainsImpl: async () => {
        generateCalls += 1;
        if (generateCalls === 1) {
          throw new MiningProviderRequestError("unavailable", timeoutMessage);
        }
        return [createTestMiningCandidate()];
      },
      runCompetitivenessGateImpl: async () => ({
        allowed: false,
        decision: "indeterminate-mempool-gate",
        sameDomainCompetitorSuppressed: false,
        higherRankedCompetitorDomainCount: 0,
        dedupedCompetitorDomainCount: 0,
        competitivenessGateIndeterminate: true,
        mempoolSequenceCacheStatus: null,
        lastMempoolSequence: null,
        visibleBoardEntries: [],
        candidateRank: null,
      }) as any,
    });
  };

  await runCycle(1_000);
  let snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(snapshot?.currentPhase, "waiting-provider");
  assert.equal(snapshot?.providerState, "backoff");
  assert.equal(snapshot?.lastError, timeoutMessage);
  assert.equal(
    snapshot?.note,
    "Mining is waiting because the sentence provider had a transient failure and will be retried automatically.",
  );
  assert.equal(loopState.attemptedTipKey, null);
  assert.equal(loopState.providerTransientFailureCount, 1);
  assert.equal(loopState.providerWaitNextRetryAtUnixMs, 31_000);
  assert.equal(generateCalls, 1);

  await runCycle(30_000);
  snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(snapshot?.currentPhase, "waiting-provider");
  assert.equal(snapshot?.providerState, "backoff");
  assert.equal(snapshot?.lastError, timeoutMessage);
  assert.equal(
    snapshot?.note,
    "Mining is waiting because the sentence provider had a transient failure and will be retried automatically.",
  );
  assert.equal(generateCalls, 1);

  await runCycle(31_000);
  snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(snapshot?.currentPhase, "scoring");
  assert.equal(snapshot?.currentPublishDecision, null);
  assert.equal(snapshot?.providerState, "unavailable");
  assert.equal(snapshot?.lastError, null);
  assert.equal(snapshot?.note, "Scoring mining candidates for the current tip.");
  assert.equal(loopState.providerTransientFailureCount, 0);
  assert.equal(loopState.providerWaitNextRetryAtUnixMs, null);
  assert.equal(generateCalls, 2);
});

test("performMiningCycle exponentially backs off repeated transient provider failures and preserves rate-limited state", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-provider-backoff-scale");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const loopState = createMiningLoopStateForTesting();
  const retryTimes = [1_000, 31_000, 91_000, 211_000, 451_000, 931_000, 1_831_000];
  const expectedNextRetryTimes = [31_000, 91_000, 211_000, 451_000, 931_000, 1_831_000, 2_731_000];
  let generateCalls = 0;

  for (const [index, nowUnixMs] of retryTimes.entries()) {
    await performMiningCycleForTesting({
      dataDir: homeDirectory,
      databasePath: `${homeDirectory}/client.sqlite`,
      provider,
      paths,
      runMode: "foreground",
      backgroundWorkerPid: null,
      backgroundWorkerRunId: null,
      openReadContext: async () => createProviderRetryReadContext(),
      attachService: async () => ({ rpc: {}, pid: 9_001 }) as any,
      rpcFactory: () => createHealthyMiningRpc() as any,
      loopState,
      nowImpl: () => nowUnixMs,
      generateCandidatesForDomainsImpl: async () => {
        generateCalls += 1;
        if (generateCalls === 1) {
          throw new MiningProviderRequestError("rate-limited", "The built-in OpenAI mining provider is rate limited.");
        }
        throw new MiningProviderRequestError("unavailable", "The built-in OpenAI mining provider timed out after 30 seconds.");
      },
    });

    const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
    assert.equal(snapshot?.currentPhase, "waiting-provider");
    assert.equal(snapshot?.providerState, index === 0 ? "rate-limited" : "backoff");
    assert.equal(
      snapshot?.note,
      index === 0
        ? "Mining is waiting because the sentence provider is rate limited and will be retried automatically."
        : "Mining is waiting because the sentence provider had a transient failure and will be retried automatically.",
    );
    assert.equal(loopState.providerTransientFailureCount, index + 1);
    assert.equal(loopState.providerWaitNextRetryAtUnixMs, expectedNextRetryTimes[index]);
    assert.equal(loopState.attemptedTipKey, null);
  }
});

test("performMiningCycle keeps auth provider failures on the same-tip provider wait path without backoff", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-provider-auth");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const loopState = createMiningLoopStateForTesting();
  const authMessage = "The built-in OpenAI mining provider rejected the configured API key.";
  let generateCalls = 0;

  const runCycle = async (nowUnixMs: number) => {
    await performMiningCycleForTesting({
      dataDir: homeDirectory,
      databasePath: `${homeDirectory}/client.sqlite`,
      provider,
      paths,
      runMode: "foreground",
      backgroundWorkerPid: null,
      backgroundWorkerRunId: null,
      openReadContext: async () => createProviderRetryReadContext(),
      attachService: async () => ({ rpc: {}, pid: 9_001 }) as any,
      rpcFactory: () => createHealthyMiningRpc() as any,
      loopState,
      nowImpl: () => nowUnixMs,
      generateCandidatesForDomainsImpl: async () => {
        generateCalls += 1;
        throw new MiningProviderRequestError("auth-error", authMessage);
      },
    });
  };

  await runCycle(1_000);
  let snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(snapshot?.currentPhase, "waiting-provider");
  assert.equal(snapshot?.providerState, "auth-error");
  assert.equal(snapshot?.lastError, authMessage);
  assert.equal(
    snapshot?.note,
    "Mining is waiting because the sentence provider rejected the configured API key.",
  );
  assert.equal(loopState.providerWaitNextRetryAtUnixMs, null);
  assert.notEqual(loopState.attemptedTipKey, null);
  assert.equal(generateCalls, 1);

  await runCycle(2_000);
  snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(snapshot?.currentPhase, "waiting-provider");
  assert.equal(snapshot?.providerState, "auth-error");
  assert.equal(snapshot?.lastError, authMessage);
  assert.equal(
    snapshot?.note,
    "Mining is waiting because the sentence provider rejected the configured API key.",
  );
  assert.equal(loopState.providerTransientFailureCount, 0);
  assert.equal(generateCalls, 1);
});

test("performMiningCycle still throws on non-recoverable managed bitcoind mismatches", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-rpc-fatal");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();

  await assert.rejects(
    async () => {
      await performMiningCycleForTesting({
        dataDir: homeDirectory,
        databasePath: `${homeDirectory}/client.sqlite`,
        provider,
        paths,
        runMode: "foreground",
        backgroundWorkerPid: null,
        backgroundWorkerRunId: null,
        openReadContext: async () => createRecoveryReadContext(),
        attachService: async () => {
          throw new Error("managed_bitcoind_runtime_mismatch");
        },
        probeService: async () => {
          throw new Error("probeService should not be reached for fatal mismatches");
        },
        stopService: async () => {
          throw new Error("stopService should not be reached for fatal mismatches");
        },
        rpcFactory: () => {
          throw new Error("rpcFactory should not be used when attachService fails");
        },
      });
    },
    /managed_bitcoind_runtime_mismatch/,
  );
});

test("resume refresh seeds the latest prior non-empty indexed board when the newest tip winners are not ready", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-resume-board");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const priorTipHash = "11".repeat(32);
  const snapshotTipHash = "12".repeat(32);
  let capturedUiState:
    | {
      settledBlockHeight: number | null;
      settledBoardEntries: Array<{ rank: number; domainName: string; sentence: string; requiredWords: readonly string[] }>;
    }
    | null = null;

  await handleDetectedMiningRuntimeResumeForTesting({
    dataDir: homeDirectory,
    databasePath: `${homeDirectory}/client.sqlite`,
    provider,
    paths,
    runMode: "foreground",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    detectedAtUnixMs: 1_700_000_999,
    openReadContext: async () => createReadyMiningReadContext({
      miningState: createMiningState({
        livePublishInMempool: false,
      }),
      readContextOverrides: {
        snapshot: {
          tip: {
            height: 101,
            blockHashHex: snapshotTipHash,
            previousHashHex: priorTipHash,
            stateHashHex: null,
          },
          state: {
            consensus: {
              domainIdsByName: new Map([["cogdemo", 7]]),
              domainsById: new Map([[7, {
                domainId: 7,
                name: "cogdemo",
                anchored: true,
                anchorHeight: 100,
                ownerScriptPubKey: Buffer.from("0014" + "11".repeat(20), "hex"),
                endpoint: null,
              }]]),
              balances: new Map(),
            },
            history: {
              foundingMessageByDomain: new Map(),
              blockWinnersByHeight: new Map([
                [100, [{
                  height: 100,
                  rank: 1,
                  domainId: 7,
                  creditedScriptPubKeyHex: "0014" + "11".repeat(20),
                  rewardCogtoshi: 123_000_000n,
                  canonicalBlend: 1000n,
                  sentenceHex: "",
                  sentenceText: "Indexed settled sentence.",
                  bip39WordIndices: resolveWordIndices(["under", "tree", "monkey", "youth", "basket"]),
                  txIndex: 0,
                  txidHex: "aa".repeat(32),
                }]],
              ]),
            },
          },
        },
        indexer: {
          health: "catching-up",
          message: "Indexer daemon is still catching up to the managed Bitcoin tip.",
          status: null,
          source: "lease",
          daemonInstanceId: "daemon-1",
          snapshotSeq: "seq-101",
          openedAtUnixMs: 1,
          snapshotTip: {
            height: 101,
            blockHashHex: snapshotTipHash,
            previousHashHex: priorTipHash,
            stateHashHex: null,
          },
        },
        nodeStatus: {
          chain: "mainnet",
          nodeBestHeight: 101,
          nodeBestHashHex: "13".repeat(32),
          walletReplica: {
            proofStatus: "ready",
          },
        },
        model: {
          walletScriptPubKeyHex: "0014" + "11".repeat(20),
          domains: [],
        },
      },
    }),
    visualizer: {
      update(_snapshot: unknown, uiState: MiningFollowVisualizerState | undefined) {
        capturedUiState = uiState === undefined
          ? null
          : {
            settledBlockHeight: uiState.settledBlockHeight,
            settledBoardEntries: uiState.settledBoardEntries,
          };
      },
    } as any,
    loopState: createMiningLoopStateForTesting(),
  });

  const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(snapshot?.currentPhase, "resuming");
  assert.equal(
    snapshot?.reconnectSettledUntilUnixMs,
    1_700_000_999 + MINING_NETWORK_SETTLE_WINDOW_MS,
  );
  assert.deepEqual(capturedUiState, {
    settledBlockHeight: 100,
    settledBoardEntries: [
      createSettledBoardEntry(1, "cogdemo", "Indexed settled sentence.", ["under", "tree", "monkey", "youth", "basket"]),
    ],
  });
});

test("publish-time candidate refresh updates sender metadata from current state", () => {
  const candidate = createTestMiningCandidate({
    domainName: "stale-name",
    localIndex: 99,
    sender: {
      localIndex: 99,
      scriptPubKeyHex: "0014" + "22".repeat(20),
      address: "bc1qstale",
    },
  });
  const refreshed = refreshMiningCandidateFromCurrentStateForTesting(
    createReadyMiningReadContext({}),
    candidate,
  );

  assert.notEqual(refreshed, null);
  assert.equal(refreshed?.domainName, "cogdemo");
  assert.equal(refreshed?.localIndex, 0);
  assert.equal(refreshed?.sender.address, "bc1qfunding");
  assert.equal(refreshed?.sentence, candidate.sentence);
});

test("selected mining candidates stay scoped to their tip and clear on tip reset", () => {
  const loopState = createMiningLoopStateForTesting();
  const candidate = createTestMiningCandidate();
  loopState.ui.latestTxid = "cc".repeat(32);
  loopState.ui.settledBlockHeight = 100;
  loopState.ui.settledBoardEntries = [
    createSettledBoardEntry(1, "cogdemo", "Pinned settled sentence.", ["under", "tree", "monkey", "youth", "basket"]),
  ];
  loopState.ui.provisionalBroadcastTxid = "aa".repeat(32);

  cacheSelectedCandidateForTipForTesting(loopState, "tip-1", candidate);

  assert.equal(getSelectedCandidateForTipForTesting(loopState, "tip-1"), candidate);
  assert.equal(getSelectedCandidateForTipForTesting(loopState, "tip-2"), null);
  assert.equal(loopState.ui.provisionalBroadcastTxid, null);

  resetMiningUiForTipForTesting(loopState, 102);

  assert.equal(getSelectedCandidateForTipForTesting(loopState, "tip-1"), null);
  assert.equal(loopState.ui.latestTxid, "cc".repeat(32));
  assert.equal(loopState.ui.provisionalBroadcastTxid, null);
  assert.equal(loopState.ui.settledBlockHeight, 100);
  assert.deepEqual(loopState.ui.settledBoardEntries, [
    createSettledBoardEntry(1, "cogdemo", "Pinned settled sentence.", ["under", "tree", "monkey", "youth", "basket"]),
  ]);

  cacheSelectedCandidateForTipForTesting(loopState, "tip-2", candidate);

  assert.equal(loopState.ui.latestTxid, "cc".repeat(32));
  assert.equal(loopState.ui.provisionalBroadcastTxid, null);
});

test("displayed mining candidates only retain a tx link when they match the live publish", () => {
  const loopState = createMiningLoopStateForTesting();
  const candidate = createTestMiningCandidate();
  const matchingLiveState = createMiningState({
    currentPublishState: "in-mempool",
    livePublishInMempool: true,
    currentDomain: candidate.domainName,
    currentDomainId: candidate.domainId,
    currentSentence: candidate.sentence,
    currentTxid: "44".repeat(32),
    currentBlockTargetHeight: candidate.targetBlockHeight,
    currentReferencedBlockHashDisplay: candidate.referencedBlockHashDisplay,
  });

  cacheSelectedCandidateForTipForTesting(loopState, "tip-1", candidate, matchingLiveState);

  assert.equal(loopState.ui.provisionalBroadcastTxid, "44".repeat(32));

  cacheSelectedCandidateForTipForTesting(
    loopState,
    "tip-1",
    createTestMiningCandidate({
      sentence: "A different sentence for the same domain and tip.",
    }),
    matchingLiveState,
  );

  assert.equal(loopState.ui.provisionalBroadcastTxid, null);
});

test("shared mining conflict inputs are reused only for verified in-mempool live publishes", () => {
  const liveState = createWalletState({
    miningState: createMiningState({
      currentTxid: "33".repeat(32),
      currentPublishState: "in-mempool",
      livePublishInMempool: true,
      sharedMiningConflictOutpoint: {
        txid: "aa".repeat(32),
        vout: 0,
      },
    }),
  });
  const liveConflict = resolveMiningConflictOutpointForTesting({
    state: liveState,
    allUtxos: [{
      txid: "22".repeat(32),
      vout: 3,
      amount: 0.0001,
      scriptPubKey: liveState.funding.scriptPubKeyHex,
      confirmations: 3,
      spendable: true,
      safe: true,
    }] as any,
  });

  const state = createWalletState({
    miningState: createMiningState({
      currentTxid: null,
      currentPublishState: "broadcasting",
      sharedMiningConflictOutpoint: {
        txid: "aa".repeat(32),
        vout: 0,
      },
    }),
  });
  const conflict = resolveMiningConflictOutpointForTesting({
    state,
    allUtxos: [{
      txid: "22".repeat(32),
      vout: 3,
      amount: 0.0001,
      scriptPubKey: state.funding.scriptPubKeyHex,
      confirmations: 3,
      spendable: true,
      safe: true,
    }] as any,
  });

  assert.equal(conflict, null);
  assert.deepEqual(liveConflict, {
    txid: "aa".repeat(32),
    vout: 0,
  });
});

test("funding display sats includes unconfirmed funding change so the mine SAT counter stays nonzero", async () => {
  const state = createWalletState();
  const sats = await resolveFundingDisplaySatsForTesting(state, {
    listUnspent: async () => [
      {
        txid: "11".repeat(32),
        vout: 0,
        amount: 0.00009,
        scriptPubKey: state.funding.scriptPubKeyHex,
        confirmations: 0,
        spendable: true,
        safe: false,
      },
      {
        txid: "22".repeat(32),
        vout: 1,
        amount: 0.5,
        scriptPubKey: state.funding.scriptPubKeyHex,
        confirmations: 0,
        spendable: false,
        safe: true,
      },
      {
        txid: "33".repeat(32),
        vout: 2,
        amount: 0.75,
        scriptPubKey: "0014" + "22".repeat(20),
        confirmations: 3,
        spendable: true,
        safe: true,
      },
    ],
  } as any);

  assert.equal(sats, 9_000n);
});

test("mining visible follow block times load from the indexed tip and sync into the visualizer state", async () => {
  const blockTimes = await loadMiningVisibleFollowBlockTimesForTesting({
    indexedTipHeight: 100,
    indexedTipHashHex: "aa".repeat(32),
    rpc: {
      getBlock: async (hashHex: string) => {
        if (hashHex === "aa".repeat(32)) {
          return {
            hash: hashHex,
            height: 100,
            time: 1_000,
            previousblockhash: "bb".repeat(32),
          };
        }

        if (hashHex === "bb".repeat(32)) {
          return {
            hash: hashHex,
            height: 99,
            time: 940,
            previousblockhash: "cc".repeat(32),
          };
        }

        return {
          hash: hashHex,
          height: 98,
          time: 880,
          previousblockhash: null,
        };
      },
    },
  } as any);

  const loopState = createMiningLoopStateForTesting();
  syncMiningVisualizerBlockTimesForTesting(loopState, blockTimes);

  assert.deepEqual(blockTimes, {
    100: 1_000,
    99: 940,
    98: 880,
  });
  assert.deepEqual(loopState.ui.visibleBlockTimesByHeight, blockTimes);
});

test("publish candidate returns a same-tip retry result after missing inputs", async () => {
  const events: any[] = [];
  let attempts = 0;

  const result = await publishCandidateForTesting({
    candidate: createTestMiningCandidate(),
    dataDir: "/tmp",
    databasePath: "/tmp/test.db",
    provider: {} as any,
    paths: {} as any,
    fallbackState: createReadyMiningReadContext({}).localState.state,
    openReadContext: async () => createReadyMiningReadContext({}),
    attachService: async () => {
      throw new Error("attachService should not be called when publishAttempt is stubbed");
    },
    rpcFactory: () => {
      throw new Error("rpcFactory should not be called when publishAttempt is stubbed");
    },
    runId: "run-1",
    publishAttempt: async () => {
      attempts += 1;
      throw new Error("wallet_mining_mempool_rejected_missing-inputs");
    },
    appendEventFn: async (_paths, event) => {
      events.push(event);
    },
  });

  assert.equal(attempts, 1);
  assert.equal(result.retryable, true);
  assert.equal(result.txid, null);
  assert.equal(result.decision, "publish-retry-pending");
  assert.match(result.note, /retried on the current tip/i);
  assert.equal(result.candidate.sentence, createTestMiningCandidate().sentence);
  const retryEvent = events.find((event) => event.kind === "publish-retry-pending");
  assert.notEqual(retryEvent, undefined);
  assert.equal(retryEvent?.reason, "missing-inputs");
});

test("publish candidate pauses with a waiting result after insufficient funds", async () => {
  const events: any[] = [];
  let attempts = 0;

  const result = await publishCandidateForTesting({
    candidate: createTestMiningCandidate(),
    dataDir: "/tmp",
    databasePath: "/tmp/test.db",
    provider: {} as any,
    paths: {} as any,
    fallbackState: createReadyMiningReadContext({}).localState.state,
    openReadContext: async () => createReadyMiningReadContext({}),
    attachService: async () => {
      throw new Error("attachService should not be called when publishAttempt is stubbed");
    },
    rpcFactory: () => {
      throw new Error("rpcFactory should not be called when publishAttempt is stubbed");
    },
    runId: "run-1",
    publishAttempt: async () => {
      attempts += 1;
      throw new Error("bitcoind_rpc_walletcreatefundedpsbt_-4_Insufficient funds");
    },
    appendEventFn: async (_paths, event) => {
      events.push(event);
    },
  });

  assert.equal(attempts, 1);
  assert.equal(result.skipped, true);
  if (result.skipped !== true) {
    assert.fail("expected insufficient-funds publish result to skip the current tip");
  }
  assert.equal(result.txid, null);
  assert.equal(result.decision, "publish-paused-insufficient-funds");
  assert.equal(result.note, "Insufficient BTC to mine.");
  assert.equal(result.lastError, "Bitcoin Core could not fund the next mining publish with safe BTC.");
  assert.equal(result.candidate, null);
  const pausedEvent = events.find((event) => event.kind === "publish-paused-insufficient-funds");
  assert.notEqual(pausedEvent, undefined);
  assert.equal(pausedEvent?.reason, "insufficient-funds");
  assert.doesNotMatch(pausedEvent?.message ?? "", /walletcreatefundedpsbt/i);
  assert.match(pausedEvent?.message ?? "", /with safe BTC/i);
});

test("publish candidate broadcasts when only safe 0-conf BTC funding is available", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-safe-zeroconf");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const publishableSentence = "a".repeat(60);
  const candidate = createTestMiningCandidate({
    sentence: publishableSentence,
    encodedSentenceBytes: Buffer.from(publishableSentence, "utf8"),
  });
  const readContext = createReadyMiningReadContext({});
  const state = readContext.localState.state;
  await provider.storeSecret(
    createWalletSecretReference(state.walletRootId).keyId,
    new Uint8Array(32).fill(7),
  );
  const fundingUtxo = {
    txid: "aa".repeat(32),
    vout: 0,
    scriptPubKey: state.funding.scriptPubKeyHex,
    amount: 0.0001,
    confirmations: 0,
    spendable: true,
    safe: true,
  };
  const plan = createMiningPlanForTesting({
    state,
    candidate,
    conflictOutpoint: null,
    allUtxos: [fundingUtxo],
    feeRateSatVb: 10,
  });
  const observedListUnspentMinConfs: Array<number | undefined> = [];
  let fundedMinConf: number | null = null;
  let attachServiceLifetime: string | null = null;

  const result = await publishCandidateForTesting({
    candidate,
    dataDir: homeDirectory,
    databasePath: `${homeDirectory}/client.sqlite`,
    provider,
    paths,
    fallbackState: state,
    openReadContext: async () => readContext,
    attachService: async (options) => {
      attachServiceLifetime = options.serviceLifetime ?? null;
      return { rpc: {} } as any;
    },
    rpcFactory: () => ({
      async getBlockchainInfo() {
        return {
          blocks: 100,
          bestblockhash: "11".repeat(32),
          initialblockdownload: false,
        };
      },
      async listUnspent(_walletName: string, minConf?: number) {
        observedListUnspentMinConfs.push(minConf);
        return [fundingUtxo];
      },
      async walletCreateFundedPsbt(
        _walletName: string,
        _inputs: Array<{ txid: string; vout: number }>,
        _outputs: unknown[],
        _locktime: number,
        options: Record<string, unknown>,
      ) {
        fundedMinConf = typeof options["minconf"] === "number" ? options["minconf"] : null;
        return {
          psbt: "funded-psbt",
          fee: 0.00000011,
          changepos: plan.changePosition,
        };
      },
      async decodePsbt() {
        return {
          tx: {
            vin: [{ txid: fundingUtxo.txid, vout: fundingUtxo.vout }],
            vout: [
              {
                value: 0,
                scriptPubKey: { hex: plan.expectedOpReturnScriptHex },
              },
              {
                value: 0.0000989,
                scriptPubKey: { hex: plan.allowedFundingScriptPubKeyHex },
              },
            ],
          },
          inputs: [],
        } as never;
      },
      async walletPassphrase() {
        return null;
      },
      async walletProcessPsbt() {
        return {
          psbt: "signed-psbt",
          complete: true,
        };
      },
      async walletLock() {
        return null;
      },
      async finalizePsbt() {
        return {
          complete: true,
          hex: "raw-hex",
        };
      },
      async decodeRawTransaction() {
        return {
          txid: "bb".repeat(32),
          hash: "cc".repeat(32),
        } as never;
      },
      async testMempoolAccept() {
        return [{ allowed: true }];
      },
      async sendRawTransaction() {
        return "bb".repeat(32);
      },
    }) as any,
    runId: "run-1",
    appendEventFn: async () => {},
  });

  assert.equal(attachServiceLifetime, null);
  assert.ok(observedListUnspentMinConfs.length >= 2);
  assert.deepEqual(new Set(observedListUnspentMinConfs), new Set([0]));
  assert.equal(fundedMinConf, 0);
  assert.equal(result.skipped, undefined);
  assert.equal(result.retryable, undefined);
  assert.equal(result.decision, "broadcast");
  assert.equal(result.txid, "bb".repeat(32));
  assert.equal(result.candidate?.sentence, candidate.sentence);
});

test("publish candidate recovers a managed Core wallet relock and continues broadcasting", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-managed-core-relock-recover");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const publishableSentence = "a".repeat(60);
  const candidate = createTestMiningCandidate({
    sentence: publishableSentence,
    encodedSentenceBytes: Buffer.from(publishableSentence, "utf8"),
  });
  const readContext = createReadyMiningReadContext({});
  const state = readContext.localState.state;
  const events: any[] = [];
  let walletPassphraseCalls = 0;
  let walletProcessPsbtCalls = 0;
  let walletLockCalls = 0;

  await provider.storeSecret(
    createWalletSecretReference(state.walletRootId).keyId,
    new Uint8Array(32).fill(7),
  );

  const result = await publishCandidateForTesting({
    candidate,
    dataDir: homeDirectory,
    databasePath: `${homeDirectory}/client.sqlite`,
    provider,
    paths,
    fallbackState: state,
    openReadContext: async () => readContext,
    attachService: async () => ({ rpc: {}, pid: 9_001 }) as any,
    rpcFactory: () => createHealthyMiningRpc({
      async walletPassphrase() {
        walletPassphraseCalls += 1;
        return null;
      },
      async walletProcessPsbt() {
        walletProcessPsbtCalls += 1;
        if (walletProcessPsbtCalls === 1) {
          throw new Error(MANAGED_CORE_WALLET_LOCKED_ERROR);
        }

        return {
          psbt: "signed-psbt",
          complete: true,
        };
      },
      async walletLock() {
        walletLockCalls += 1;
        return null;
      },
      async finalizePsbt() {
        return {
          complete: true,
          hex: "raw-hex",
        };
      },
      async decodeRawTransaction() {
        return {
          txid: "bb".repeat(32),
          hash: "cc".repeat(32),
        } as never;
      },
      async testMempoolAccept() {
        return [{ allowed: true }];
      },
      async sendRawTransaction() {
        return "bb".repeat(32);
      },
    }, {
      fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
    }) as any,
    runId: "run-1",
    appendEventFn: async (_paths, event) => {
      events.push(event);
    },
  });

  assert.equal(result.decision, "broadcast");
  assert.equal(result.txid, "bb".repeat(32));
  assert.equal(result.retryable, undefined);
  assert.equal(result.candidate?.sentence, candidate.sentence);
  assert.equal(walletPassphraseCalls, 2);
  assert.equal(walletProcessPsbtCalls, 2);
  assert.equal(walletLockCalls, 1);
  assert.equal(events.some((event) =>
    event.kind === "managed-core-wallet-relock-recovered"
    && event.level === "warn"
    && event.reason === "managed-core-wallet-locked"
  ), true);
  assert.equal(events.some((event) => event.kind === "tx-broadcast"), true);
  assert.equal(events.some((event) =>
    event.kind === "timing-read-context-refresh"
    && event.metrics?.outcome === "success"
    && event.durationMs >= 0
  ), true);
  assert.equal(events.some((event) =>
    event.kind === "timing-wallet-build"
    && event.metrics?.outcome === "success"
    && event.metrics?.managedCoreWalletRelockOutcome === "recovered"
    && event.durationMs >= 0
  ), true);
  assert.equal(events.some((event) =>
    event.kind === "timing-sendrawtransaction"
    && event.metrics?.outcome === "accepted"
    && event.txid === "bb".repeat(32)
    && event.durationMs >= 0
  ), true);
  assert.equal(events.some((event) =>
    event.kind === "timing-wallet-state-save"
    && event.metrics?.stage === "pre-broadcast"
    && event.metrics?.outcome === "success"
    && event.durationMs >= 0
  ), true);
  assert.equal(events.some((event) =>
    event.kind === "timing-wallet-state-save"
    && event.metrics?.stage === "post-broadcast"
    && event.metrics?.outcome === "success"
    && event.durationMs >= 0
  ), true);
});

test("publish candidate retries when the managed Core wallet stays locked after the immediate retry", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-managed-core-relock-retry");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const publishableSentence = "a".repeat(60);
  const candidate = createTestMiningCandidate({
    sentence: publishableSentence,
    encodedSentenceBytes: Buffer.from(publishableSentence, "utf8"),
  });
  const readContext = createReadyMiningReadContext({});
  const state = readContext.localState.state;
  const events: any[] = [];
  let walletPassphraseCalls = 0;
  let walletProcessPsbtCalls = 0;
  let walletLockCalls = 0;

  const result = await publishCandidateForTesting({
    candidate,
    dataDir: homeDirectory,
    databasePath: `${homeDirectory}/client.sqlite`,
    provider,
    paths,
    fallbackState: state,
    openReadContext: async () => readContext,
    attachService: async () => ({ rpc: {}, pid: 9_001 }) as any,
    rpcFactory: () => createHealthyMiningRpc({
      async walletPassphrase() {
        walletPassphraseCalls += 1;
        return null;
      },
      async walletProcessPsbt() {
        walletProcessPsbtCalls += 1;
        throw new Error(MANAGED_CORE_WALLET_LOCKED_ERROR);
      },
      async walletLock() {
        walletLockCalls += 1;
        return null;
      },
      async finalizePsbt() {
        throw new Error("finalizePsbt should not run when signing never succeeds");
      },
      async decodeRawTransaction() {
        throw new Error("decodeRawTransaction should not run when signing never succeeds");
      },
      async testMempoolAccept() {
        throw new Error("testMempoolAccept should not run when signing never succeeds");
      },
      async sendRawTransaction() {
        throw new Error("sendRawTransaction should not run when signing never succeeds");
      },
    }, {
      fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
    }) as any,
    runId: "run-1",
    appendEventFn: async (_paths, event) => {
      events.push(event);
    },
  });

  assert.equal(result.retryable, true);
  if (result.retryable !== true) {
    assert.fail("expected managed Core relock result to stay on the retryable publish path");
  }
  assert.equal(result.txid, null);
  assert.equal(result.decision, "publish-retry-pending");
  assert.equal(result.note, "Mining temporarily lost the managed Bitcoin wallet unlock and is retrying.");
  assert.equal(result.lastError, MANAGED_CORE_WALLET_LOCKED_ERROR);
  assert.equal(result.candidate.sentence, candidate.sentence);
  assert.equal(walletPassphraseCalls, 2);
  assert.equal(walletProcessPsbtCalls, 2);
  assert.equal(walletLockCalls, 1);
  const retryEvent = events.find((event) => event.kind === "publish-retry-pending");
  assert.notEqual(retryEvent, undefined);
  assert.equal(retryEvent?.reason, "managed-core-wallet-locked");
});

test("pre-publish status on a new tip shows the pending candidate instead of stale prior-tip tx metadata", () => {
  const state = createWalletState({
    miningState: createMiningState({
      currentPublishState: "in-mempool",
      currentDomain: "samplemine",
      currentDomainId: 40,
      currentTxid: "aa".repeat(32),
      currentWtxid: "bb".repeat(32),
      currentFeeRateSatVb: 3.004,
      currentAbsoluteFeeSats: 580,
      currentScore: "488882815",
      currentSentence: "old tip sentence",
      currentBlockTargetHeight: 945636,
      currentReferencedBlockHashDisplay: "11".repeat(32),
      livePublishInMempool: true,
      currentPublishDecision: "paused-stale-mempool",
      currentBlockFeeSpentSats: "580",
    }),
  });
  const candidate = createTestMiningCandidate({
    domainId: 40,
    domainName: "samplemine",
    sentence: "new tip sentence",
    canonicalBlend: 384387886n,
    referencedBlockHashDisplay: "22".repeat(32),
    targetBlockHeight: 945637,
  });

  const snapshot = buildStatusSnapshotForTesting(
    createMiningControlPlaneView(),
    buildPrePublishStatusOverridesForTesting({
      state,
      candidate,
    }),
  );

  assert.equal(snapshot.currentPhase, "replacing");
  assert.equal(snapshot.currentPublishDecision, "replacing");
  assert.equal(snapshot.note, "Replacing the live mining transaction for the current tip.");
  assert.equal(snapshot.targetBlockHeight, 945637);
  assert.equal(snapshot.referencedBlockHashDisplay, "22".repeat(32));
  assert.equal(snapshot.currentDomainId, 40);
  assert.equal(snapshot.currentDomainName, "samplemine");
  assert.equal(snapshot.currentSentenceDisplay, "new tip sentence");
  assert.equal(snapshot.currentCanonicalBlend, "384387886");
  assert.equal(snapshot.currentPublishState, "none");
  assert.equal(snapshot.currentTxid, null);
  assert.equal(snapshot.currentWtxid, null);
  assert.equal(snapshot.livePublishInMempool, false);
  assert.equal(snapshot.currentFeeRateSatVb, null);
  assert.equal(snapshot.currentAbsoluteFeeSats, null);
  assert.equal(snapshot.currentBlockFeeSpentSats, "0");
});

test("publish candidate reuses the same selected sentence across same-tip retries", async () => {
  const closeCalls: number[] = [];
  const contexts = [
    createReadyMiningReadContext({
      close: async () => {
        closeCalls.push(1);
      },
    }),
    createReadyMiningReadContext({
      close: async () => {
        closeCalls.push(2);
      },
    }),
  ];
  const seenSentences: string[] = [];
  let attempts = 0;

  const first = await publishCandidateForTesting({
    candidate: createTestMiningCandidate(),
    dataDir: "/tmp",
    databasePath: "/tmp/test.db",
    provider: {} as any,
    paths: {} as any,
    fallbackState: contexts[0]!.localState.state,
    openReadContext: async () => contexts.shift()!,
    attachService: async () => {
      throw new Error("attachService should not be called when publishAttempt is stubbed");
    },
    rpcFactory: () => {
      throw new Error("rpcFactory should not be called when publishAttempt is stubbed");
    },
    runId: "run-1",
    publishAttempt: async ({ candidate }) => {
      attempts += 1;
      seenSentences.push(candidate.sentence);
      throw new Error("wallet_mining_mempool_rejected_missing-inputs");
    },
    appendEventFn: async () => undefined,
  });

  assert.equal(first.retryable, true);

  const second = await publishCandidateForTesting({
    candidate: first.candidate,
    dataDir: "/tmp",
    databasePath: "/tmp/test.db",
    provider: {} as any,
    paths: {} as any,
    fallbackState: first.state,
    openReadContext: async () => contexts.shift()!,
    attachService: async () => {
      throw new Error("attachService should not be called when publishAttempt is stubbed");
    },
    rpcFactory: () => {
      throw new Error("rpcFactory should not be called when publishAttempt is stubbed");
    },
    runId: "run-1",
    publishAttempt: async ({ readContext, candidate }) => {
      attempts += 1;
      seenSentences.push(candidate.sentence);
      return {
        state: readContext.localState.state,
        txid: "ff".repeat(32),
        decision: "broadcast",
      };
    },
    appendEventFn: async () => undefined,
  });

  assert.equal(attempts, 2);
  assert.equal(second.retryable, undefined);
  assert.equal(second.txid, "ff".repeat(32));
  assert.equal(second.decision, "broadcast");
  assert.equal(second.candidate.sentence, createTestMiningCandidate().sentence);
  assert.deepEqual(seenSentences, [
    createTestMiningCandidate().sentence,
    createTestMiningCandidate().sentence,
  ]);
  assert.deepEqual(closeCalls, [1, 2]);
});

test("publish candidate retries when publish-time read context has no snapshot lease", async () => {
  const events: any[] = [];
  const fallbackState = createReadyMiningReadContext({}).localState.state;

  const result = await publishCandidateForTesting({
    candidate: createTestMiningCandidate(),
    dataDir: "/tmp",
    databasePath: "/tmp/test.db",
    provider: {} as any,
    paths: {} as any,
    fallbackState,
    openReadContext: async () => ({
      ...createWalletReadContext({
        localState: {
          availability: "ready",
          clientPasswordReadiness: "ready",
          unlockRequired: false,
          walletRootId: fallbackState.walletRootId,
          state: fallbackState,
          source: "primary",
          hasPrimaryStateFile: true,
          hasBackupStateFile: false,
          message: null,
        },
        snapshot: null,
        model: null,
        indexer: {
          health: "unavailable",
          message: "snapshot unavailable",
          status: {
            state: "synced",
            heartbeatAtUnixMs: 1_000,
            updatedAtUnixMs: 1_100,
            ipcReady: true,
            rpcReachable: true,
            coreBestHeight: 100,
            coreBestHash: "11".repeat(32),
            appliedTipHeight: 100,
            appliedTipHash: "11".repeat(32),
            reorgDepth: null,
          },
          source: "status-file",
          daemonInstanceId: "daemon-status",
          snapshotSeq: "seq-status",
          openedAtUnixMs: null,
          snapshotTip: null,
        },
      }),
      close: async () => undefined,
    }) as any,
    attachService: async () => {
      throw new Error("attachService should not run without a snapshot lease");
    },
    rpcFactory: () => {
      throw new Error("rpcFactory should not run without a snapshot lease");
    },
    runId: "run-1",
    publishAttempt: async () => {
      throw new Error("publishAttempt should not run without a snapshot lease");
    },
    appendEventFn: async (_paths, event) => {
      events.push(event);
    },
  });

  assert.equal(result.retryable, true);
  if (result.retryable !== true) {
    assert.fail("expected snapshot-unavailable publish result to be retryable");
  }
  assert.equal(result.txid, null);
  assert.equal(result.decision, "publish-retry-pending");
  assert.equal(result.currentPhase, "waiting-indexer");
  assert.equal(result.readinessBlocker, "indexer-snapshot");
  assert.equal(result.note, "Mining is waiting for a coherent indexer snapshot lease before broadcasting the selected candidate.");
  assert.equal(result.candidate.sentence, createTestMiningCandidate().sentence);
  const retryEvent = events.find((event) => event.kind === "publish-retry-pending");
  assert.notEqual(retryEvent, undefined);
  assert.equal(retryEvent?.reason, "snapshot-unavailable");
});

test("publish candidate refresh uses domain ID even when the read model omits the domain", async () => {
  let attempts = 0;

  const result = await publishCandidateForTesting({
    candidate: createTestMiningCandidate(),
    dataDir: "/tmp",
    databasePath: "/tmp/test.db",
    provider: {} as any,
    paths: {} as any,
    fallbackState: createReadyMiningReadContext({}).localState.state,
    openReadContext: async () => createReadyMiningReadContext({
      readContextOverrides: {
        model: {
          walletScriptPubKeyHex: "0014" + "11".repeat(20),
          domains: [],
        },
      },
    }),
    attachService: async () => {
      throw new Error("attachService should not be called when publishAttempt is stubbed");
    },
    rpcFactory: () => {
      throw new Error("rpcFactory should not be called when publishAttempt is stubbed");
    },
    runId: "run-1",
    publishAttempt: async ({ readContext, candidate }) => {
      attempts += 1;
      assert.equal(candidate.domainId, 7);
      assert.equal(candidate.domainName, "cogdemo");
      assert.equal(candidate.sender.address, "bc1qfunding");
      assert.equal(candidate.provenance?.authorizationRole, "owner");
      return {
        state: readContext.localState.state,
        txid: "ff".repeat(32),
        decision: "broadcast",
      };
    },
    appendEventFn: async () => undefined,
  });

  assert.equal(attempts, 1);
  assert.equal(result.decision, "broadcast");
  assert.equal(result.txid, "ff".repeat(32));
  assert.equal(result.candidate?.provenance?.authorizationRole, "owner");
});

test("publish candidate restarts when candidate provenance points at older indexer truth", async () => {
  const result = await publishCandidateForTesting({
    candidate: createTestMiningCandidate({
      provenance: createTestMiningCandidateProvenance({
        indexerSnapshotSeq: "seq-99",
      }),
    }),
    dataDir: "/tmp",
    databasePath: "/tmp/test.db",
    provider: {} as any,
    paths: {} as any,
    fallbackState: createReadyMiningReadContext({}).localState.state,
    openReadContext: async () => createReadyMiningReadContext({}),
    attachService: async () => {
      throw new Error("attachService should not run when indexer truth changed");
    },
    rpcFactory: () => {
      throw new Error("rpcFactory should not run when indexer truth changed");
    },
    runId: "run-1",
    publishAttempt: async () => {
      throw new Error("publishAttempt should not run when indexer truth changed");
    },
    appendEventFn: async () => undefined,
  });

  assert.equal(result.restart, true);
  assert.equal(result.txid, null);
  assert.equal(result.decision, "publish-restart-snapshot-changed");
  assert.equal(result.candidate, null);
  assert.match(result.note, /indexer truth changed/i);
});

test("publish candidate restarts when the Bitcoin tip changes before broadcast", async () => {
  const result = await publishCandidateForTesting({
    candidate: createTestMiningCandidate(),
    dataDir: "/tmp",
    databasePath: "/tmp/test.db",
    provider: {} as any,
    paths: {} as any,
    fallbackState: createReadyMiningReadContext({}).localState.state,
    openReadContext: async () => createReadyMiningReadContext({
      readContextOverrides: {
        nodeStatus: {
          chain: "mainnet",
          nodeBestHeight: 101,
          nodeBestHashHex: "12".repeat(32),
          walletReplica: {
            proofStatus: "ready",
          },
        },
      },
    }),
    attachService: async () => {
      throw new Error("attachService should not run when the Bitcoin tip changed");
    },
    rpcFactory: () => {
      throw new Error("rpcFactory should not run when the Bitcoin tip changed");
    },
    runId: "run-1",
    publishAttempt: async () => {
      throw new Error("publishAttempt should not run when the Bitcoin tip changed");
    },
    appendEventFn: async () => undefined,
  });

  assert.equal(result.restart, true);
  assert.equal(result.txid, null);
  assert.equal(result.decision, "publish-restart-tip-changed");
  assert.equal(result.candidate, null);
  assert.match(result.note, /Bitcoin tip changed/i);
});

test("publish candidate restarts when Core advances after read-context refresh", async () => {
  let attachCalls = 0;
  let sendRawTransactionCalls = 0;

  const result = await publishCandidateForTesting({
    candidate: createTestMiningCandidate(),
    dataDir: "/tmp",
    databasePath: "/tmp/test.db",
    provider: {} as any,
    paths: {} as any,
    fallbackState: createReadyMiningReadContext({}).localState.state,
    openReadContext: async () => createReadyMiningReadContext({}),
    attachService: async () => {
      attachCalls += 1;
      return { rpc: {}, pid: 9_001 } as any;
    },
    rpcFactory: () => ({
      async getBlockchainInfo() {
        return {
          blocks: 101,
          bestblockhash: "22".repeat(32),
          initialblockdownload: false,
        };
      },
      async sendRawTransaction() {
        sendRawTransactionCalls += 1;
        throw new Error("sendRawTransaction should not run for stale Core tip");
      },
    }) as any,
    runId: "run-1",
    appendEventFn: async () => undefined,
  });

  assert.equal(result.restart, true);
  assert.equal(result.txid, null);
  assert.equal(result.decision, "publish-restart-tip-changed");
  assert.equal(result.candidate, null);
  assert.equal(attachCalls, 1);
  assert.equal(sendRawTransactionCalls, 0);
});

test("publish candidate restarts when Core is ahead of the coherent indexer lease", async () => {
  const coreHashHex = "22".repeat(32);
  const indexedHashHex = "11".repeat(32);
  let attachCalls = 0;
  let sendRawTransactionCalls = 0;

  const result = await publishCandidateForTesting({
    candidate: createTestMiningCandidate({
      targetBlockHeight: 102,
      referencedBlockHashDisplay: coreHashHex,
      provenance: createTestMiningCandidateProvenance({
        indexerSnapshotSeq: "seq-100",
        snapshotTipHeight: 100,
        snapshotTipHash: indexedHashHex,
      }),
    }),
    dataDir: "/tmp",
    databasePath: "/tmp/test.db",
    provider: {} as any,
    paths: {} as any,
    fallbackState: createReadyMiningReadContext({}).localState.state,
    openReadContext: async () => createReadyMiningReadContext({
      readContextOverrides: {
        nodeStatus: {
          chain: "mainnet",
          nodeBestHeight: 101,
          nodeBestHashHex: coreHashHex,
          walletReplica: {
            proofStatus: "ready",
          },
        },
        indexer: {
          health: "synced",
          message: null,
          status: {
            state: "synced",
            heartbeatAtUnixMs: 1,
            updatedAtUnixMs: 1,
            ipcReady: true,
            rpcReachable: true,
            coreBestHeight: 101,
            coreBestHash: coreHashHex,
            appliedTipHeight: 100,
            appliedTipHash: indexedHashHex,
            reorgDepth: null,
          },
          source: "lease",
          daemonInstanceId: "daemon-1",
          snapshotSeq: "seq-100",
          openedAtUnixMs: 1,
          snapshotTip: {
            height: 100,
            blockHashHex: indexedHashHex,
            previousHashHex: "00".repeat(32),
            stateHashHex: null,
          },
        },
      },
    }),
    attachService: async () => {
      attachCalls += 1;
      return { rpc: {}, pid: 9_001 } as any;
    },
    rpcFactory: () => ({
      async getBlockchainInfo() {
        return {
          blocks: 101,
          bestblockhash: coreHashHex,
          initialblockdownload: false,
        };
      },
      async sendRawTransaction() {
        sendRawTransactionCalls += 1;
        throw new Error("sendRawTransaction should not run when indexer is behind Core");
      },
    }) as any,
    runId: "run-1",
    appendEventFn: async () => undefined,
  });

  assert.equal(result.restart, true);
  assert.equal(result.txid, null);
  assert.equal(result.decision, "publish-restart-snapshot-changed");
  assert.equal(result.candidate, null);
  assert.equal(attachCalls, 1);
  assert.equal(sendRawTransactionCalls, 0);
});

test("publish candidate reports authorization loss without blaming snapshot alignment", async () => {
  const result = await publishCandidateForTesting({
    candidate: createTestMiningCandidate({
      provenance: createTestMiningCandidateProvenance({
        authorizationRole: "miner",
      }),
    }),
    dataDir: "/tmp",
    databasePath: "/tmp/test.db",
    provider: {} as any,
    paths: {} as any,
    fallbackState: createReadyMiningReadContext({}).localState.state,
    openReadContext: async () => createReadyMiningReadContext({
      readContextOverrides: {
        snapshot: {
          daemonInstanceId: "daemon-1",
          snapshotSeq: "seq-100",
          tip: {
            height: 100,
            blockHashHex: "11".repeat(32),
            previousHashHex: "00".repeat(32),
            stateHashHex: null,
          },
          state: {
            consensus: {
              domainIdsByName: new Map([["cogdemo", 7]]),
              domainsById: new Map([[7, {
                domainId: 7,
                name: "cogdemo",
                anchored: true,
                anchorHeight: 100,
                ownerScriptPubKey: Buffer.from("0014" + "22".repeat(20), "hex"),
                delegate: null,
                miner: null,
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
      },
    }),
    attachService: async () => {
      throw new Error("attachService should not be called when publishAttempt is stubbed");
    },
    rpcFactory: () => {
      throw new Error("rpcFactory should not be called when publishAttempt is stubbed");
    },
    runId: "run-1",
    publishAttempt: async () => {
      throw new Error("publishAttempt should not run for stale candidates");
    },
    appendEventFn: async () => undefined,
  });

  assert.equal(result.skipped, true);
  assert.equal(result.retryable, undefined);
  assert.equal(result.txid, null);
  assert.equal(result.decision, "publish-skipped-authorization-lost");
  assert.equal(result.candidate, null);
  assert.match(result.note, /wallet authorization/i);
  assert.doesNotMatch(result.note, /Bitcoin Core and the indexer to align/i);
});

test("publish candidate flags owner authorization loss as an invariant failure", async () => {
  const events: any[] = [];
  const result = await publishCandidateForTesting({
    candidate: createTestMiningCandidate({
      provenance: createTestMiningCandidateProvenance({
        authorizationRole: "owner",
      }),
    }),
    dataDir: "/tmp",
    databasePath: "/tmp/test.db",
    provider: {} as any,
    paths: {} as any,
    fallbackState: createReadyMiningReadContext({}).localState.state,
    openReadContext: async () => createReadyMiningReadContext({
      readContextOverrides: {
        snapshot: {
          daemonInstanceId: "daemon-1",
          snapshotSeq: "seq-100",
          tip: {
            height: 100,
            blockHashHex: "11".repeat(32),
            previousHashHex: "00".repeat(32),
            stateHashHex: null,
          },
          state: {
            consensus: {
              domainIdsByName: new Map([["cogdemo", 7]]),
              domainsById: new Map([[7, {
                domainId: 7,
                name: "cogdemo",
                anchored: true,
                anchorHeight: 100,
                ownerScriptPubKey: Buffer.from("0014" + "33".repeat(20), "hex"),
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
      },
    }),
    attachService: async () => {
      throw new Error("attachService should not run after owner authorization invariant failure");
    },
    rpcFactory: () => {
      throw new Error("rpcFactory should not run after owner authorization invariant failure");
    },
    runId: "run-1",
    publishAttempt: async () => {
      throw new Error("publishAttempt should not run after owner authorization invariant failure");
    },
    appendEventFn: async (_paths, event) => {
      events.push(event);
    },
  });

  assert.equal(result.skipped, true);
  assert.equal(result.decision, "publish-skipped-authorization-lost");
  assert.match(result.lastError ?? "", /owner authorization invariant failed/i);
  const skipEvent = events.find((event) => event.kind === "publish-skipped-authorization-lost");
  assert.notEqual(skipEvent, undefined);
  assert.equal(skipEvent?.level, "error");
  assert.equal(skipEvent?.reason, "authorization-lost");
});

test("runCompetitivenessGate keeps same-domain mempool suppression semantics", async () => {
  const candidate = createGateCandidate({
    canonicalBlend: 10n,
    sentenceFill: "l",
  });
  const context = createGateReadContext({
    domains: [{
      domainId: 7,
      name: "cogdemo",
    }],
  });
  const txid = "aa".repeat(32);
  const sameDomainSentence = "s".repeat(60);

  const decision = await runCompetitivenessGateForTesting({
    rpc: createGateRpc({
      txids: [txid],
      rawTransactions: {
        [txid]: createMineTransaction({
          txid,
          domainId: 7,
          senderScriptPubKeyHex: candidate.sender.scriptPubKeyHex,
          referencedBlockHashInternal: candidate.referencedBlockHashInternal,
          sentenceFill: "s",
        }),
      },
    }) as any,
    readContext: context,
    candidate,
    currentTxid: null,
    assaySentencesImpl: createGateAssayStub({
      [sameDomainSentence]: 25n,
    }) as any,
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.decision, "suppressed-same-domain-mempool");
  assert.equal(decision.sameDomainCompetitorSuppressed, true);
  assert.equal(decision.higherRankedCompetitorDomainCount, 1);
  assert.equal(decision.dedupedCompetitorDomainCount, 0);
  assert.equal(decision.competitivenessGateIndeterminate, false);
});

test("runCompetitivenessGate keeps top-5 mempool suppression semantics", async () => {
  const candidate = createGateCandidate({
    canonicalBlend: 1n,
    sentenceFill: "l",
  });
  const domains = [
    { domainId: 1, name: "alpha" },
    { domainId: 2, name: "bravo" },
    { domainId: 3, name: "cinder" },
    { domainId: 4, name: "delta" },
    { domainId: 5, name: "ember" },
    { domainId: 6, name: "fable" },
    { domainId: 7, name: "cogdemo" },
  ];
  const context = createGateReadContext({ domains });
  const rawTransactions: Record<string, ReturnType<typeof createMineTransaction>> = {};
  const assayScores: Record<string, bigint | null> = {};
  const txids: string[] = [];

  for (const [index, domain] of domains.slice(0, 6).entries()) {
    const txid = `${String(index + 1).padStart(2, "0")}`.repeat(32);
    const sentenceFill = String.fromCharCode("a".charCodeAt(0) + index);
    const sentence = sentenceFill.repeat(60);
    txids.push(txid);
    rawTransactions[txid] = createMineTransaction({
      txid,
      domainId: domain.domainId,
      senderScriptPubKeyHex: candidate.sender.scriptPubKeyHex,
      referencedBlockHashInternal: candidate.referencedBlockHashInternal,
      sentenceFill,
    });
    assayScores[sentence] = BigInt(100 - index);
  }

  const decision = await runCompetitivenessGateForTesting({
    rpc: createGateRpc({
      txids,
      rawTransactions,
    }) as any,
    readContext: context,
    candidate,
    currentTxid: null,
    assaySentencesImpl: createGateAssayStub(assayScores) as any,
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.decision, "suppressed-top5-mempool");
  assert.equal(decision.sameDomainCompetitorSuppressed, false);
  assert.equal(decision.higherRankedCompetitorDomainCount, 6);
  assert.equal(decision.dedupedCompetitorDomainCount, 6);
  assert.equal(decision.candidateRank, 7);
});

test("runCompetitivenessGate keeps indeterminate mempool semantics when mempool inspection fails", async () => {
  const candidate = createGateCandidate();
  const context = createGateReadContext({
    domains: [{
      domainId: 7,
      name: "cogdemo",
    }],
  });

  const decision = await runCompetitivenessGateForTesting({
    rpc: createGateRpc({
      txids: [],
      rawTransactions: {},
      failMempoolVerbose: true,
    }) as any,
    readContext: context,
    candidate,
    currentTxid: null,
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.decision, "indeterminate-mempool-gate");
  assert.equal(decision.competitivenessGateIndeterminate, true);
  assert.equal(decision.indeterminateReason, "raw_mempool_verbose_unavailable");
  assert.equal(decision.diagnostics.visibleMempoolTxCount, null);
  assert.equal(decision.diagnostics.higherRankedCompetitorDomainCount, null);
  assert.equal(decision.diagnostics.dedupedCompetitorDomainCount, null);
});

test("runCompetitivenessGate reports raw mempool entry failures", async () => {
  const candidate = createGateCandidate();
  const context = createGateReadContext({
    domains: [{
      domainId: 7,
      name: "cogdemo",
    }],
  });

  const decision = await runCompetitivenessGateForTesting({
    rpc: {
      ...(createGateRpc({
        txids: ["aa".repeat(32)],
        rawTransactions: {},
      }) as any),
      async getRawMempoolEntries() {
        throw new Error("raw mempool entries unavailable");
      },
    } as any,
    readContext: context,
    candidate,
    currentTxid: null,
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.decision, "indeterminate-mempool-gate");
  assert.equal(decision.indeterminateReason, "raw_mempool_entries_unavailable");
  assert.equal(decision.diagnostics.visibleMempoolTxCount, 1);
  assert.equal(decision.diagnostics.higherRankedCompetitorDomainCount, null);
  assert.equal(decision.diagnostics.dedupedCompetitorDomainCount, null);
});

test("runCompetitivenessGate keeps publish semantics and cooperatively yields during large scans", async () => {
  const candidate = createGateCandidate({
    canonicalBlend: 1_000n,
    sentenceFill: "l",
  });
  const context = createGateReadContext({
    domains: [
      { domainId: 1, name: "alpha" },
      { domainId: 2, name: "bravo" },
      { domainId: 3, name: "cinder" },
      { domainId: 4, name: "delta" },
      { domainId: 7, name: "cogdemo" },
    ],
  });
  const rawTransactions: Record<string, ReturnType<typeof createMineTransaction>> = {};
  const assayScores: Record<string, bigint | null> = {};
  const txids: string[] = [];

  for (const [index, domain] of (context.model.domains as Array<{ domainId: number | null }>).filter((domain) => domain.domainId !== 7).entries()) {
    const txid = `${String(index + 7).padStart(2, "0")}`.repeat(32);
    const sentenceFill = String.fromCharCode("q".charCodeAt(0) + index);
    const sentence = sentenceFill.repeat(60);
    txids.push(txid);
    rawTransactions[txid] = createMineTransaction({
      txid,
      domainId: domain.domainId!,
      senderScriptPubKeyHex: candidate.sender.scriptPubKeyHex,
      referencedBlockHashInternal: candidate.referencedBlockHashInternal,
      sentenceFill,
    });
    assayScores[sentence] = BigInt(10 - index);
  }

  let yieldCalls = 0;
  const decision = await runCompetitivenessGateForTesting({
    rpc: createGateRpc({
      txids,
      rawTransactions,
    }) as any,
    readContext: context,
    candidate,
    currentTxid: null,
    assaySentencesImpl: createGateAssayStub(assayScores) as any,
    cooperativeYieldImpl: async () => {
      yieldCalls += 1;
    },
    cooperativeYieldEvery: 2,
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.decision, "publish");
  assert.equal(decision.higherRankedCompetitorDomainCount, 0);
  assert.equal(decision.candidateRank, 1);
  assert.equal(yieldCalls, 2);
});

test("runCompetitivenessGate uses bulk mempool metadata instead of per-tx mempool entry RPCs", async () => {
  const candidate = createGateCandidate();
  const context = createGateReadContext({
    domains: [{ domainId: 7, name: "cogdemo" }],
  });
  const txid = "aa".repeat(32);
  let mempoolEntryCalls = 0;

  await assert.doesNotReject(async () => {
    await runCompetitivenessGateForTesting({
      rpc: {
        ...(createGateRpc({
          txids: [txid],
          rawTransactions: {
            [txid]: createMineTransaction({
              txid,
              domainId: 7,
              senderScriptPubKeyHex: candidate.sender.scriptPubKeyHex,
              referencedBlockHashInternal: candidate.referencedBlockHashInternal,
              sentenceFill: "s",
            }),
          },
        }) as any),
        async getMempoolEntry() {
          mempoolEntryCalls += 1;
          throw new Error("getMempoolEntry should not be used by competitiveness gate");
        },
      },
      readContext: context,
      candidate,
      currentTxid: null,
      assaySentencesImpl: createGateAssayStub({
        ["s".repeat(60)]: 10n,
      }) as any,
    });
  });

  assert.equal(mempoolEntryCalls, 0);
});

test("raw transaction parser extracts txid, inputs, and OP_RETURN payload for the mempool index", () => {
  const rawHex = createRawTransactionHexForIndex("6a0161");
  const parsed = parseRawTransactionForMiningMempoolIndexTesting(rawHex);

  assert.notEqual(parsed, null);
  assert.equal(parsed?.txid.length, 64);
  assert.deepEqual(parsed?.inputTxids, ["11".repeat(32)]);
  assert.equal(Buffer.from(parsed?.payload ?? []).toString("hex"), "61");
});

function createPersistedMempoolIndexForTesting(options: {
  walletRootId: string;
  serviceIdentity: string;
  contexts?: Array<{
    txid: string;
    payloadHex?: string;
  }>;
  negativeTxids?: string[];
}) {
  return {
    schemaVersion: 1,
    walletRootId: options.walletRootId,
    serviceIdentity: options.serviceIdentity,
    contexts: (options.contexts ?? []).map((context) => ({
      txid: context.txid,
      senderScriptHex: "0014" + "11".repeat(20),
      inputTxids: ["ff".repeat(32)],
      payloadHex: context.payloadHex ?? createMinePayloadHex(1, Buffer.from("22".repeat(32), "hex"), "a"),
    })),
    negativeTxids: options.negativeTxids ?? [],
  };
}

async function writePersistedMempoolIndexForTesting(
  cachePath: string,
  cache: ReturnType<typeof createPersistedMempoolIndexForTesting>,
): Promise<void> {
  await writeFile(cachePath, `${JSON.stringify(cache)}\n`);
}

async function readPersistedMempoolIndexForTesting(
  cachePath: string,
): Promise<ReturnType<typeof createPersistedMempoolIndexForTesting>> {
  return JSON.parse(await readFile(cachePath, "utf8")) as ReturnType<typeof createPersistedMempoolIndexForTesting>;
}

test("hydrateMiningMempoolIndex prunes stale persisted negative txids and Cog contexts", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-index-gc-persisted");
  const cachePath = join(homeDirectory, "mempool-index.json");
  const walletRootId = "wallet-gc-1";
  const serviceIdentity = "service-1";
  const visibleCogTxid = "aa".repeat(32);
  const staleCogTxid = "bb".repeat(32);
  const visibleNegativeTxid = "cc".repeat(32);
  const staleNegativeTxid = "dd".repeat(32);

  await writePersistedMempoolIndexForTesting(cachePath, createPersistedMempoolIndexForTesting({
    walletRootId,
    serviceIdentity,
    contexts: [
      { txid: visibleCogTxid },
      { txid: staleCogTxid },
    ],
    negativeTxids: [visibleNegativeTxid, staleNegativeTxid],
  }));

  const result = await hydrateMiningMempoolIndex({
    walletRootId,
    serviceIdentity,
    cachePath,
    rpc: {
      async getRawTransaction() {
        throw new Error("persisted cache should cover the visible txids");
      },
    },
    visibleTxids: [visibleCogTxid, visibleNegativeTxid],
  });

  assert.equal(result.indexedContextCount, 1);
  assert.equal(result.negativeTxidCount, 1);
  assert.equal(result.unknownTxidCount, 0);
  assert.equal(result.hydratedCount, 0);

  const persisted = await readPersistedMempoolIndexForTesting(cachePath);
  assert.deepEqual(persisted.contexts.map((context) => context.txid), [visibleCogTxid]);
  assert.deepEqual(persisted.negativeTxids, [visibleNegativeTxid]);
});

test("hydrateMiningMempoolIndex compacts in-memory collections after large stale caches", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-index-gc-compact");
  const cachePath = join(homeDirectory, "mempool-index.json");
  const walletRootId = "wallet-gc-compact";
  const serviceIdentity = "service-1";
  const visibleCogTxid = "aa".repeat(32);
  const visibleNegativeTxid = "bb".repeat(32);
  const staleCogTxids = Array.from({ length: 512 }, (_, index) => `c${index.toString(16).padStart(63, "0")}`);
  const staleNegativeTxids = Array.from({ length: 2_048 }, (_, index) => `d${index.toString(16).padStart(63, "0")}`);

  await writePersistedMempoolIndexForTesting(cachePath, createPersistedMempoolIndexForTesting({
    walletRootId,
    serviceIdentity,
    contexts: [
      { txid: visibleCogTxid },
      ...staleCogTxids.map((txid) => ({ txid })),
    ],
    negativeTxids: [visibleNegativeTxid, ...staleNegativeTxids],
  }));

  const result = await hydrateMiningMempoolIndex({
    walletRootId,
    serviceIdentity,
    cachePath,
    rpc: {
      async getRawTransaction() {
        throw new Error("persisted cache should cover the visible txids");
      },
    },
    visibleTxids: [visibleCogTxid, visibleNegativeTxid],
  });

  assert.equal(result.indexedContextCount, 1);
  assert.equal(result.negativeTxidCount, 1);

  const diagnostics = readMiningMempoolIndexStateDiagnosticsForTesting()
    .find((entry) => entry.walletRootId === walletRootId && entry.serviceIdentity === serviceIdentity);
  assert.notEqual(diagnostics, undefined);
  assert.equal(diagnostics?.contextCount, 1);
  assert.equal(diagnostics?.negativeTxidCount, 1);
  assert.equal(diagnostics?.activeVisibleTxidCount, 2);
  assert.equal(diagnostics?.compactionCount, 1);

  const persisted = await readPersistedMempoolIndexForTesting(cachePath);
  assert.deepEqual(persisted.contexts.map((context) => context.txid), [visibleCogTxid]);
  assert.deepEqual(persisted.negativeTxids, [visibleNegativeTxid]);
});

test("hydrateMiningMempoolIndex persists GC before reporting hydration failure", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-index-gc-failure");
  const cachePath = join(homeDirectory, "mempool-index.json");
  const walletRootId = "wallet-gc-2";
  const serviceIdentity = "service-1";
  const visibleUnknownTxid = "aa".repeat(32);
  const staleNegativeTxid = "bb".repeat(32);

  await writePersistedMempoolIndexForTesting(cachePath, createPersistedMempoolIndexForTesting({
    walletRootId,
    serviceIdentity,
    negativeTxids: [staleNegativeTxid],
  }));

  await assert.rejects(
    async () => hydrateMiningMempoolIndex({
      walletRootId,
      serviceIdentity,
      cachePath,
      rpc: {
        async getRawTransaction() {
          throw new Error("mempool churn");
        },
      },
      visibleTxids: [visibleUnknownTxid],
    }),
    /mining_mempool_index_hydration_incomplete/u,
  );

  const persisted = await readPersistedMempoolIndexForTesting(cachePath);
  assert.deepEqual(persisted.contexts, []);
  assert.deepEqual(persisted.negativeTxids, []);
});

class FakeMiningRawTxSubscriber implements AsyncIterable<unknown> {
  connectedTo: string | null = null;
  subscribedTo: string | null = null;
  closed = false;
  readonly queue: unknown[] = [];
  waiter: ((result: IteratorResult<unknown>) => void) | null = null;

  connect(endpoint: string): void {
    this.connectedTo = endpoint;
  }

  subscribe(topic: string): void {
    this.subscribedTo = topic;
  }

  close(): void {
    this.closed = true;
    this.waiter?.({ done: true, value: undefined });
    this.waiter = null;
  }

  emit(frames: unknown): void {
    if (this.waiter !== null) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ done: false, value: frames });
      return;
    }

    this.queue.push(frames);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    while (true) {
      const queued = this.queue.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }

      if (this.closed) {
        return;
      }

      const next = await new Promise<IteratorResult<unknown>>((resolve) => {
        this.waiter = resolve;
      });
      if (next.done === true) {
        return;
      }
      yield next.value;
    }
  }
}

test("rawtx mempool index subscriber prewarms non-Cog txids outside the active visible snapshot", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-index-rawtx-visible");
  const cachePath = join(homeDirectory, "mempool-index.json");
  const walletRootId = "wallet-rawtx-1";
  const serviceIdentity = "service-1";
  const activeVisibleTxid = "aa".repeat(32);
  const outsideRawHex = createRawTransactionHexForIndex("6a0161");
  const outsideParsed = parseRawTransactionForMiningMempoolIndexTesting(outsideRawHex);
  assert.notEqual(outsideParsed, null);
  const outsideTxid = outsideParsed?.txid ?? "";
  assert.notEqual(outsideTxid, activeVisibleTxid);

  await hydrateMiningMempoolIndex({
    walletRootId,
    serviceIdentity,
    cachePath,
    rpc: {
      async getRawTransaction(txid: string) {
        return createNonCogTransaction(txid);
      },
    },
    visibleTxids: [activeVisibleTxid],
  });

  const createdSubscriber = { current: null as FakeMiningRawTxSubscriber | null };
  const ready = await ensureMiningMempoolRawTxSubscriber({
    walletRootId,
    serviceIdentity,
    cachePath,
    zmqEndpoint: "tcp://127.0.0.1:28332",
    rawTxTopic: "rawtx",
    async loadZeroMq() {
      return {
        Subscriber: class extends FakeMiningRawTxSubscriber {
          constructor() {
            super();
            createdSubscriber.current = this;
          }
        },
      };
    },
  });
  assert.equal(ready, true);
  const subscriber = createdSubscriber.current;
  assert.notEqual(subscriber, null);
  if (subscriber === null) {
    throw new Error("expected a subscriber instance");
  }
  subscriber.emit([Buffer.from("rawtx"), Buffer.from(outsideRawHex, "hex")]);
  await new Promise((resolve) => setTimeout(resolve, 1_100));

  const persisted = await readPersistedMempoolIndexForTesting(cachePath);
  assert.deepEqual(persisted.negativeTxids, [activeVisibleTxid]);
  assert.equal(persisted.negativeTxids.includes(outsideTxid), false);

  let rawTransactionCalls = 0;
  const hydrated = await hydrateMiningMempoolIndex({
    walletRootId,
    serviceIdentity,
    cachePath,
    rpc: {
      async getRawTransaction() {
        rawTransactionCalls += 1;
        throw new Error("prewarmed negative txid should not be hydrated by RPC");
      },
    },
    visibleTxids: [outsideTxid],
  });
  assert.equal(rawTransactionCalls, 0);
  assert.equal(hydrated.unknownTxidCount, 0);
  assert.equal(hydrated.hydratedCount, 0);
  assert.equal(hydrated.negativeTxidCount, 1);

  const persistedAfterHydration = await readPersistedMempoolIndexForTesting(cachePath);
  assert.deepEqual(persistedAfterHydration.negativeTxids, [outsideTxid]);
});

test("rawtx mempool index subscriber does not cache Cog payload txids as negative", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-index-rawtx-cog");
  const cachePath = join(homeDirectory, "mempool-index.json");
  const walletRootId = "wallet-rawtx-cog";
  const serviceIdentity = "service-cog";
  const referencedBlockHashInternal = Buffer.from("22".repeat(32), "hex");
  const cogPayloadHex = createMinePayloadHex(1, referencedBlockHashInternal, "a");
  const cogRawHex = createRawTransactionHexForIndex(
    `6a4c${(cogPayloadHex.length / 2).toString(16).padStart(2, "0")}${cogPayloadHex}`,
  );
  const cogParsed = parseRawTransactionForMiningMempoolIndexTesting(cogRawHex);
  assert.notEqual(cogParsed, null);
  const cogTxid = cogParsed?.txid ?? "";

  await hydrateMiningMempoolIndex({
    walletRootId,
    serviceIdentity,
    cachePath,
    rpc: {
      async getRawTransaction() {
        throw new Error("empty visible snapshot should not hydrate raw transactions");
      },
    },
    visibleTxids: [],
  });

  const createdSubscriber = { current: null as FakeMiningRawTxSubscriber | null };
  const ready = await ensureMiningMempoolRawTxSubscriber({
    walletRootId,
    serviceIdentity,
    cachePath,
    zmqEndpoint: "tcp://127.0.0.1:28332",
    rawTxTopic: "rawtx",
    async loadZeroMq() {
      return {
        Subscriber: class extends FakeMiningRawTxSubscriber {
          constructor() {
            super();
            createdSubscriber.current = this;
          }
        },
      };
    },
  });
  assert.equal(ready, true);
  const subscriber = createdSubscriber.current;
  assert.notEqual(subscriber, null);
  if (subscriber === null) {
    throw new Error("expected a subscriber instance");
  }
  subscriber.emit([Buffer.from("rawtx"), Buffer.from(cogRawHex, "hex")]);
  await new Promise((resolve) => setTimeout(resolve, 1_100));

  let rawTransactionCalls = 0;
  const hydrated = await hydrateMiningMempoolIndex({
    walletRootId,
    serviceIdentity,
    cachePath,
    rpc: {
      async getRawTransaction(txid: string) {
        rawTransactionCalls += 1;
        return createMineTransaction({
          txid,
          domainId: 1,
          senderScriptPubKeyHex: "0014" + "11".repeat(20),
          referencedBlockHashInternal,
          sentenceFill: "a",
        });
      },
    },
    visibleTxids: [cogTxid],
  });
  assert.equal(rawTransactionCalls, 1);
  assert.equal(hydrated.indexedContextCount, 1);
  assert.equal(hydrated.negativeTxidCount, 0);
});

test("pruneMiningMempoolIndexServicesForWallet retires superseded service identities only", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-index-service-prune");
  const cachePath = join(homeDirectory, "mempool-index.json");
  const walletRootId = "wallet-service-prune";
  const otherWalletRootId = "wallet-service-other";
  const serviceA = "service-a";
  const serviceB = "service-b";
  const otherService = "service-other";
  const subscriberA = { current: null as FakeMiningRawTxSubscriber | null };
  const subscriberB = { current: null as FakeMiningRawTxSubscriber | null };
  const otherSubscriber = { current: null as FakeMiningRawTxSubscriber | null };

  async function hydrateNegativeState(rootId: string, serviceIdentity: string, txid: string): Promise<void> {
    await hydrateMiningMempoolIndex({
      walletRootId: rootId,
      serviceIdentity,
      cachePath,
      rpc: {
        async getRawTransaction(requestTxid: string) {
          return createNonCogTransaction(requestTxid);
        },
      },
      visibleTxids: [txid],
    });
  }

  function createZeroMqLoader(target: { current: FakeMiningRawTxSubscriber | null }) {
    return async () => ({
      Subscriber: class extends FakeMiningRawTxSubscriber {
        constructor() {
          super();
          target.current = this;
        }
      },
    });
  }

  await hydrateNegativeState(walletRootId, serviceA, "aa".repeat(32));
  await ensureMiningMempoolRawTxSubscriber({
    walletRootId,
    serviceIdentity: serviceA,
    cachePath,
    zmqEndpoint: "tcp://127.0.0.1:28332",
    rawTxTopic: "rawtx",
    loadZeroMq: createZeroMqLoader(subscriberA),
  });
  await hydrateNegativeState(walletRootId, serviceB, "bb".repeat(32));
  await ensureMiningMempoolRawTxSubscriber({
    walletRootId,
    serviceIdentity: serviceB,
    cachePath,
    zmqEndpoint: "tcp://127.0.0.1:28333",
    rawTxTopic: "rawtx",
    loadZeroMq: createZeroMqLoader(subscriberB),
  });
  await hydrateNegativeState(otherWalletRootId, otherService, "cc".repeat(32));
  await ensureMiningMempoolRawTxSubscriber({
    walletRootId: otherWalletRootId,
    serviceIdentity: otherService,
    cachePath,
    zmqEndpoint: "tcp://127.0.0.1:28334",
    rawTxTopic: "rawtx",
    loadZeroMq: createZeroMqLoader(otherSubscriber),
  });

  assert.equal(subscriberA.current?.closed, false);
  assert.equal(subscriberB.current?.closed, false);
  assert.equal(otherSubscriber.current?.closed, false);

  await pruneMiningMempoolIndexServicesForWallet({
    walletRootId,
    cachePath,
    serviceIdentity: serviceB,
  });

  assert.equal(subscriberA.current?.closed, true);
  assert.equal(subscriberB.current?.closed, false);
  assert.equal(otherSubscriber.current?.closed, false);

  const diagnostics = readMiningMempoolIndexStateDiagnosticsForTesting();
  assert.equal(diagnostics.some((entry) =>
    entry.walletRootId === walletRootId && entry.serviceIdentity === serviceA
  ), false);
  assert.equal(diagnostics.some((entry) =>
    entry.walletRootId === walletRootId && entry.serviceIdentity === serviceB && entry.negativeTxidCount === 1
  ), true);
  assert.equal(diagnostics.some((entry) =>
    entry.walletRootId === otherWalletRootId && entry.serviceIdentity === otherService && entry.negativeTxidCount === 1
  ), true);
});

test("hydrateMiningMempoolIndex scopes large mixed-cache diagnostics to visible txids", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-index-gc-large");
  const cachePath = join(homeDirectory, "mempool-index.json");
  const walletRootId = "wallet-gc-3";
  const serviceIdentity = "service-1";
  const cogTxids = Array.from({ length: 40 }, (_, index) => `c${index.toString(16).padStart(63, "0")}`);
  const negativeTxids = Array.from({ length: 24 }, (_, index) => `d${index.toString(16).padStart(63, "0")}`);
  const unknownVisibleTxid = "ee".repeat(32);
  const visibleTxids = [
    cogTxids[0]!,
    cogTxids[1]!,
    negativeTxids[0]!,
    negativeTxids[1]!,
    negativeTxids[2]!,
    unknownVisibleTxid,
  ];

  await writePersistedMempoolIndexForTesting(cachePath, createPersistedMempoolIndexForTesting({
    walletRootId,
    serviceIdentity,
    contexts: cogTxids.map((txid) => ({ txid })),
    negativeTxids,
  }));

  const result = await hydrateMiningMempoolIndex({
    walletRootId,
    serviceIdentity,
    cachePath,
    rpc: {
      async getRawTransaction(txid: string) {
        return createNonCogTransaction(txid);
      },
    },
    visibleTxids,
  });

  assert.equal(result.indexedContextCount, 2);
  assert.equal(result.negativeTxidCount, 4);
  assert.equal(result.unknownTxidCount, 1);
  assert.equal(result.hydratedCount, 1);

  const persisted = await readPersistedMempoolIndexForTesting(cachePath);
  assert.deepEqual(persisted.contexts.map((context) => context.txid), [cogTxids[0], cogTxids[1]]);
  assert.deepEqual(persisted.negativeTxids, [negativeTxids[0], negativeTxids[1], negativeTxids[2], unknownVisibleTxid].sort());
});

test("runCompetitivenessGate uses persisted indexed contexts without refetching raw transactions", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-index-persisted");
  const cachePath = join(homeDirectory, "mempool-index.json");
  const candidate = createGateCandidate();
  const context = createGateReadContext({
    domains: [
      { domainId: 1, name: "alpha" },
      { domainId: 7, name: "cogdemo" },
    ],
  });
  const txid = "aa".repeat(32);
  let rawTransactionCalls = 0;
  const events: any[] = [];

  const rpc = {
    ...(createGateRpc({
      txids: [txid],
      rawTransactions: {
        [txid]: createMineTransaction({
          txid,
          domainId: 1,
          senderScriptPubKeyHex: candidate.sender.scriptPubKeyHex,
          referencedBlockHashInternal: candidate.referencedBlockHashInternal,
          sentenceFill: "a",
        }),
      },
    }) as any),
    async getRawTransaction(requestTxid: string) {
      rawTransactionCalls += 1;
      return createMineTransaction({
        txid: requestTxid,
        domainId: 1,
        senderScriptPubKeyHex: candidate.sender.scriptPubKeyHex,
        referencedBlockHashInternal: candidate.referencedBlockHashInternal,
        sentenceFill: "a",
      });
    },
    async getRawMempoolEntries() {
      throw new Error("indexed path should not fetch full mempool metadata");
    },
  };

  await runCompetitivenessGateForTesting({
    rpc: rpc as any,
    readContext: context,
    candidate,
    currentTxid: null,
    assaySentencesImpl: createGateAssayStub({
      ["a".repeat(60)]: 10n,
    }) as any,
    runId: "run-gate-1",
    appendEvent: async (event) => {
      events.push(event);
    },
    mempoolIndex: {
      rawTxSupported: true,
      cachePath,
      serviceIdentity: "service-1",
    },
  });

  assert.equal(rawTransactionCalls, 1);
  assert.equal(events.some((event) =>
    event.kind === "timing-mempool-hydration-start"
    && event.runId === "run-gate-1"
    && event.metrics?.visibleMempoolTxCount === 1
    && event.metrics?.mempoolSequence === "seq-1"
  ), true);
  const hydrationEnd = events.find((event) => event.kind === "timing-mempool-hydration-end");
  assert.notEqual(hydrationEnd, undefined);
  assert.equal(hydrationEnd?.durationMs >= 0, true);
  assert.equal(hydrationEnd?.metrics?.outcome, "success");
  assert.equal(hydrationEnd?.metrics?.cacheStatus, "index-warming");
  assert.equal(hydrationEnd?.metrics?.visibleMempoolTxCount, 1);
  assert.equal(hydrationEnd?.metrics?.unknownTxCount, 1);
  assert.equal(hydrationEnd?.metrics?.hydratedTxCount, 1);
  clearMiningGateCache(context.localState.walletRootId);
  clearMiningMempoolIndexCacheForTesting();

  const secondDecision = await runCompetitivenessGateForTesting({
    rpc: {
      ...(rpc as any),
      async getRawTransaction() {
        rawTransactionCalls += 1;
        throw new Error("persisted index should cover this txid");
      },
    } as any,
    readContext: context,
    candidate: createGateCandidate({ sentenceFill: "m" }),
    currentTxid: null,
    assaySentencesImpl: createGateAssayStub({
      ["a".repeat(60)]: 10n,
    }) as any,
    mempoolIndex: {
      rawTxSupported: true,
      cachePath,
      serviceIdentity: "service-1",
    },
  });

  assert.equal(rawTransactionCalls, 1);
  assert.equal(secondDecision.mempoolSequenceCacheStatus, "indexed");
});

test("runCompetitivenessGate evaluates hydrated indexed contexts", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-index-evaluate");
  const cachePath = join(homeDirectory, "mempool-index.json");
  const candidate = createGateCandidate();
  const context = createGateReadContext({
    domains: [
      { domainId: 7, name: "cogdemo" },
    ],
  });
  const txid = "aa".repeat(32);
  let rawMempoolEntryCalls = 0;

  const decision = await runCompetitivenessGateForTesting({
    rpc: {
      async getRawMempoolVerbose() {
        return {
          txids: [txid],
          mempool_sequence: "seq-1",
        };
      },
      async getRawMempoolEntries() {
        rawMempoolEntryCalls += 1;
        throw new Error("indexed path should not fetch full mempool metadata");
      },
      async getRawTransaction() {
        return createMineTransaction({
          txid,
          domainId: candidate.domainId,
          senderScriptPubKeyHex: candidate.sender.scriptPubKeyHex,
          referencedBlockHashInternal: candidate.referencedBlockHashInternal,
          sentenceFill: "a",
        });
      },
      async getMempoolEntry() {
        return {
          vsize: 200,
          fees: {
            base: 0.00001,
            ancestor: 0.00001,
            descendant: 0.00001,
          },
          ancestorsize: 200,
          descendantsize: 200,
        };
      },
    } as any,
    readContext: context,
    candidate,
    currentTxid: null,
    assaySentencesImpl: createGateAssayStub({
      ["a".repeat(60)]: candidate.canonicalBlend,
    }) as any,
    mempoolIndex: {
      rawTxSupported: true,
      cachePath,
      serviceIdentity: "service-1",
    },
  });

  assert.equal(rawMempoolEntryCalls, 0);
  assert.equal(decision.allowed, false);
  assert.equal(decision.decision, "suppressed-same-domain-mempool");
  assert.equal(decision.sameDomainCompetitorSuppressed, true);
  assert.equal(decision.mempoolSequenceCacheStatus, "index-warming");
});

test("runCompetitivenessGate hydrates only unknown indexed mempool deltas", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-index-delta");
  const cachePath = join(homeDirectory, "mempool-index.json");
  const candidate = createGateCandidate();
  const context = createGateReadContext({
    domains: [
      { domainId: 1, name: "alpha" },
      { domainId: 2, name: "bravo" },
      { domainId: 7, name: "cogdemo" },
    ],
  });
  const txidA = "aa".repeat(32);
  const txidB = "bb".repeat(32);
  let pass = 0;
  let rawTransactionCalls = 0;

  const rpc = {
    async getRawMempoolVerbose() {
      pass += 1;
      return {
        txids: pass === 1 ? [txidA] : [txidA, txidB],
        mempool_sequence: `seq-${pass}`,
      };
    },
    async getRawMempoolEntries() {
      throw new Error("indexed path should not fetch full mempool metadata");
    },
    async getRawTransaction(requestTxid: string) {
      rawTransactionCalls += 1;
      return createMineTransaction({
        txid: requestTxid,
        domainId: requestTxid === txidA ? 1 : 2,
        senderScriptPubKeyHex: candidate.sender.scriptPubKeyHex,
        referencedBlockHashInternal: candidate.referencedBlockHashInternal,
        sentenceFill: requestTxid === txidA ? "a" : "b",
      });
    },
    async getMempoolEntry() {
      return {
        vsize: 200,
        fees: {
          base: 0.00001,
          ancestor: 0.00001,
          descendant: 0.00001,
        },
        ancestorsize: 200,
        descendantsize: 200,
      };
    },
  };

  await runCompetitivenessGateForTesting({
    rpc: rpc as any,
    readContext: context,
    candidate,
    currentTxid: null,
    assaySentencesImpl: createGateAssayStub({
      ["a".repeat(60)]: 10n,
      ["b".repeat(60)]: 9n,
    }) as any,
    mempoolIndex: {
      rawTxSupported: true,
      cachePath,
      serviceIdentity: "service-1",
    },
  });
  clearMiningGateCache(context.localState.walletRootId);
  const decision = await runCompetitivenessGateForTesting({
    rpc: rpc as any,
    readContext: context,
    candidate,
    currentTxid: null,
    assaySentencesImpl: createGateAssayStub({
      ["a".repeat(60)]: 10n,
      ["b".repeat(60)]: 9n,
    }) as any,
    mempoolIndex: {
      rawTxSupported: true,
      cachePath,
      serviceIdentity: "service-1",
    },
  });

  assert.equal(rawTransactionCalls, 2);
  assert.equal(decision.mempoolSequenceCacheStatus, "index-warming");
});

test("runCompetitivenessGate retries indexed hydration against a fresh mempool snapshot after churn", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-index-hydration-churn");
  const cachePath = join(homeDirectory, "mempool-index.json");
  const candidate = createGateCandidate();
  const context = createGateReadContext({
    domains: [
      { domainId: 1, name: "alpha" },
      { domainId: 7, name: "cogdemo" },
    ],
  });
  const disappearedTxid = "aa".repeat(32);
  const competitorTxid = "bb".repeat(32);
  let verboseCalls = 0;
  let rawTransactionCalls = 0;

  const decision = await runCompetitivenessGateForTesting({
    rpc: {
      async getRawMempoolVerbose() {
        verboseCalls += 1;
        return {
          txids: verboseCalls === 1 ? [disappearedTxid, competitorTxid] : [competitorTxid],
          mempool_sequence: `seq-${verboseCalls}`,
        };
      },
      async getRawMempoolEntries() {
        throw new Error("indexed path should not fetch full mempool metadata");
      },
      async getRawTransaction(txid: string) {
        rawTransactionCalls += 1;
        if (txid === disappearedTxid) {
          throw new Error("mempool churn removed this tx");
        }

        return createMineTransaction({
          txid,
          domainId: 1,
          senderScriptPubKeyHex: candidate.sender.scriptPubKeyHex,
          referencedBlockHashInternal: candidate.referencedBlockHashInternal,
          sentenceFill: "a",
        });
      },
      async getMempoolEntry(txid: string) {
        assert.equal(txid, competitorTxid);
        return {
          vsize: 200,
          fees: {
            base: 0.00001,
            ancestor: 0.00001,
            descendant: 0.00001,
          },
          ancestorsize: 200,
          descendantsize: 200,
        };
      },
    } as any,
    readContext: context,
    candidate,
    currentTxid: null,
    assaySentencesImpl: createGateAssayStub({
      ["a".repeat(60)]: 10n,
    }) as any,
    mempoolIndex: {
      rawTxSupported: true,
      cachePath,
      serviceIdentity: "service-1",
    },
  });

  assert.equal(verboseCalls, 2);
  assert.equal(rawTransactionCalls, 2);
  assert.notEqual(decision.indeterminateReason, "mempool_index_hydration_incomplete");
  assert.equal(decision.competitivenessGateIndeterminate, false);
  assert.equal(decision.diagnostics.visibleMempoolTxCount, 1);
  assert.equal(decision.diagnostics.indexedContextCount, 1);
  assert.equal(decision.diagnostics.mempoolSequence, "seq-2");
  const persisted = await readPersistedMempoolIndexForTesting(cachePath);
  assert.deepEqual(persisted.contexts.map((entry) => entry.txid), [competitorTxid]);
  assert.equal(persisted.negativeTxids.includes(disappearedTxid), false);
});

test("runCompetitivenessGate stays indeterminate when indexed unknown hydration fails", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-index-hydration-fail");
  const cachePath = join(homeDirectory, "mempool-index.json");
  const candidate = createGateCandidate();
  const context = createGateReadContext({
    domains: [
      { domainId: 1, name: "alpha" },
      { domainId: 7, name: "cogdemo" },
    ],
  });
  let verboseCalls = 0;
  let rawTransactionCalls = 0;

  const decision = await runCompetitivenessGateForTesting({
    rpc: {
      async getRawMempoolVerbose() {
        verboseCalls += 1;
        return {
          txids: ["aa".repeat(32), "bb".repeat(32)],
          mempool_sequence: `seq-${verboseCalls}`,
        };
      },
      async getRawMempoolEntries() {
        throw new Error("failed indexed hydration must not fall back to unsafe full scan");
      },
      async getRawTransaction(txid: string) {
        rawTransactionCalls += 1;
        if (txid === "aa".repeat(32)) {
          throw new Error("transient raw transaction failure");
        }

        return createMineTransaction({
          txid,
          domainId: 1,
          senderScriptPubKeyHex: candidate.sender.scriptPubKeyHex,
          referencedBlockHashInternal: candidate.referencedBlockHashInternal,
          sentenceFill: "a",
        });
      },
      async getMempoolEntry() {
        throw new Error("unused");
      },
    } as any,
    readContext: context,
    candidate,
    currentTxid: null,
    mempoolIndex: {
      rawTxSupported: true,
      cachePath,
      serviceIdentity: "service-1",
    },
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.decision, "indeterminate-mempool-gate");
  assert.equal(decision.competitivenessGateIndeterminate, true);
  assert.equal(decision.indeterminateReason, "mempool_index_hydration_incomplete");
  assert.equal(decision.mempoolSequenceCacheStatus, "index-warming");
  assert.equal(verboseCalls, 2);
  assert.equal(rawTransactionCalls, 3);
  assert.equal(decision.diagnostics.visibleMempoolTxCount, 2);
  assert.equal(decision.diagnostics.indexedContextCount, 1);
  assert.equal(decision.diagnostics.negativeTxCount, 0);
  assert.equal(decision.diagnostics.unknownTxCount, 1);
  assert.equal(decision.diagnostics.hydratedTxCount, 0);
  assert.equal(decision.diagnostics.cacheStatus, "index-warming");
  assert.equal(decision.diagnostics.mempoolSequence, "seq-2");
  assert.equal(decision.diagnostics.higherRankedCompetitorDomainCount, null);
  assert.equal(decision.diagnostics.dedupedCompetitorDomainCount, null);
});

test("runCompetitivenessGate reports indexed entry failures when fallback cannot verify", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-index-entry-fail");
  const cachePath = join(homeDirectory, "mempool-index.json");
  const candidate = createGateCandidate();
  const context = createGateReadContext({
    domains: [
      { domainId: 7, name: "cogdemo" },
    ],
  });
  const txid = "aa".repeat(32);

  const decision = await runCompetitivenessGateForTesting({
    rpc: {
      async getRawMempoolVerbose() {
        return {
          txids: [txid],
          mempool_sequence: "seq-1",
        };
      },
      async getRawMempoolEntries() {
        throw new Error("fallback mempool entries unavailable");
      },
      async getRawTransaction() {
        return createMineTransaction({
          txid,
          domainId: candidate.domainId,
          senderScriptPubKeyHex: candidate.sender.scriptPubKeyHex,
          referencedBlockHashInternal: candidate.referencedBlockHashInternal,
          sentenceFill: "a",
        });
      },
      async getMempoolEntry() {
        throw new Error("indexed mempool entry unavailable");
      },
    } as any,
    readContext: context,
    candidate,
    currentTxid: null,
    mempoolIndex: {
      rawTxSupported: true,
      cachePath,
      serviceIdentity: "service-1",
    },
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.decision, "indeterminate-mempool-gate");
  assert.equal(decision.indeterminateReason, "indexed_mempool_entry_unavailable");
  assert.equal(decision.diagnostics.visibleMempoolTxCount, 1);
  assert.equal(decision.diagnostics.indexedContextCount, 1);
  assert.equal(decision.diagnostics.cacheStatus, "fallback-scan");
});

test("runCompetitivenessGate reports unsupported ancestor overlays", async () => {
  const candidate = createGateCandidate();
  const context = createGateReadContext({
    domains: [
      { domainId: 7, name: "cogdemo" },
    ],
  });
  const parentTxid = "bb".repeat(32);
  const childTxid = "aa".repeat(32);

  const decision = await runCompetitivenessGateForTesting({
    rpc: createGateRpc({
      txids: [parentTxid, childTxid],
      rawTransactions: {
        [parentTxid]: {
          txid: parentTxid,
          vin: [{ txid: "ff".repeat(32), prevout: { scriptPubKey: { hex: candidate.sender.scriptPubKeyHex } } }],
          vout: [{
            n: 0,
            value: 0,
            scriptPubKey: {
              hex: "6a04434f47ff",
            },
          }],
        } as ReturnType<typeof createMineTransaction>,
        [childTxid]: createMineTransaction({
          txid: childTxid,
          domainId: candidate.domainId,
          senderScriptPubKeyHex: candidate.sender.scriptPubKeyHex,
          referencedBlockHashInternal: candidate.referencedBlockHashInternal,
          sentenceFill: "a",
          parentTxid,
        }),
      },
    }) as any,
    readContext: context,
    candidate,
    currentTxid: null,
    assaySentencesImpl: createGateAssayStub({
      ["a".repeat(60)]: candidate.canonicalBlend,
    }) as any,
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.decision, "indeterminate-mempool-gate");
  assert.equal(decision.indeterminateReason, "unsupported_ancestor_overlay");
  assert.equal(decision.diagnostics.visibleMempoolTxCount, 2);
  assert.equal(decision.diagnostics.higherRankedCompetitorDomainCount, null);
  assert.equal(decision.diagnostics.dedupedCompetitorDomainCount, null);
});

test("runCompetitivenessGate reports rank evaluation failures", async () => {
  const candidate = createGateCandidate({
    encodedSentenceBytes: null,
  });
  const context = createGateReadContext({
    domains: [
      { domainId: 7, name: "cogdemo" },
    ],
  });

  const decision = await runCompetitivenessGateForTesting({
    rpc: createGateRpc({
      txids: [],
      rawTransactions: {},
    }) as any,
    readContext: context,
    candidate,
    currentTxid: null,
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.decision, "indeterminate-mempool-gate");
  assert.equal(decision.indeterminateReason, "rank_evaluation_failed");
  assert.equal(decision.diagnostics.higherRankedCompetitorDomainCount, null);
  assert.equal(decision.diagnostics.dedupedCompetitorDomainCount, null);
});

test("runCompetitivenessGate reports fallback-scan when rawtx support is absent", async () => {
  const candidate = createGateCandidate();
  const context = createGateReadContext({
    domains: [
      { domainId: 1, name: "alpha" },
      { domainId: 7, name: "cogdemo" },
    ],
  });
  const txid = "aa".repeat(32);
  let mempoolEntryCalls = 0;

  const decision = await runCompetitivenessGateForTesting({
    rpc: {
      ...(createGateRpc({
        txids: [txid],
        rawTransactions: {
          [txid]: createMineTransaction({
            txid,
            domainId: 1,
            senderScriptPubKeyHex: candidate.sender.scriptPubKeyHex,
            referencedBlockHashInternal: candidate.referencedBlockHashInternal,
            sentenceFill: "a",
          }),
        },
      }) as any),
      async getMempoolEntry() {
        mempoolEntryCalls += 1;
        throw new Error("fallback scan should not use targeted mempool entries");
      },
    },
    readContext: context,
    candidate,
    currentTxid: null,
    assaySentencesImpl: createGateAssayStub({
      ["a".repeat(60)]: 10n,
    }) as any,
    mempoolIndex: {
      rawTxSupported: false,
      cachePath: "unused",
      serviceIdentity: "legacy-service",
    },
  });

  assert.equal(mempoolEntryCalls, 0);
  assert.equal(decision.mempoolSequenceCacheStatus, "fallback-scan");
});

test("runCompetitivenessGate reuses cached raw tx contexts across tip changes", async () => {
  const context = createGateReadContext({
    domains: [
      { domainId: 1, name: "alpha" },
      { domainId: 7, name: "cogdemo" },
    ],
  });
  const firstCandidate = createGateCandidate({
    referencedBlockHashDisplay: "11".repeat(32),
    referencedBlockHashInternal: Buffer.from("22".repeat(32), "hex"),
  });
  const secondCandidate = createGateCandidate({
    referencedBlockHashDisplay: "33".repeat(32),
    referencedBlockHashInternal: Buffer.from("44".repeat(32), "hex"),
  });
  const txid = "aa".repeat(32);
  let rawTransactionCalls = 0;

  const rpc = {
    async getRawMempoolVerbose() {
      return {
        txids: [txid],
        mempool_sequence: "seq-1",
      };
    },
    async getRawMempoolEntries() {
      return {
        [txid]: {
          vsize: 200,
          fees: {
            base: 0.00001,
            ancestor: 0.00001,
            descendant: 0.00001,
          },
          ancestorsize: 200,
          descendantsize: 200,
        },
      };
    },
    async getRawTransaction(requestTxid: string) {
      rawTransactionCalls += 1;
      return createMineTransaction({
        txid: requestTxid,
        domainId: 1,
        senderScriptPubKeyHex: firstCandidate.sender.scriptPubKeyHex,
        referencedBlockHashInternal: firstCandidate.referencedBlockHashInternal,
        sentenceFill: "a",
      });
    },
    async getMempoolEntry() {
      throw new Error("unused");
    },
  };

  await runCompetitivenessGateForTesting({
    rpc: rpc as any,
    readContext: context,
    candidate: firstCandidate,
    currentTxid: null,
    assaySentencesImpl: createGateAssayStub({
      ["a".repeat(60)]: 10n,
    }) as any,
  });
  await runCompetitivenessGateForTesting({
    rpc: rpc as any,
    readContext: context,
    candidate: secondCandidate,
    currentTxid: null,
    assaySentencesImpl: createGateAssayStub({}) as any,
  });

  assert.equal(rawTransactionCalls, 1);
});

test("runCompetitivenessGate only fetches raw transaction deltas for newly added mempool txids", async () => {
  const context = createGateReadContext({
    domains: [
      { domainId: 1, name: "alpha" },
      { domainId: 2, name: "bravo" },
      { domainId: 7, name: "cogdemo" },
    ],
  });
  const candidate = createGateCandidate();
  const txidA = "aa".repeat(32);
  const txidB = "bb".repeat(32);
  let rawTransactionCalls = 0;
  let pass = 0;

  const rpc = {
    async getRawMempoolVerbose() {
      pass += 1;
      return {
        txids: pass === 1 ? [txidA] : [txidA, txidB],
        mempool_sequence: pass === 1 ? "seq-1" : "seq-2",
      };
    },
    async getRawMempoolEntries() {
      const txids = pass === 1 ? [txidA] : [txidA, txidB];
      return Object.fromEntries(txids.map((txid) => [txid, {
        vsize: 200,
        fees: {
          base: 0.00001,
          ancestor: 0.00001,
          descendant: 0.00001,
        },
        ancestorsize: 200,
        descendantsize: 200,
      }]));
    },
    async getRawTransaction(requestTxid: string) {
      rawTransactionCalls += 1;
      return createMineTransaction({
        txid: requestTxid,
        domainId: requestTxid === txidA ? 1 : 2,
        senderScriptPubKeyHex: candidate.sender.scriptPubKeyHex,
        referencedBlockHashInternal: candidate.referencedBlockHashInternal,
        sentenceFill: requestTxid === txidA ? "a" : "b",
      });
    },
    async getMempoolEntry() {
      throw new Error("unused");
    },
  };

  await runCompetitivenessGateForTesting({
    rpc: rpc as any,
    readContext: context,
    candidate,
    currentTxid: null,
    assaySentencesImpl: createGateAssayStub({
      ["a".repeat(60)]: 10n,
      ["b".repeat(60)]: 9n,
    }) as any,
  });
  await runCompetitivenessGateForTesting({
    rpc: rpc as any,
    readContext: context,
    candidate,
    currentTxid: null,
    assaySentencesImpl: createGateAssayStub({
      ["a".repeat(60)]: 10n,
      ["b".repeat(60)]: 9n,
    }) as any,
  });

  assert.equal(rawTransactionCalls, 2);
});

test("runCompetitivenessGate prunes removed raw tx contexts and refetches them when they return", async () => {
  const context = createGateReadContext({
    domains: [
      { domainId: 1, name: "alpha" },
      { domainId: 2, name: "bravo" },
      { domainId: 7, name: "cogdemo" },
    ],
  });
  const candidate = createGateCandidate();
  const txidA = "aa".repeat(32);
  const txidB = "bb".repeat(32);
  let rawTransactionCalls = 0;
  let pass = 0;

  const rpc = {
    async getRawMempoolVerbose() {
      pass += 1;
      return {
        txids: pass === 1 ? [txidA, txidB] : pass === 2 ? [txidA] : [txidA, txidB],
        mempool_sequence: `seq-${pass}`,
      };
    },
    async getRawMempoolEntries() {
      const txids = pass === 1 ? [txidA, txidB] : pass === 2 ? [txidA] : [txidA, txidB];
      return Object.fromEntries(txids.map((txid) => [txid, {
        vsize: 200,
        fees: {
          base: 0.00001,
          ancestor: 0.00001,
          descendant: 0.00001,
        },
        ancestorsize: 200,
        descendantsize: 200,
      }]));
    },
    async getRawTransaction(requestTxid: string) {
      rawTransactionCalls += 1;
      return createMineTransaction({
        txid: requestTxid,
        domainId: requestTxid === txidA ? 1 : 2,
        senderScriptPubKeyHex: candidate.sender.scriptPubKeyHex,
        referencedBlockHashInternal: candidate.referencedBlockHashInternal,
        sentenceFill: requestTxid === txidA ? "a" : "b",
      });
    },
    async getMempoolEntry() {
      throw new Error("unused");
    },
  };

  for (let index = 0; index < 3; index += 1) {
    await runCompetitivenessGateForTesting({
      rpc: rpc as any,
      readContext: context,
      candidate,
      currentTxid: null,
      assaySentencesImpl: createGateAssayStub({
        ["a".repeat(60)]: 10n,
        ["b".repeat(60)]: 9n,
      }) as any,
    });
  }

  assert.equal(rawTransactionCalls, 3);
});

test("runCompetitivenessGate reports warmup progress while loading missing raw transactions", async () => {
  const candidate = createGateCandidate();
  const context = createGateReadContext({
    domains: [
      { domainId: 1, name: "alpha" },
      { domainId: 2, name: "bravo" },
      { domainId: 3, name: "cinder" },
      { domainId: 4, name: "delta" },
      { domainId: 5, name: "ember" },
      { domainId: 6, name: "fable" },
      { domainId: 7, name: "cogdemo" },
    ],
  });
  const txids = Array.from({ length: 30 }, (_, index) => `${(index + 1).toString(16).padStart(64, "0")}`);
  const progressUpdates: Array<{ processed: number; total: number }> = [];

  await runCompetitivenessGateForTesting({
    rpc: {
      async getRawMempoolVerbose() {
        return {
          txids,
          mempool_sequence: "seq-1",
        };
      },
      async getRawMempoolEntries() {
        return Object.fromEntries(txids.map((txid) => [txid, {
          vsize: 200,
          fees: {
            base: 0.00001,
            ancestor: 0.00001,
            descendant: 0.00001,
          },
          ancestorsize: 200,
          descendantsize: 200,
        }]));
      },
      async getRawTransaction(txid: string) {
        return createMineTransaction({
          txid,
          domainId: 1,
          senderScriptPubKeyHex: candidate.sender.scriptPubKeyHex,
          referencedBlockHashInternal: candidate.referencedBlockHashInternal,
          sentenceFill: "a",
        });
      },
      async getMempoolEntry() {
        throw new Error("unused");
      },
    } as any,
    readContext: context,
    candidate,
    currentTxid: null,
    assaySentencesImpl: createGateAssayStub({
      ["a".repeat(60)]: 10n,
    }) as any,
    onWarmupProgress: async (progress) => {
      progressUpdates.push(progress);
    },
  });

  assert.deepEqual(progressUpdates[0], {
    processed: 0,
    total: 30,
  });
  assert.deepEqual(progressUpdates.at(-1), {
    processed: 30,
    total: 30,
  });
  assert.ok(progressUpdates.some((progress) => progress.processed > 0 && progress.processed < progress.total));
});

test("topologicallyOrderAncestorTxidsForTesting handles deep ancestor chains without recursion", () => {
  const depth = 12_000;
  const txContexts = new Map<string, {
    txid: string;
    rawTransaction: {
      txid: string;
      vin: Array<{ txid?: string; prevout?: { scriptPubKey?: { hex?: string } } }>;
      vout: Array<{ n: number; value: number | string; scriptPubKey?: { hex?: string } }>;
    };
  }>();

  for (let index = 1; index <= depth; index += 1) {
    txContexts.set(`tx-${index}`, {
      txid: `tx-${index}`,
      rawTransaction: {
        txid: `tx-${index}`,
        vin: [{
          txid: index === 1 ? "external" : `tx-${index - 1}`,
        }],
        vout: [],
      },
    });
  }

  const ordered = topologicallyOrderAncestorTxidsForTesting({
    txid: `tx-${depth}`,
    txContexts,
  });

  assert.equal(ordered?.length, depth - 1);
  assert.equal(ordered?.[0], "tx-1");
  assert.equal(ordered?.at(-1), `tx-${depth - 1}`);
});
