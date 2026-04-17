import assert from "node:assert/strict";
import test from "node:test";

import {
  createEmptyMiningFollowVisualizerState,
  MiningFollowVisualizer,
  describeMiningVisualizerProgress,
  describeMiningVisualizerStatus,
} from "../src/wallet/mining/visualizer.js";
import type { FollowSceneRenderOptions } from "../src/bitcoind/progress/tty-renderer.js";
import type { MiningRuntimeStatusV1 } from "../src/wallet/mining/types.js";
import type { MiningFollowVisualizerState } from "../src/wallet/mining/visualizer.js";

class MemoryStream {
  readonly chunks: string[] = [];
  isTTY?: boolean;
  columns?: number;

  constructor(options: { isTTY?: boolean; columns?: number } = {}) {
    this.isTTY = options.isTTY;
    this.columns = options.columns;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  toString(): string {
    return this.chunks.join("");
  }
}

function createSnapshot(
  partial: Partial<MiningRuntimeStatusV1> = {},
): MiningRuntimeStatusV1 {
  return {
    schemaVersion: 1,
    walletRootId: "wallet-root-test",
    workerApiVersion: null,
    workerBinaryVersion: null,
    workerBuildId: null,
    updatedAtUnixMs: 1_700_000_000_000,
    runMode: "foreground",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    backgroundWorkerHeartbeatAtUnixMs: null,
    backgroundWorkerHealth: null,
    indexerDaemonState: "synced",
    indexerDaemonInstanceId: "daemon-1",
    indexerSnapshotSeq: "seq-1",
    indexerSnapshotOpenedAtUnixMs: 1_700_000_000_000,
    indexerTruthSource: "lease",
    indexerHeartbeatAtUnixMs: 1_700_000_000_000,
    coreBestHeight: 100,
    coreBestHash: "00".repeat(32),
    indexerTipHeight: 100,
    indexerTipHash: "11".repeat(32),
    indexerReorgDepth: null,
    indexerTipAligned: true,
    corePublishState: "healthy",
    providerState: "ready",
    lastSuspendDetectedAtUnixMs: null,
    reconnectSettledUntilUnixMs: null,
    tipSettledUntilUnixMs: null,
    miningState: "idle",
    currentPhase: "idle",
    currentPublishState: "none",
    targetBlockHeight: null,
    referencedBlockHashDisplay: null,
    currentDomainId: null,
    currentDomainName: null,
    currentSentenceDisplay: null,
    currentCanonicalBlend: null,
    currentTxid: null,
    currentWtxid: null,
    livePublishInMempool: false,
    currentFeeRateSatVb: null,
    currentAbsoluteFeeSats: null,
    currentBlockFeeSpentSats: "0",
    sessionFeeSpentSats: "0",
    lifetimeFeeSpentSats: "0",
    sameDomainCompetitorSuppressed: null,
    higherRankedCompetitorDomainCount: null,
    dedupedCompetitorDomainCount: null,
    competitivenessGateIndeterminate: null,
    mempoolSequenceCacheStatus: null,
    currentPublishDecision: null,
    lastMempoolSequence: null,
    lastCompetitivenessGateAtUnixMs: null,
    pauseReason: null,
    providerConfigured: true,
    providerKind: "openai",
    bitcoindHealth: "ready",
    bitcoindServiceState: "ready",
    bitcoindReplicaStatus: "ready",
    nodeHealth: "synced",
    indexerHealth: "synced",
    tipsAligned: true,
    lastEventAtUnixMs: null,
    lastError: null,
    note: null,
    ...partial,
  };
}

function createUiState(
  partial: Partial<MiningFollowVisualizerState> = {},
): MiningFollowVisualizerState {
  return {
    ...createEmptyMiningFollowVisualizerState(),
    ...partial,
  };
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

test("mining follow visualizer renders the follow scene on tty streams", () => {
  const stream = new MemoryStream({ isTTY: true, columns: 120 });
  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    stream,
  });

  visualizer.update(createSnapshot({
    currentPhase: "generating",
    note: "Generating mining sentences for eligible root domains.",
  }));
  visualizer.close();

  const output = stream.toString();
  assert.match(output, /Generating candidates/);
  assert.match(output, /Generating mining sentences for eligible root domains\./);
});

test("mining follow visualizer stays quiet when tty progress is disabled", () => {
  const stream = new MemoryStream({ isTTY: true, columns: 120 });
  const visualizer = new MiningFollowVisualizer({
    progressOutput: "none",
    stream,
  });

  visualizer.update(createSnapshot({
    currentPhase: "publishing",
    currentPublishDecision: "broadcast",
  }));
  visualizer.close();

  assert.equal(stream.toString(), "");
});

test("mining visualizer descriptions surface zero-reward and note overrides", () => {
  const zeroRewardSnapshot = createSnapshot({
    currentPhase: "idle",
    pauseReason: "zero-reward",
  });

  assert.equal(describeMiningVisualizerStatus(zeroRewardSnapshot), "Zero-reward height");

  const notedSnapshot = createSnapshot({
    currentPhase: "waiting-indexer",
    note: "Custom mining note.",
  });

  assert.equal(describeMiningVisualizerProgress(notedSnapshot), "Custom mining note.");
});

test("mining follow visualizer keeps the sentence board and footer block permanently allocated", () => {
  let capturedOptions: FollowSceneRenderOptions | undefined;

  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    stream: new MemoryStream({ isTTY: true, columns: 120 }),
    rendererFactory: () => ({
      renderFollowScene(
        _progress,
        _cogcoinSyncHeight,
        _cogcoinSyncTargetHeight,
        _followScene,
        _statusFieldText,
        renderOptions,
      ) {
        capturedOptions = renderOptions;
      },
      close() {
        // no-op
      },
    }),
  });

  visualizer.update(createSnapshot(), createUiState({
    balanceCogtoshi: 123_450_000n,
    balanceSats: 42n,
    settledBlockHeight: 100,
    settledBoardEntries: [
      { rank: 1, domainName: "alpha", sentence: "alpha sentence" },
      { rank: 2, domainName: "beta", sentence: "beta sentence" },
    ],
    provisionalRequiredWords: ["under", "tree", "monkey", "youth", "basket"],
    provisionalEntry: {
      domainName: "local",
      sentence: "local sentence",
    },
    latestSentence: "local sentence",
    latestTxid: "ab".repeat(32),
  }));
  visualizer.close();

  assert.deepEqual(capturedOptions, {
    artworkCogText: "1.2345 COG",
    artworkSatText: "42 SAT",
    extraLines: [
      "✎ Block #100 Sentences ✎",
      "",
      "1. @alpha: alpha sentence",
      "2. @beta: beta sentence",
      "3.",
      "4.",
      "5.",
      "----------",
      "Required words: UNDER, TREE, MONKEY, YOUTH, BASKET",
      "@local: local sentence",
    ],
  });
});

test("mining follow visualizer keeps blank self and footer lines when no candidate exists yet", () => {
  let capturedOptions: FollowSceneRenderOptions | undefined;

  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    stream: new MemoryStream({ isTTY: true, columns: 120 }),
    rendererFactory: () => ({
      renderFollowScene(
        _progress,
        _cogcoinSyncHeight,
        _cogcoinSyncTargetHeight,
        _followScene,
        _statusFieldText,
        renderOptions,
      ) {
        capturedOptions = renderOptions;
      },
      close() {
        // no-op
      },
    }),
  });

  visualizer.update(createSnapshot(), createUiState({
    settledBlockHeight: 101,
  }));
  visualizer.close();

  assert.equal(capturedOptions?.artworkCogText, null);
  assert.equal(capturedOptions?.artworkSatText, null);
  assert.deepEqual(capturedOptions?.extraLines, [
    "✎ Block #101 Sentences ✎",
    "",
    "1.",
    "2.",
    "3.",
    "4.",
    "5.",
    "----------",
    "",
    "",
  ]);
});

test("mining follow visualizer keeps a fixed-height frame across empty, unpublished, and published states", () => {
  const stream = new MemoryStream({ isTTY: true, columns: 120 });
  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    stream,
  });

  visualizer.update(createSnapshot({
    currentPhase: "waiting",
  }), createUiState({
    settledBlockHeight: 102,
  }));
  visualizer.update(createSnapshot({
    currentPhase: "waiting",
  }), createUiState({
    settledBlockHeight: 102,
    provisionalRequiredWords: ["under", "tree", "monkey", "youth", "basket"],
    provisionalEntry: {
      domainName: "local",
      sentence: "candidate not published",
    },
    latestSentence: "candidate not published",
  }));
  visualizer.update(createSnapshot({
    currentPhase: "waiting",
  }), createUiState({
    settledBlockHeight: 102,
    settledBoardEntries: [
      { rank: 1, domainName: "alpha", sentence: "alpha sentence" },
    ],
    provisionalRequiredWords: ["under", "tree", "monkey", "youth", "basket"],
    provisionalEntry: {
      domainName: "local",
      sentence: "candidate published",
    },
    latestSentence: "candidate published",
    latestTxid: "cd".repeat(32),
  }));
  visualizer.close();

  const expectedFrameHeight = 26;
  assert.equal(countMatches(stream.chunks[1] ?? "", /\u001B\[2K/g), expectedFrameHeight);
  assert.equal(countMatches(stream.chunks[1] ?? "", /\u001B\[1A/g), expectedFrameHeight - 1);
  assert.equal(countMatches(stream.chunks[3] ?? "", /\u001B\[2K/g), expectedFrameHeight);
  assert.equal(countMatches(stream.chunks[3] ?? "", /\u001B\[1A/g), expectedFrameHeight - 1);
});

test("mining visualizer status prefers the recent settled win banner", () => {
  const status = describeMiningVisualizerStatus(
    createSnapshot({
      currentPhase: "waiting",
    }),
    createUiState({
      recentWin: {
        rank: 2,
        rewardCogtoshi: 123_000_000n,
        blockHeight: 101,
      },
    }),
  );

  assert.equal(status, "You got #2 and mined 1.23 COG in block #101");
});
