import assert from "node:assert/strict";
import test from "node:test";

import {
  MiningFollowVisualizer,
  describeMiningVisualizerProgress,
  describeMiningVisualizerStatus,
} from "../src/wallet/mining/visualizer.js";
import type { MiningRuntimeStatusV1 } from "../src/wallet/mining/types.js";

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
