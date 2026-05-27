import type {
  MiningControlPlaneView,
  MiningDomainPromptListResult,
  MiningDomainPromptMutationResult,
  MiningEventRecord,
} from "../wallet/mining/index.js";
import { resolveCorePublishStateNote } from "../wallet/mining/publishability.js";
import { resolveWaitingProviderNote } from "../wallet/mining/projection.js";

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

function formatProviderModel(mining: MiningControlPlaneView): string | null {
  if (mining.provider.effectiveModel === null || mining.provider.usingDefaultModel === null) {
    return null;
  }

  return `${mining.provider.effectiveModel} (${mining.provider.usingDefaultModel ? "default" : "override"})`;
}

function formatProviderModelSource(mining: MiningControlPlaneView): string | null {
  return mining.provider.modelSelectionSource;
}

function resolveProviderNotFoundNextStep(mining: MiningControlPlaneView): string {
  return mining.provider.usingDefaultModel === false
    ? "Next: run `cogcoin mine setup` and clear or correct the provider model."
    : "Next: run `cogcoin mine setup` and choose a valid provider model.";
}

function resolveInsufficientFundsNextStep(): string {
  return "Next: wait for enough safe BTC funding to become spendable for the next publish; mining resumes automatically.";
}

function resolveMiningRuntimeNote(mining: MiningControlPlaneView): string | null {
  return mining.runtime.currentPublishDecision === "publish-paused-insufficient-funds"
    ? "Insufficient BTC to mine."
    : mining.runtime.note !== null
      ? mining.runtime.note
      : mining.runtime.currentPhase === "waiting-provider"
        ? resolveWaitingProviderNote(mining.runtime.providerState)
        : mining.runtime.currentPhase === "waiting-bitcoin-network"
          ? resolveCorePublishStateNote(mining.runtime.corePublishState)
          : null;
}

function formatGateDiagnosticsCounts(mining: MiningControlPlaneView): string | null {
  const diagnostics = mining.runtime.competitivenessGateDiagnostics;
  if (diagnostics === null) {
    return null;
  }

  return [
    diagnostics.visibleMempoolTxCount === null ? null : `visible=${diagnostics.visibleMempoolTxCount}`,
    diagnostics.indexedContextCount === null ? null : `indexed=${diagnostics.indexedContextCount}`,
    diagnostics.negativeTxCount === null ? null : `negative=${diagnostics.negativeTxCount}`,
    diagnostics.unknownTxCount === null ? null : `unknown=${diagnostics.unknownTxCount}`,
    diagnostics.hydratedTxCount === null ? null : `hydrated=${diagnostics.hydratedTxCount}`,
    diagnostics.mempoolEntryCount === null ? null : `entries=${diagnostics.mempoolEntryCount}`,
    diagnostics.missingEntryCount === null ? null : `missingEntries=${diagnostics.missingEntryCount}`,
    diagnostics.candidateRank === null ? null : `candidateRank=${diagnostics.candidateRank}`,
    diagnostics.higherRankedCompetitorDomainCount === null ? null : `higherDomains=${diagnostics.higherRankedCompetitorDomainCount}`,
    diagnostics.dedupedCompetitorDomainCount === null ? null : `competitorDomains=${diagnostics.dedupedCompetitorDomainCount}`,
  ].filter((part): part is string => part !== null).join(" ") || null;
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
  const providerModel = formatProviderModel(mining);
  if (providerModel !== null) {
    lines.push(`Provider model: ${providerModel}`);
  }
  const providerModelSource = formatProviderModelSource(mining);
  if (providerModelSource !== null) {
    lines.push(`Provider model source: ${providerModelSource}`);
  }
  if (mining.provider.estimatedDailyCostDisplay !== null) {
    lines.push(`Estimated daily cost: ${mining.provider.estimatedDailyCostDisplay}`);
  }
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
  if (mining.runtime.readinessBlocker !== null && mining.runtime.readinessBlocker !== undefined) {
    lines.push(`Readiness blocker: ${mining.runtime.readinessBlocker}`);
  }
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
  if (mining.runtime.targetBlockHeight !== null) {
    lines.push(`Current target height: ${mining.runtime.targetBlockHeight}`);
  }
  if (mining.runtime.referencedBlockHashDisplay !== null) {
    lines.push(`Current referenced block: ${mining.runtime.referencedBlockHashDisplay}`);
  }
  const livePublishTxid = mining.runtime.livePublishTxid
    ?? (mining.runtime.livePublishInMempool === true ? mining.runtime.currentTxid : null);
  if (livePublishTxid !== null) {
    lines.push(`Live publish txid: ${livePublishTxid}`);
  } else if (mining.runtime.currentTxid !== null) {
    lines.push(`Current txid: ${mining.runtime.currentTxid}`);
  }
  const livePublishTargetBlockHeight = mining.runtime.livePublishTargetBlockHeight ?? null;
  if (livePublishTargetBlockHeight !== null) {
    lines.push(`Live publish target height: ${livePublishTargetBlockHeight}`);
  }
  const livePublishReferencedBlockHashDisplay = mining.runtime.livePublishReferencedBlockHashDisplay ?? null;
  if (livePublishReferencedBlockHashDisplay !== null) {
    lines.push(`Live publish referenced block: ${livePublishReferencedBlockHashDisplay}`);
  }
  const livePublishDecision = mining.runtime.livePublishDecision
    ?? (mining.runtime.livePublishInMempool === true ? mining.runtime.currentPublishDecision : null);
  if (livePublishDecision !== null && livePublishDecision !== mining.runtime.currentPublishDecision) {
    lines.push(`Live publish decision: ${livePublishDecision}`);
  }
  if (mining.runtime.livePublishStaleToCoreTip === true) {
    lines.push("Live publish stale to Core tip: yes");
  }
  lines.push(`Publish state: ${mining.runtime.currentPublishState}`);
  if (mining.runtime.currentPublishDecision !== null) {
    lines.push(`Publish decision: ${mining.runtime.currentPublishDecision}`);
  }
  if (mining.runtime.sameDomainCompetitorSuppressed === true) {
    lines.push("Competitiveness gate: suppressed by same-domain mempool incumbent");
  } else if (mining.runtime.competitivenessGateIndeterminate === true) {
    lines.push(`Competitiveness gate: indeterminate${mining.runtime.competitivenessGateReason === null ? "" : ` (${mining.runtime.competitivenessGateReason})`}, so this tick was skipped safely`);
  } else if (mining.runtime.higherRankedCompetitorDomainCount !== null) {
    lines.push(`Higher-ranked competitor domains: ${mining.runtime.higherRankedCompetitorDomainCount}`);
  }
  const gateCounts = formatGateDiagnosticsCounts(mining);
  if (gateCounts !== null) {
    lines.push(`Gate diagnostics: ${gateCounts}`);
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
  const runtimeNote = resolveMiningRuntimeNote(mining);
  if (runtimeNote !== null) {
    lines.push(`Note: ${runtimeNote}`);
  }
  if (mining.runtime.miningState === "repair-required") {
    lines.push("Next: run `cogcoin repair` before mining again.");
  } else if (mining.runtime.providerState === "not-found") {
    lines.push(resolveProviderNotFoundNextStep(mining));
  } else if (mining.runtime.currentPublishDecision === "publish-paused-insufficient-funds") {
    lines.push(resolveInsufficientFundsNextStep());
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

export function formatMiningPromptMutationReport(result: MiningDomainPromptMutationResult): string {
  const lines = [
    `Domain: ${result.domain.name}`,
    `Domain prompt: ${result.prompt ?? "none"}`,
    `Global fallback prompt: ${result.fallbackPromptConfigured ? "configured" : "not configured"}`,
  ];

  if (result.previousPrompt !== null) {
    lines.push(`Previous domain prompt: ${result.previousPrompt}`);
  }

  lines.push(result.status === "updated"
    ? "Per-domain mining prompt updated."
    : "Per-domain mining prompt cleared.");
  return lines.join("\n");
}

export function formatMiningPromptListReport(result: MiningDomainPromptListResult): string {
  const lines = [
    "Mining Prompt List",
    `Global fallback prompt: ${result.fallbackPromptConfigured ? "configured" : "not configured"}`,
  ];

  if (result.prompts.length === 0) {
    lines.push("No mineable root domains or stored per-domain mining prompts are configured.");
    return lines.join("\n");
  }

  for (const entry of result.prompts) {
    lines.push(
      `${entry.domain.name}  domainId=${entry.domain.domainId ?? "none"}  ${entry.mineable ? "mineable" : "dormant"}  source=${entry.effectivePromptSource}`,
    );
    lines.push(`  prompt: ${entry.prompt ?? "none"}`);
  }

  return lines.join("\n");
}
