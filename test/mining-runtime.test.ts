import test from "node:test";
import assert from "node:assert/strict";

import {
  clearMiningPublishState,
  miningPublishIsInMempool,
  miningPublishMayStillExist,
  normalizeMiningStateRecord,
} from "../src/wallet/mining/state.js";
import {
  resolveSettledBoardForTesting,
  shouldKeepCurrentTipLivePublishForTesting,
} from "../src/wallet/mining/runner.js";
import { createMiningState } from "./current-model-helpers.js";

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
