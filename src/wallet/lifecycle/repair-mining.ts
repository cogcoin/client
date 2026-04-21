import { rm } from "node:fs/promises";
import { join } from "node:path";

import { readLockMetadata } from "../fs/lock.js";
import { readMiningGenerationActivity } from "../mining/coordination.js";
import { loadClientConfig } from "../mining/config.js";
import { saveMiningRuntimeStatus } from "../mining/runtime-artifacts.js";
import { normalizeMiningStateRecord } from "../mining/state.js";
import type { MiningRuntimeStatusV1 } from "../mining/types.js";
import type { WalletRuntimePaths } from "../runtime.js";
import { createWalletSecretReference, type WalletSecretProvider } from "../state/provider.js";
import { persistWalletStateUpdate } from "../descriptor-normalization.js";
import type { WalletStateV1 } from "../types.js";
import { isProcessAlive, stopRecordedManagedProcess } from "./repair-runtime.js";
import type { WalletPrompter, WalletRepairResult } from "./types.js";

export function createSilentNonInteractivePrompter(): WalletPrompter {
  return {
    isInteractive: false,
    writeLine() {},
    async prompt(): Promise<string> {
      return "";
    },
  };
}

export function applyRepairStoppedMiningState(state: WalletStateV1): WalletStateV1 {
  const miningState = normalizeMiningStateRecord(state.miningState);

  return {
    ...state,
    miningState: {
      ...miningState,
      runMode: "stopped",
      state: miningState.livePublishInMempool
        ? miningState.state === "paused-stale"
          ? "paused-stale"
          : "paused"
        : miningState.state === "repair-required"
          ? "repair-required"
          : "idle",
      pauseReason: miningState.livePublishInMempool
        ? miningState.state === "paused-stale"
          ? "stale-block-context"
          : "wallet-repair"
        : miningState.state === "repair-required"
          ? miningState.pauseReason
          : null,
    },
  };
}

function createStoppedBackgroundRuntimeSnapshot(
  snapshot: MiningRuntimeStatusV1,
  nowUnixMs: number,
): MiningRuntimeStatusV1 {
  return {
    ...snapshot,
    updatedAtUnixMs: nowUnixMs,
    runMode: "stopped",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    backgroundWorkerHeartbeatAtUnixMs: null,
    backgroundWorkerHealth: null,
    currentPhase: "idle",
    note: snapshot.livePublishInMempool
      ? "Background mining stopped for wallet repair. The last mining transaction may still confirm from mempool."
      : "Background mining stopped for wallet repair.",
  };
}

function resolveMiningGenerationRequestPath(paths: WalletRuntimePaths): string {
  return join(paths.miningRoot, "generation-request.json");
}

function resolveMiningGenerationActivityPath(paths: WalletRuntimePaths): string {
  return join(paths.miningRoot, "generation-activity.json");
}

function normalizeRepairMiningPid(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function createRepairStoppedMiningNote(livePublishInMempool: boolean | null | undefined): string {
  return livePublishInMempool
    ? "Background mining stopped for wallet repair. The last mining transaction may still confirm from mempool."
    : "Background mining stopped for wallet repair.";
}

export function createStoppedMiningRuntimeSnapshotForRepair(options: {
  state: WalletStateV1;
  snapshot: MiningRuntimeStatusV1 | null;
  nowUnixMs: number;
}): MiningRuntimeStatusV1 {
  const stoppedMiningState = normalizeMiningStateRecord(applyRepairStoppedMiningState(options.state).miningState);
  const note = createRepairStoppedMiningNote(stoppedMiningState.livePublishInMempool);

  if (options.snapshot !== null) {
    return {
      ...createStoppedBackgroundRuntimeSnapshot(options.snapshot, options.nowUnixMs),
      miningState: stoppedMiningState.state,
      currentPublishState: stoppedMiningState.currentPublishState,
      targetBlockHeight: stoppedMiningState.currentBlockTargetHeight,
      referencedBlockHashDisplay: stoppedMiningState.currentReferencedBlockHashDisplay,
      currentDomainId: stoppedMiningState.currentDomainId,
      currentDomainName: stoppedMiningState.currentDomain,
      currentSentenceDisplay: stoppedMiningState.currentSentence,
      currentTxid: stoppedMiningState.currentTxid,
      currentWtxid: stoppedMiningState.currentWtxid,
      livePublishInMempool: stoppedMiningState.livePublishInMempool,
      currentFeeRateSatVb: stoppedMiningState.currentFeeRateSatVb,
      currentAbsoluteFeeSats: stoppedMiningState.currentAbsoluteFeeSats,
      currentBlockFeeSpentSats: stoppedMiningState.currentBlockFeeSpentSats,
      sessionFeeSpentSats: stoppedMiningState.sessionFeeSpentSats,
      lifetimeFeeSpentSats: stoppedMiningState.lifetimeFeeSpentSats,
      currentPublishDecision: stoppedMiningState.currentPublishDecision,
      pauseReason: stoppedMiningState.pauseReason,
      note,
    };
  }

  return {
    schemaVersion: 1,
    walletRootId: options.state.walletRootId,
    workerApiVersion: null,
    workerBinaryVersion: null,
    workerBuildId: null,
    updatedAtUnixMs: options.nowUnixMs,
    runMode: "stopped",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    backgroundWorkerHeartbeatAtUnixMs: null,
    backgroundWorkerHealth: null,
    indexerDaemonState: null,
    indexerDaemonInstanceId: null,
    indexerSnapshotSeq: null,
    indexerSnapshotOpenedAtUnixMs: null,
    indexerTruthSource: undefined,
    indexerHeartbeatAtUnixMs: null,
    coreBestHeight: null,
    coreBestHash: null,
    indexerTipHeight: null,
    indexerTipHash: null,
    indexerReorgDepth: null,
    indexerTipAligned: null,
    corePublishState: null,
    providerState: null,
    lastSuspendDetectedAtUnixMs: null,
    reconnectSettledUntilUnixMs: null,
    tipSettledUntilUnixMs: null,
    miningState: stoppedMiningState.state,
    currentPhase: "idle",
    currentPublishState: stoppedMiningState.currentPublishState,
    targetBlockHeight: stoppedMiningState.currentBlockTargetHeight,
    referencedBlockHashDisplay: stoppedMiningState.currentReferencedBlockHashDisplay,
    currentDomainId: stoppedMiningState.currentDomainId,
    currentDomainName: stoppedMiningState.currentDomain,
    currentSentenceDisplay: stoppedMiningState.currentSentence,
    currentCanonicalBlend: null,
    currentTxid: stoppedMiningState.currentTxid,
    currentWtxid: stoppedMiningState.currentWtxid,
    livePublishInMempool: stoppedMiningState.livePublishInMempool,
    currentFeeRateSatVb: stoppedMiningState.currentFeeRateSatVb,
    currentAbsoluteFeeSats: stoppedMiningState.currentAbsoluteFeeSats,
    currentBlockFeeSpentSats: stoppedMiningState.currentBlockFeeSpentSats,
    sessionFeeSpentSats: stoppedMiningState.sessionFeeSpentSats,
    lifetimeFeeSpentSats: stoppedMiningState.lifetimeFeeSpentSats,
    sameDomainCompetitorSuppressed: null,
    higherRankedCompetitorDomainCount: null,
    dedupedCompetitorDomainCount: null,
    competitivenessGateIndeterminate: null,
    mempoolSequenceCacheStatus: null,
    currentPublishDecision: stoppedMiningState.currentPublishDecision,
    lastMempoolSequence: null,
    lastCompetitivenessGateAtUnixMs: null,
    pauseReason: stoppedMiningState.pauseReason,
    providerConfigured: false,
    providerKind: null,
    bitcoindHealth: "unavailable",
    bitcoindServiceState: null,
    bitcoindReplicaStatus: null,
    nodeHealth: "unavailable",
    indexerHealth: "unavailable",
    tipsAligned: null,
    lastEventAtUnixMs: null,
    lastError: null,
    note,
  };
}

export async function persistRepairState(options: {
  state: WalletStateV1;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  nowUnixMs: number;
  replacePrimary?: boolean;
}): Promise<WalletStateV1> {
  return await persistWalletStateUpdate({
    state: options.state,
    access: {
      provider: options.provider,
      secretReference: createWalletSecretReference(options.state.walletRootId),
    },
    paths: options.paths,
    nowUnixMs: options.nowUnixMs,
    replacePrimary: options.replacePrimary,
  });
}

export async function cleanupMiningForRepair(options: {
  paths: WalletRuntimePaths;
  state: WalletStateV1;
  snapshot: MiningRuntimeStatusV1 | null;
  nowUnixMs: number;
}): Promise<{
  preRepairRunMode: WalletRepairResult["miningPreRepairRunMode"];
}> {
  const controlLockMetadata = await readLockMetadata(options.paths.miningControlLockPath).catch(() => null);
  const generationActivity = await readMiningGenerationActivity(options.paths).catch(() => null);
  const controlLockPid = normalizeRepairMiningPid(controlLockMetadata?.processId);
  const backgroundWorkerPid = normalizeRepairMiningPid(options.snapshot?.backgroundWorkerPid);
  const generationOwnerPid = normalizeRepairMiningPid(generationActivity?.generationOwnerPid);
  const discoveredPids = new Set<number>();
  let backgroundWorkerAlive = false;
  let foregroundWorkerAlive = false;

  const pidSources: Array<{
    pid: number | null;
    source: "background" | "foreground";
  }> = [
    { pid: backgroundWorkerPid, source: "background" },
    { pid: controlLockPid, source: "foreground" },
    { pid: generationOwnerPid, source: "foreground" },
  ];

  for (const source of pidSources) {
    if (source.pid === null || source.pid === process.pid || !await isProcessAlive(source.pid)) {
      continue;
    }

    discoveredPids.add(source.pid);
    if (source.source === "background") {
      backgroundWorkerAlive = true;
    } else {
      foregroundWorkerAlive = true;
    }
  }

  for (const pid of discoveredPids) {
    await stopRecordedManagedProcess(pid, "mining_process_stop_timeout");
  }

  await rm(options.paths.miningControlLockPath, { force: true }).catch(() => undefined);
  await rm(resolveMiningGenerationRequestPath(options.paths), { force: true }).catch(() => undefined);
  await rm(resolveMiningGenerationActivityPath(options.paths), { force: true }).catch(() => undefined);
  await saveMiningRuntimeStatus(
    options.paths.miningStatusPath,
    createStoppedMiningRuntimeSnapshotForRepair({
      state: options.state,
      snapshot: options.snapshot,
      nowUnixMs: options.nowUnixMs,
    }),
  );

  return {
    preRepairRunMode: backgroundWorkerAlive
      ? "background"
      : foregroundWorkerAlive
        ? "foreground"
        : "stopped",
  };
}

export async function canResumeBackgroundMiningAfterRepair(options: {
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  repairedState: WalletStateV1;
  bitcoindPostRepairHealth: WalletRepairResult["bitcoindPostRepairHealth"];
  indexerPostRepairHealth: WalletRepairResult["indexerPostRepairHealth"];
}): Promise<boolean> {
  if (
    options.bitcoindPostRepairHealth !== "ready"
    || options.indexerPostRepairHealth !== "synced"
    || normalizeMiningStateRecord(options.repairedState.miningState).state === "repair-required"
  ) {
    return false;
  }

  try {
    const config = await loadClientConfig({
      path: options.paths.clientConfigPath,
      provider: options.provider,
    });
    return config?.mining.builtIn != null;
  } catch {
    return false;
  }
}

export async function resumeBackgroundMiningAfterRepair(options: {
  miningPreRepairRunMode: WalletRepairResult["miningPreRepairRunMode"];
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  repairedState: WalletStateV1;
  bitcoindPostRepairHealth: WalletRepairResult["bitcoindPostRepairHealth"];
  indexerPostRepairHealth: WalletRepairResult["indexerPostRepairHealth"];
  dataDir: string;
  databasePath: string;
  startBackgroundMining?: typeof import("../mining/runner.js").startBackgroundMining;
}): Promise<{
  miningResumeAction: WalletRepairResult["miningResumeAction"];
  miningPostRepairRunMode: WalletRepairResult["miningPostRepairRunMode"];
  miningResumeError: string | null;
}> {
  const miningWasResumable = options.miningPreRepairRunMode === "background"
    && normalizeMiningStateRecord(options.repairedState.miningState).state !== "repair-required";

  if (options.miningPreRepairRunMode !== "background") {
    return {
      miningResumeAction: "none",
      miningPostRepairRunMode: "stopped",
      miningResumeError: null,
    };
  }

  if (!miningWasResumable) {
    return {
      miningResumeAction: "skipped-not-resumable",
      miningPostRepairRunMode: "stopped",
      miningResumeError: null,
    };
  }

  const postRepairResumeReady = await canResumeBackgroundMiningAfterRepair({
    provider: options.provider,
    paths: options.paths,
    repairedState: options.repairedState,
    bitcoindPostRepairHealth: options.bitcoindPostRepairHealth,
    indexerPostRepairHealth: options.indexerPostRepairHealth,
  });

  if (!postRepairResumeReady) {
    return {
      miningResumeAction: "skipped-post-repair-blocked",
      miningPostRepairRunMode: "stopped",
      miningResumeError: null,
    };
  }

  try {
    const startBackgroundMining = options.startBackgroundMining
      ?? (await import("../mining/runner.js")).startBackgroundMining;
    const resumed = await startBackgroundMining({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      provider: options.provider,
      paths: options.paths,
      prompter: createSilentNonInteractivePrompter(),
    });

    if (resumed.snapshot?.runMode === "background") {
      return {
        miningResumeAction: "resumed-background",
        miningPostRepairRunMode: "background",
        miningResumeError: null,
      };
    }

    return {
      miningResumeAction: "resume-failed",
      miningPostRepairRunMode: "stopped",
      miningResumeError: "Background mining did not report a background runtime after repair.",
    };
  } catch (error) {
    return {
      miningResumeAction: "resume-failed",
      miningPostRepairRunMode: "stopped",
      miningResumeError: error instanceof Error ? error.message : String(error),
    };
  }
}
