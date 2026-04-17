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
  publishCandidateForTesting,
  refreshMiningCandidateFromCurrentStateForTesting,
  resetMiningUiForTipForTesting,
  resolveSettledBoardForTesting,
  resolveMiningConflictOutpointForTesting,
  shouldKeepCurrentTipLivePublishForTesting,
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
    anchorOutpoint: {
      txid: "aa".repeat(32),
      vout: 0,
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
  anchorOutpoint: { txid: string; vout: number };
  miningState?: ReturnType<typeof createMiningState>;
  close?: () => Promise<void>;
}) {
  const state = createWalletState({
    managedCoreWallet: {
      walletName: "wallet.dat",
      internalPassphrase: "passphrase",
      descriptorChecksum: "abcd1234",
      walletAddress: "bc1qfunding",
      walletScriptPubKeyHex: "0014" + "11".repeat(20),
      proofStatus: "ready",
      lastImportedAtUnixMs: null,
      lastVerifiedAtUnixMs: null,
    },
    domains: [{
      name: "cogdemo",
      currentCanonicalAnchorOutpoint: {
        txid: options.anchorOutpoint.txid,
        vout: options.anchorOutpoint.vout,
        valueSats: 2_000,
      },
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

test("settled mining board resolves previous-block winners and falls back when domain metadata is missing", () => {
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
    targetBlockHeight: 101,
  });

  assert.equal(settled.settledBlockHeight, 100);
  assert.deepEqual(settled.settledBoardEntries, [
    { rank: 1, domainName: "cogdemo", sentence: "Under the trees, a monkey helped." },
    { rank: 2, domainName: "domain-8", sentence: "Youth carried the basket home." },
  ]);
});

test("publish-time candidate refresh rebinds to the latest canonical anchor outpoint", () => {
  const candidate = createTestMiningCandidate();
  const refreshed = refreshMiningCandidateFromCurrentStateForTesting(
    createReadyMiningReadContext({
      anchorOutpoint: {
        txid: "bb".repeat(32),
        vout: 2,
      },
    }),
    candidate,
  );

  assert.notEqual(refreshed, null);
  assert.deepEqual(refreshed?.anchorOutpoint, {
    txid: "bb".repeat(32),
    vout: 2,
  });
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
    candidate: createTestMiningCandidate({
      anchorOutpoint: {
        txid: "11".repeat(32),
        vout: 1,
      },
    }),
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
    candidate: createTestMiningCandidate({
      anchorOutpoint: {
        txid: "11".repeat(32),
        vout: 1,
      },
    }),
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

  assert.deepEqual(conflict, {
    txid: "22".repeat(32),
    vout: 3,
  });
  assert.deepEqual(liveConflict, {
    txid: "aa".repeat(32),
    vout: 0,
  });
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
    fallbackState: createReadyMiningReadContext({
      anchorOutpoint: {
        txid: "bb".repeat(32),
        vout: 1,
      },
    }).localState.state,
    openReadContext: async () => createReadyMiningReadContext({
      anchorOutpoint: {
        txid: "bb".repeat(32),
        vout: 1,
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
  assert.equal(result.candidate.anchorOutpoint.txid, "bb".repeat(32));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "publish-retry-pending");
  assert.equal(events[0]?.reason, "missing-inputs");
});

test("publish candidate reuses the same selected sentence across same-tip retries", async () => {
  const closeCalls: number[] = [];
  const contexts = [
    createReadyMiningReadContext({
      anchorOutpoint: {
        txid: "bb".repeat(32),
        vout: 1,
      },
      close: async () => {
        closeCalls.push(1);
      },
    }),
    createReadyMiningReadContext({
      anchorOutpoint: {
        txid: "cc".repeat(32),
        vout: 2,
      },
      close: async () => {
        closeCalls.push(2);
      },
    }),
  ];
  const seenAnchors: string[] = [];
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
      seenAnchors.push(`${candidate.anchorOutpoint.txid}:${candidate.anchorOutpoint.vout}`);
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
      seenAnchors.push(`${candidate.anchorOutpoint.txid}:${candidate.anchorOutpoint.vout}`);
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
  assert.equal(second.candidate.anchorOutpoint.txid, "cc".repeat(32));
  assert.deepEqual(seenAnchors, [
    `${"bb".repeat(32)}:1`,
    `${"cc".repeat(32)}:2`,
  ]);
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
    fallbackState: createReadyMiningReadContext({
      anchorOutpoint: {
        txid: "bb".repeat(32),
        vout: 1,
      },
    }).localState.state,
    openReadContext: async () => createReadyMiningReadContext({
      anchorOutpoint: {
        txid: "bb".repeat(32),
        vout: 1,
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
  assert.equal(result.decision, "publish-skipped-stale-candidate");
  assert.equal(result.candidate, null);
  assert.match(result.note, /no longer locally mineable/i);
});
