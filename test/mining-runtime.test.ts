import test from "node:test";
import assert from "node:assert/strict";

import {
  clearMiningPublishState,
  miningPublishIsInMempool,
  miningPublishMayStillExist,
  normalizeMiningStateRecord,
} from "../src/wallet/mining/state.js";
import {
  cacheSelectedCandidateForTipForTesting,
  createMiningLoopStateForTesting,
  getSelectedCandidateForTipForTesting,
  loadMiningVisibleFollowBlockTimesForTesting,
  publishCandidateForTesting,
  refreshMiningCandidateFromCurrentStateForTesting,
  resolveFundingDisplaySatsForTesting,
  resetMiningUiForTipForTesting,
  resolveSettledBoardForTesting,
  resolveMiningConflictOutpointForTesting,
  shouldKeepCurrentTipLivePublishForTesting,
  syncMiningVisualizerBlockTimesForTesting,
} from "../src/wallet/mining/runner.js";
import { createMiningState, createWalletReadContext, createWalletState } from "./current-model-helpers.js";

function createTestMiningCandidate(overrides: Record<string, unknown> = {}) {
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
    bip39WordIndices: [1, 2, 3, 4, 5],
    bip39Words: ["under", "tree", "monkey", "youth", "basket"],
    canonicalBlend: 1000n,
    referencedBlockHashDisplay: "11".repeat(32),
    referencedBlockHashInternal: Buffer.from("22".repeat(32), "hex"),
    targetBlockHeight: 101,
    ...overrides,
  } as any;
}

function createReadyMiningReadContext(options: {
  miningState?: ReturnType<typeof createMiningState>;
  close?: () => Promise<void>;
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
          },
          history: {
            foundingMessageByDomain: new Map(),
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
    }),
    close: options.close ?? (async () => undefined),
  } as any;
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
    { rank: 1, domainName: "cogdemo", sentence: "Under the trees, a monkey helped." },
    { rank: 2, domainName: "domain-8", sentence: "Youth carried the basket home." },
  ]);
});

test("mining board header tracks the newest mined block and blanks rows until the snapshot catches up", () => {
  const snapshotState = {
    consensus: {
      domainsById: new Map(),
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

  assert.equal(settled.settledBlockHeight, 101);
  assert.deepEqual(settled.settledBoardEntries, []);
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
    { rank: 1, domainName: "cogdemo", sentence: "Snapshot tip sentence." },
  ]);
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

  cacheSelectedCandidateForTipForTesting(loopState, "tip-1", candidate);

  assert.equal(getSelectedCandidateForTipForTesting(loopState, "tip-1"), candidate);
  assert.equal(getSelectedCandidateForTipForTesting(loopState, "tip-2"), null);

  resetMiningUiForTipForTesting(loopState, 102);

  assert.equal(getSelectedCandidateForTipForTesting(loopState, "tip-1"), null);
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
