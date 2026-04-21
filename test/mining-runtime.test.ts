import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import net from "node:net";
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
  resolveMiningConflictOutpoint as resolveMiningConflictOutpointForTesting,
} from "../src/wallet/mining/publish.js";
import {
  applyMiningRuntimeStatusOverrides,
  buildPrePublishStatusOverrides as buildPrePublishStatusOverridesForTesting,
} from "../src/wallet/mining/projection.js";
import {
  refreshMiningCandidateFromCurrentState as refreshMiningCandidateFromCurrentStateForTesting,
} from "../src/wallet/mining/candidate.js";
import {
  runCompetitivenessGate,
  topologicallyOrderAncestorTxidsForTesting,
} from "../src/wallet/mining/competitiveness.js";
import {
  loadMiningVisibleFollowBlockTimes as loadMiningVisibleFollowBlockTimesForTesting,
  resolveFundingDisplaySats as resolveFundingDisplaySatsForTesting,
  resolveSettledBoard as resolveSettledBoardForTesting,
  syncMiningVisualizerBlockTimes as syncMiningVisualizerBlockTimesForTesting,
} from "../src/wallet/mining/visualizer-sync.js";
import { loadMiningRuntimeStatus } from "../src/wallet/mining/runtime-artifacts.js";
import { serializeMine } from "../src/wallet/cogop/index.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  createMemoryWalletSecretProviderForTesting,
  createWalletSecretReference,
} from "../src/wallet/state/provider.js";
import { MiningProviderRequestError } from "../src/wallet/mining/sentences.js";
import type { MiningFollowVisualizerState } from "../src/wallet/mining/visualizer.js";
import {
  createMiningControlPlaneView,
  createMiningState,
  createWalletReadContext,
  createWalletState,
} from "./current-model-helpers.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import { createHealthyMiningRpc } from "./mining-rpc-test-helpers.js";

const MANAGED_CORE_WALLET_LOCKED_ERROR =
  "bitcoind_rpc_walletprocesspsbt_-13_Please enter the wallet passphrase with walletpassphrase first.";

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
            binaryVersion: "1.1.7",
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

async function runCompetitivenessGateForTesting(options: {
  rpc: Parameters<typeof runCompetitivenessGate>[0]["rpc"];
  readContext: Parameters<typeof runCompetitivenessGate>[0]["readContext"];
  candidate: Parameters<typeof runCompetitivenessGate>[0]["candidate"];
  currentTxid: string | null;
  assaySentencesImpl?: Parameters<typeof runCompetitivenessGate>[0]["assaySentencesImpl"];
  cooperativeYieldImpl?: Parameters<typeof runCompetitivenessGate>[0]["cooperativeYield"];
  cooperativeYieldEvery?: Parameters<typeof runCompetitivenessGate>[0]["cooperativeYieldEvery"];
}) {
  return await runCompetitivenessGate({
    rpc: options.rpc,
    readContext: options.readContext,
    candidate: options.candidate,
    currentTxid: options.currentTxid,
    assaySentencesImpl: options.assaySentencesImpl,
    cooperativeYield: options.cooperativeYieldImpl,
    cooperativeYieldEvery: options.cooperativeYieldEvery,
  });
}

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
  const payload = Buffer.from(
    serializeMine(domainId, referencedBlockHashInternal, createEncodedMiningSentence(sentenceFill)).opReturnData,
  );
  return `6a${payload.length.toString(16).padStart(2, "0")}${payload.toString("hex")}`;
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

function createGateReadContext(options: {
  domains: Array<{
    domainId: number;
    name: string;
    ownerScriptPubKeyHex?: string;
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
        walletScriptPubKeyHex,
        domains: options.domains.map((domain) => ({
          name: domain.name,
          anchored: domain.anchored ?? true,
          readOnly: false,
          localRelationship: "local",
          domainId: domain.domainId,
          ownerAddress: (domain.ownerScriptPubKeyHex ?? walletScriptPubKeyHex) === walletScriptPubKeyHex
            ? state.funding.address
            : null,
          ownerScriptPubKeyHex: domain.ownerScriptPubKeyHex ?? walletScriptPubKeyHex,
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
              delegate: null,
              miner: null,
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
      nodeStatus: {
        chain: "mainnet",
        nodeBestHeight: 100,
        nodeBestHashHex: "11".repeat(32),
        walletReplica: {
          proofStatus: "ready",
        },
      },
      ...options.readContextOverrides,
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
  assert.equal(snapshot?.note, "Mining is waiting for Bitcoin Core and the indexer to align.");
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
  assert.equal(snapshot?.note, "Mining is waiting for the sentence provider to recover.");
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
  assert.equal(loopState.attemptedTipKey, null);
  assert.equal(loopState.providerTransientFailureCount, 1);
  assert.equal(loopState.providerWaitNextRetryAtUnixMs, 31_000);
  assert.equal(generateCalls, 1);

  await runCycle(30_000);
  snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(snapshot?.currentPhase, "waiting-provider");
  assert.equal(snapshot?.providerState, "backoff");
  assert.equal(snapshot?.lastError, timeoutMessage);
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
  assert.equal(loopState.providerWaitNextRetryAtUnixMs, null);
  assert.notEqual(loopState.attemptedTipKey, null);
  assert.equal(generateCalls, 1);

  await runCycle(2_000);
  snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(snapshot?.currentPhase, "waiting-provider");
  assert.equal(snapshot?.providerState, "auth-error");
  assert.equal(snapshot?.lastError, authMessage);
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
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "publish-retry-pending");
  assert.equal(events[0]?.reason, "missing-inputs");
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
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "publish-paused-insufficient-funds");
  assert.equal(events[0]?.reason, "insufficient-funds");
  assert.doesNotMatch(events[0]?.message ?? "", /walletcreatefundedpsbt/i);
  assert.match(events[0]?.message ?? "", /with safe BTC/i);
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
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "publish-retry-pending");
  assert.equal(events[0]?.reason, "managed-core-wallet-locked");
});

test("pre-publish status on a new tip shows the pending candidate instead of stale prior-tip tx metadata", () => {
  const state = createWalletState({
    miningState: createMiningState({
      currentPublishState: "in-mempool",
      currentDomain: "mitfrog",
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
    domainName: "mitfrog",
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
  assert.equal(snapshot.currentDomainName, "mitfrog");
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

test("publish candidate skips the tip when the selected domain is no longer locally mineable", async () => {
  const result = await publishCandidateForTesting({
    candidate: createTestMiningCandidate({
      domainId: 99,
      domainName: "mitmissing",
    }),
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
      throw new Error("publishAttempt should not run for stale candidates");
    },
    appendEventFn: async () => undefined,
  });

  assert.equal(result.skipped, true);
  assert.equal(result.retryable, undefined);
  assert.equal(result.txid, null);
  assert.equal(result.decision, "publish-skipped-stale-candidate");
  assert.equal(result.candidate, null);
  assert.match(result.note, /no longer locally mineable/i);
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
