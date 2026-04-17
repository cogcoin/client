import type { MiningControlPlaneView, MiningEventRecord } from "../wallet/mining/index.js";

function formatMaybeIso(unixMs: number | null): string {
  return unixMs === null ? "none" : new Date(unixMs).toISOString();
}

function formatIndexerTruthSource(source: MiningControlPlaneView["runtime"]["indexerTruthSource"]): string {
  switch (source) {
    case "lease":
      return "coherent snapshot lease";
    case "probe":
      return "live daemon probe";
    case "status-file":
      return "advisory status file";
    default:
      return "none";
  }
}

export function formatMiningSummaryLine(mining: MiningControlPlaneView): string {
  const provider = mining.provider.configured
    ? `${mining.provider.provider} configured`
    : mining.provider.status === "error"
      ? "config unavailable"
      : "not configured";
  const suffix = mining.runtime.miningState === "repair-required"
    ? "  next repair"
    : mining.runtime.miningState === "paused-stale"
      ? "  next wait-or-rerun"
      : mining.runtime.miningState === "paused" && mining.runtime.livePublishInMempool
        ? "  next wait-or-rerun"
      : mining.runtime.pauseReason === "zero-reward"
          ? "  zero-reward"
        : "";
  return `${mining.runtime.runMode} / ${mining.runtime.miningState} / ${mining.runtime.currentPhase}  provider ${provider}${suffix}`;
}

export function formatMineStatusReport(mining: MiningControlPlaneView): string {
  const lines = ["Mining Status"];
  lines.push(`Run mode: ${mining.runtime.runMode}`);
  lines.push(`Mining state: ${mining.runtime.miningState}`);
  lines.push(`Current phase: ${mining.runtime.currentPhase}`);
  if (mining.runtime.pauseReason !== null) {
    lines.push(`Pause reason: ${mining.runtime.pauseReason}`);
  }
  if (mining.runtime.lastSuspendDetectedAtUnixMs !== null) {
    lines.push(`Last suspend detected: ${formatMaybeIso(mining.runtime.lastSuspendDetectedAtUnixMs)}`);
  }
  lines.push(`Provider: ${mining.provider.configured ? `${mining.provider.provider} configured` : mining.provider.status}`);
  if (mining.provider.message !== null) {
    lines.push(`Provider note: ${mining.provider.message}`);
  }
  lines.push(`Provider runtime: ${mining.runtime.providerState ?? "unknown"}`);
  lines.push(`Managed bitcoind: ${mining.runtime.bitcoindHealth}`);
  if (mining.runtime.bitcoindReplicaStatus !== null) {
    lines.push(`Managed Core wallet: ${mining.runtime.bitcoindReplicaStatus}`);
  }
  lines.push(`Bitcoin service: ${mining.runtime.nodeHealth}`);
  lines.push(`Indexer service: ${mining.runtime.indexerHealth}`);
  lines.push(`Indexer truth source: ${formatIndexerTruthSource(mining.runtime.indexerTruthSource)}`);
  if (mining.runtime.indexerDaemonInstanceId !== null) {
    lines.push(`Indexer daemon instance: ${mining.runtime.indexerDaemonInstanceId}`);
  }
  if (mining.runtime.indexerSnapshotSeq !== null) {
    lines.push(`Indexer snapshot sequence: ${mining.runtime.indexerSnapshotSeq}`);
  }
  if (mining.runtime.indexerReorgDepth !== null) {
    lines.push(`Indexer reorg depth: ${mining.runtime.indexerReorgDepth}`);
  }
  lines.push(`Tip alignment: ${mining.runtime.tipsAligned === null ? "unknown" : mining.runtime.tipsAligned ? "aligned" : "misaligned"}`);
  lines.push(`Core publishability: ${mining.runtime.corePublishState ?? "unknown"}`);
  if (mining.runtime.backgroundWorkerPid !== null) {
    lines.push(`Background worker: pid ${mining.runtime.backgroundWorkerPid} (${mining.runtime.backgroundWorkerHealth ?? "unknown"})`);
  }
  if (mining.runtime.currentDomainName !== null) {
    lines.push(`Current domain: ${mining.runtime.currentDomainName}`);
  }
  if (mining.runtime.currentTxid !== null) {
    lines.push(`Current txid: ${mining.runtime.currentTxid}`);
  }
  lines.push(`Publish state: ${mining.runtime.currentPublishState}`);
  if (mining.runtime.currentPublishDecision !== null) {
    lines.push(`Publish decision: ${mining.runtime.currentPublishDecision}`);
  }
  if (mining.runtime.sameDomainCompetitorSuppressed === true) {
    lines.push("Competitiveness gate: suppressed by same-domain mempool incumbent");
  } else if (mining.runtime.competitivenessGateIndeterminate === true) {
    lines.push("Competitiveness gate: indeterminate, so this tick was skipped safely");
  } else if (mining.runtime.higherRankedCompetitorDomainCount !== null) {
    lines.push(`Higher-ranked competitor domains: ${mining.runtime.higherRankedCompetitorDomainCount}`);
  }
  if (mining.runtime.dedupedCompetitorDomainCount !== null) {
    lines.push(`Deduped competitor domains: ${mining.runtime.dedupedCompetitorDomainCount}`);
  }
  if (mining.runtime.lastMempoolSequence !== null) {
    lines.push(`Last mempool sequence: ${mining.runtime.lastMempoolSequence}`);
  }
  if (mining.runtime.mempoolSequenceCacheStatus !== null) {
    lines.push(`Gate cache: ${mining.runtime.mempoolSequenceCacheStatus}`);
  }
  lines.push(`Last event: ${formatMaybeIso(mining.runtime.lastEventAtUnixMs)}`);
  if (mining.runtime.lastError !== null) {
    lines.push(`Last error: ${mining.runtime.lastError}`);
  }
  if (mining.runtime.note !== null) {
    lines.push(`Note: ${mining.runtime.note}`);
  }
  if (mining.runtime.miningState === "repair-required") {
    lines.push("Next: run `cogcoin repair` before mining again.");
  } else if (mining.runtime.pauseReason === "zero-reward") {
    lines.push("Next: wait for the next positive-reward target height; mining resumes automatically.");
  } else if (mining.runtime.currentPhase === "resuming") {
    lines.push("Next: wait for mining to finish rechecking health after the local runtime resumed.");
  } else if (mining.runtime.miningState === "paused-stale") {
    lines.push("Next: wait for the live mining publish to confirm, or rerun mining after the tip settles.");
  } else if (mining.runtime.miningState === "paused" && mining.runtime.livePublishInMempool) {
    lines.push("Next: wait for the live mining publish to confirm, or rerun mining when you want replacements to resume.");
  }
  return lines.join("\n");
}

export function formatMiningEventRecord(event: MiningEventRecord): string {
  return `${new Date(event.timestampUnixMs).toISOString()}  ${event.level.toUpperCase()}  ${event.kind}  ${event.message}`;
}
