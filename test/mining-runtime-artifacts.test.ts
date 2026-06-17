import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  loadMiningRuntimeStatus,
  saveForegroundMiningHeartbeatStatus,
  saveMiningRuntimeStatus,
} from "../src/wallet/mining/runtime-artifacts.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import { createMiningRuntimeStatus } from "./current-model-helpers.js";

test("mining runtime artifacts round-trip the not-found provider state", async (t) => {
  const dir = await createTrackedTempDirectory(t, "cogcoin-mining-runtime-artifacts");
  const statusPath = join(dir, "status.json");

  await saveMiningRuntimeStatus(statusPath, createMiningRuntimeStatus({
    providerState: "not-found",
  }));

  const loaded = await loadMiningRuntimeStatus(statusPath);
  assert.equal(loaded?.providerState, "not-found");
});

test("mining runtime artifacts normalize new optional status fields to null", async (t) => {
  const dir = await createTrackedTempDirectory(t, "cogcoin-mining-runtime-artifacts-legacy-fields");
  const statusPath = join(dir, "status.json");
  const legacy = createMiningRuntimeStatus() as unknown as Record<string, unknown>;
  delete legacy["foregroundPid"];
  delete legacy["foregroundRunId"];
  delete legacy["foregroundHeartbeatAtUnixMs"];
  delete legacy["cycleStartedAtUnixMs"];
  delete legacy["phaseEnteredAtUnixMs"];
  delete legacy["indexerStatusTipHeight"];
  delete legacy["indexerStatusTipHash"];
  delete legacy["indexerObservedAtUnixMs"];
  delete legacy["attemptTargetBlockHeight"];
  delete legacy["attemptReferencedBlockHashDisplay"];
  delete legacy["attemptIndexerSnapshotSeq"];
  delete legacy["livePublishTargetBlockHeight"];
  delete legacy["livePublishReferencedBlockHashDisplay"];
  delete legacy["livePublishTxid"];
  delete legacy["livePublishDecision"];
  delete legacy["livePublishStaleToCoreTip"];

  await writeFile(statusPath, `${JSON.stringify(legacy)}\n`, "utf8");

  const loaded = await loadMiningRuntimeStatus(statusPath);
  assert.equal(loaded?.foregroundPid, null);
  assert.equal(loaded?.foregroundRunId, null);
  assert.equal(loaded?.foregroundHeartbeatAtUnixMs, null);
  assert.equal(loaded?.cycleStartedAtUnixMs, null);
  assert.equal(loaded?.phaseEnteredAtUnixMs, null);
  assert.equal(loaded?.indexerStatusTipHeight, null);
  assert.equal(loaded?.indexerStatusTipHash, null);
  assert.equal(loaded?.indexerObservedAtUnixMs, null);
  assert.equal(loaded?.attemptTargetBlockHeight, null);
  assert.equal(loaded?.attemptReferencedBlockHashDisplay, null);
  assert.equal(loaded?.attemptIndexerSnapshotSeq, null);
  assert.equal(loaded?.livePublishTargetBlockHeight, null);
  assert.equal(loaded?.livePublishReferencedBlockHashDisplay, null);
  assert.equal(loaded?.livePublishTxid, null);
  assert.equal(loaded?.livePublishDecision, null);
  assert.equal(loaded?.livePublishStaleToCoreTip, null);
});

test("mining runtime artifacts backfill live publish fields from legacy status", async (t) => {
  const dir = await createTrackedTempDirectory(t, "cogcoin-mining-runtime-artifacts-live-publish-legacy");
  const statusPath = join(dir, "status.json");
  const legacy = createMiningRuntimeStatus({
    targetBlockHeight: 101,
    referencedBlockHashDisplay: "11".repeat(32),
    indexerSnapshotSeq: "seq-100",
    currentTxid: "aa".repeat(32),
    livePublishInMempool: true,
    currentPublishDecision: "kept-live-publish",
  }) as unknown as Record<string, unknown>;
  delete legacy["attemptTargetBlockHeight"];
  delete legacy["attemptReferencedBlockHashDisplay"];
  delete legacy["attemptIndexerSnapshotSeq"];
  delete legacy["livePublishTargetBlockHeight"];
  delete legacy["livePublishReferencedBlockHashDisplay"];
  delete legacy["livePublishTxid"];
  delete legacy["livePublishDecision"];
  delete legacy["livePublishStaleToCoreTip"];

  await writeFile(statusPath, `${JSON.stringify(legacy)}\n`, "utf8");

  const loaded = await loadMiningRuntimeStatus(statusPath);
  assert.equal(loaded?.attemptTargetBlockHeight, 101);
  assert.equal(loaded?.attemptReferencedBlockHashDisplay, "11".repeat(32));
  assert.equal(loaded?.attemptIndexerSnapshotSeq, "seq-100");
  assert.equal(loaded?.livePublishTargetBlockHeight, 101);
  assert.equal(loaded?.livePublishReferencedBlockHashDisplay, "11".repeat(32));
  assert.equal(loaded?.livePublishTxid, "aa".repeat(32));
  assert.equal(loaded?.livePublishDecision, "kept-live-publish");
  assert.equal(loaded?.livePublishStaleToCoreTip, null);
});

test("foreground mining heartbeat writes preserve newer full cycle snapshots", async (t) => {
  const dir = await createTrackedTempDirectory(t, "cogcoin-mining-runtime-artifacts-heartbeat-ordering");
  const statusPath = join(dir, "status.json");

  await saveMiningRuntimeStatus(statusPath, createMiningRuntimeStatus({
    updatedAtUnixMs: 10_000,
    runMode: "foreground",
    foregroundPid: 123,
    foregroundRunId: "run-1",
    foregroundHeartbeatAtUnixMs: 10_000,
    cycleStartedAtUnixMs: 9_000,
    phaseEnteredAtUnixMs: 9_500,
    currentPhase: "scoring",
    targetBlockHeight: 101,
    currentDomainName: "cogdemo",
    lastError: "full snapshot error",
    note: "full snapshot note",
  }));

  await saveForegroundMiningHeartbeatStatus({
    statusPath,
    foregroundPid: 123,
    foregroundRunId: "run-1",
    heartbeatAtUnixMs: 10_500,
    tipStatus: {
      coreBestHeight: 101,
      coreBestHash: "11".repeat(32),
      indexerTipHeight: 101,
      indexerTipHash: "11".repeat(32),
      indexerStatusTipHeight: 101,
      indexerStatusTipHash: "11".repeat(32),
      indexerSnapshotSeq: "seq-101",
      indexerTruthSource: "lease",
      indexerTipAligned: true,
      targetBlockHeight: 102,
      referencedBlockHashDisplay: "11".repeat(32),
      attemptTargetBlockHeight: 102,
      attemptReferencedBlockHashDisplay: "11".repeat(32),
      attemptIndexerSnapshotSeq: "seq-101",
    },
  });

  let loaded = await loadMiningRuntimeStatus(statusPath);
  assert.equal(loaded?.updatedAtUnixMs, 10_000);
  assert.equal(loaded?.foregroundHeartbeatAtUnixMs, 10_500);
  assert.equal(loaded?.cycleStartedAtUnixMs, 9_000);
  assert.equal(loaded?.phaseEnteredAtUnixMs, 9_500);
  assert.equal(loaded?.currentPhase, "scoring");
  assert.equal(loaded?.coreBestHeight, 101);
  assert.equal(loaded?.indexerTipHeight, 101);
  assert.equal(loaded?.indexerStatusTipHeight, 101);
  assert.equal(loaded?.indexerSnapshotSeq, "seq-101");
  assert.equal(loaded?.targetBlockHeight, 102);
  assert.equal(loaded?.referencedBlockHashDisplay, "11".repeat(32));
  assert.equal(loaded?.attemptTargetBlockHeight, 102);
  assert.equal(loaded?.attemptReferencedBlockHashDisplay, "11".repeat(32));
  assert.equal(loaded?.attemptIndexerSnapshotSeq, "seq-101");
  assert.equal(loaded?.currentDomainName, "cogdemo");
  assert.equal(loaded?.lastError, "full snapshot error");
  assert.equal(loaded?.note, "full snapshot note");

  await saveMiningRuntimeStatus(statusPath, createMiningRuntimeStatus({
    updatedAtUnixMs: 11_000,
    runMode: "foreground",
    foregroundPid: 123,
    foregroundRunId: "run-1",
    foregroundHeartbeatAtUnixMs: 11_000,
    cycleStartedAtUnixMs: 10_900,
    phaseEnteredAtUnixMs: 11_000,
    currentPhase: "publishing",
    targetBlockHeight: 102,
    currentDomainName: "newdomain",
    lastError: null,
    note: "new full snapshot",
  }));
  await saveForegroundMiningHeartbeatStatus({
    statusPath,
    foregroundPid: 123,
    foregroundRunId: "run-1",
    heartbeatAtUnixMs: 10_750,
  });

  loaded = await loadMiningRuntimeStatus(statusPath);
  assert.equal(loaded?.updatedAtUnixMs, 11_000);
  assert.equal(loaded?.foregroundHeartbeatAtUnixMs, 11_000);
  assert.equal(loaded?.cycleStartedAtUnixMs, 10_900);
  assert.equal(loaded?.phaseEnteredAtUnixMs, 11_000);
  assert.equal(loaded?.currentPhase, "publishing");
  assert.equal(loaded?.targetBlockHeight, 102);
  assert.equal(loaded?.currentDomainName, "newdomain");
  assert.equal(loaded?.note, "new full snapshot");
});

test("foreground mining heartbeat explains waiting-bitcoin-network publishability reason", async (t) => {
  const dir = await createTrackedTempDirectory(t, "cogcoin-mining-runtime-artifacts-heartbeat-publishability");
  const statusPath = join(dir, "status.json");

  await saveMiningRuntimeStatus(statusPath, createMiningRuntimeStatus({
    runMode: "foreground",
    foregroundPid: 123,
    foregroundRunId: "run-1",
    foregroundHeartbeatAtUnixMs: 1_000,
    currentPhase: "waiting-bitcoin-network",
    readinessBlocker: "bitcoin-core",
    corePublishState: "unknown",
    note: "Mining is waiting for the local Bitcoin node to become publishable.",
  }));

  await saveForegroundMiningHeartbeatStatus({
    statusPath,
    foregroundPid: 123,
    foregroundRunId: "run-1",
    heartbeatAtUnixMs: 2_000,
    tipStatus: {
      coreBestHeight: 117,
      coreBestHash: "77".repeat(32),
      corePublishState: "mempool-loading",
      targetBlockHeight: 118,
      referencedBlockHashDisplay: "77".repeat(32),
    },
  });

  const loaded = await loadMiningRuntimeStatus(statusPath);
  assert.equal(loaded?.currentPhase, "waiting-bitcoin-network");
  assert.equal(loaded?.readinessBlocker, "bitcoin-core");
  assert.equal(loaded?.corePublishState, "mempool-loading");
  assert.equal(loaded?.note, "Mining is waiting because Bitcoin Core is still loading its mempool.");
  assert.equal(loaded?.coreBestHeight, 117);
  assert.equal(loaded?.targetBlockHeight, 118);
});

test("foreground mining heartbeat clears stale waiting-bitcoin-network when Core becomes publishable", async (t) => {
  const dir = await createTrackedTempDirectory(t, "cogcoin-mining-runtime-artifacts-heartbeat-publishable");
  const statusPath = join(dir, "status.json");

  await saveMiningRuntimeStatus(statusPath, createMiningRuntimeStatus({
    runMode: "foreground",
    foregroundPid: 123,
    foregroundRunId: "run-1",
    foregroundHeartbeatAtUnixMs: 1_000,
    currentPhase: "waiting-bitcoin-network",
    readinessBlocker: "bitcoin-core",
    corePublishState: "mempool-loading",
    note: "Mining is waiting because Bitcoin Core is still loading its mempool.",
  }));

  await saveForegroundMiningHeartbeatStatus({
    statusPath,
    foregroundPid: 123,
    foregroundRunId: "run-1",
    heartbeatAtUnixMs: 2_000,
    tipStatus: {
      coreBestHeight: 118,
      coreBestHash: "88".repeat(32),
      corePublishState: "healthy",
      targetBlockHeight: 119,
      referencedBlockHashDisplay: "88".repeat(32),
    },
  });

  const loaded = await loadMiningRuntimeStatus(statusPath);
  assert.equal(loaded?.currentPhase, "idle");
  assert.equal(loaded?.readinessBlocker, null);
  assert.equal(loaded?.corePublishState, "healthy");
  assert.equal(loaded?.note, null);
  assert.equal(loaded?.coreBestHeight, 118);
  assert.equal(loaded?.targetBlockHeight, 119);
});

test("foreground mining heartbeat projects quiescent Core/indexer mismatch as tip-alignment wait", async (t) => {
  const dir = await createTrackedTempDirectory(t, "cogcoin-mining-runtime-artifacts-heartbeat-tip-alignment");
  const statusPath = join(dir, "status.json");
  const indexedHash = "11".repeat(32);
  const coreHash = "22".repeat(32);

  await saveMiningRuntimeStatus(statusPath, createMiningRuntimeStatus({
    runMode: "foreground",
    foregroundPid: 123,
    foregroundRunId: "run-1",
    foregroundHeartbeatAtUnixMs: 1_000,
    currentPhase: "waiting",
    readinessBlocker: null,
    coreBestHeight: 951_397,
    coreBestHash: indexedHash,
    indexerStatusTipHeight: 951_397,
    indexerStatusTipHash: indexedHash,
    targetBlockHeight: 951_398,
    referencedBlockHashDisplay: indexedHash,
    note: "Mining already attempted the current Bitcoin tip and is waiting for Bitcoin Core to report the next block.",
  }));

  await saveForegroundMiningHeartbeatStatus({
    statusPath,
    foregroundPid: 123,
    foregroundRunId: "run-1",
    heartbeatAtUnixMs: 2_000,
    tipStatus: {
      coreBestHeight: 951_398,
      coreBestHash: coreHash,
      indexerStatusTipHeight: 951_397,
      indexerStatusTipHash: indexedHash,
      indexerTipAligned: false,
      tipsAligned: false,
      targetBlockHeight: 951_399,
      referencedBlockHashDisplay: coreHash,
    },
  });

  const loaded = await loadMiningRuntimeStatus(statusPath);
  assert.equal(loaded?.coreBestHeight, 951_398);
  assert.equal(loaded?.coreBestHash, coreHash);
  assert.equal(loaded?.indexerStatusTipHeight, 951_397);
  assert.equal(loaded?.indexerStatusTipHash, indexedHash);
  assert.equal(loaded?.targetBlockHeight, 951_399);
  assert.equal(loaded?.referencedBlockHashDisplay, coreHash);
  assert.equal(loaded?.currentPhase, "waiting-indexer");
  assert.equal(loaded?.readinessBlocker, "tip-alignment");
  assert.equal(loaded?.tipsAligned, false);
  assert.equal(loaded?.note, "Mining is waiting for Bitcoin Core and the indexer to align.");
});

test("foreground mining heartbeat preserves active phase and attempt fields while live Core tip advances", async (t) => {
  const dir = await createTrackedTempDirectory(t, "cogcoin-mining-runtime-artifacts-heartbeat-active-mismatch");
  const statusPath = join(dir, "status.json");
  const indexedHash = "11".repeat(32);
  const coreHash = "22".repeat(32);

  await saveMiningRuntimeStatus(statusPath, createMiningRuntimeStatus({
    runMode: "foreground",
    foregroundPid: 123,
    foregroundRunId: "run-1",
    foregroundHeartbeatAtUnixMs: 1_000,
    currentPhase: "scoring",
    readinessBlocker: null,
    coreBestHeight: 951_397,
    coreBestHash: indexedHash,
    indexerStatusTipHeight: 951_397,
    indexerStatusTipHash: indexedHash,
    targetBlockHeight: 951_398,
    referencedBlockHashDisplay: indexedHash,
    attemptTargetBlockHeight: 951_398,
    attemptReferencedBlockHashDisplay: indexedHash,
    attemptIndexerSnapshotSeq: "seq-951397",
    note: "Scoring mining candidates for block #951398.",
  }));

  await saveForegroundMiningHeartbeatStatus({
    statusPath,
    foregroundPid: 123,
    foregroundRunId: "run-1",
    heartbeatAtUnixMs: 2_000,
    tipStatus: {
      coreBestHeight: 951_398,
      coreBestHash: coreHash,
      indexerStatusTipHeight: 951_397,
      indexerStatusTipHash: indexedHash,
      indexerTipAligned: false,
      tipsAligned: false,
      targetBlockHeight: 951_399,
      referencedBlockHashDisplay: coreHash,
    },
  });

  const loaded = await loadMiningRuntimeStatus(statusPath);
  assert.equal(loaded?.coreBestHeight, 951_398);
  assert.equal(loaded?.targetBlockHeight, 951_399);
  assert.equal(loaded?.referencedBlockHashDisplay, coreHash);
  assert.equal(loaded?.attemptTargetBlockHeight, 951_398);
  assert.equal(loaded?.attemptReferencedBlockHashDisplay, indexedHash);
  assert.equal(loaded?.attemptIndexerSnapshotSeq, "seq-951397");
  assert.equal(loaded?.currentPhase, "scoring");
  assert.equal(loaded?.readinessBlocker, null);
  assert.equal(loaded?.tipsAligned, false);
  assert.equal(loaded?.note, "Scoring mining candidates for block #951398.");
});
