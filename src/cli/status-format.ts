import type { PassiveClientStatus } from "../passive-status.js";
import { compareSemver } from "../semver.js";

const FOREGROUND_MINING_STATUS_STALE_MS = 5 * 60 * 1000;
const FOREGROUND_MINING_STATUS_STALE_NOTE =
  "Mining runtime status is stale; no recent foreground heartbeat was written. Restart mining or inspect mine log.";
const STALE_INDEXER_BINARY_NOTE =
  "Managed indexer daemon binary is older than this CLI; the next managed attach should recycle it.";

interface StatusRow {
  readonly ok: boolean;
  readonly text: string;
}

function row(ok: boolean, text: string): StatusRow {
  return { ok, text };
}

function formatMarker(ok: boolean): string {
  return ok ? "✓" : "✗";
}

function formatValue(value: number | string | null | undefined): string {
  return value === null || value === undefined || value === "" ? "none" : String(value);
}

function formatYesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function formatBootstrapPercent(current: number, total: number): string {
  if (total <= 0) {
    return "0.00";
  }

  return ((current / total) * 100).toFixed(2);
}

function formatSignedDelta(value: number): string {
  if (value > 0) {
    return `+${value}`;
  }

  return String(value);
}

function formatSection(title: string, rows: readonly StatusRow[]): string {
  return [
    title,
    ...rows.map((entry) => `${formatMarker(entry.ok)} ${entry.text}`),
  ].join("\n");
}

function buildPathsRows(status: PassiveClientStatus): StatusRow[] {
  return [
    row(true, `DB path: ${status.dbPath}`),
    row(true, `Bitcoin datadir: ${status.bitcoinDataDir}`),
  ];
}

function buildWalletRows(status: PassiveClientStatus): StatusRow[] {
  const rows = [
    row(
      status.wallet.walletRootId !== null && status.wallet.error === null,
      `Wallet root: ${status.wallet.walletRootId ?? "unknown"} (${status.wallet.source})`,
    ),
  ];

  if (status.wallet.error !== null) {
    rows.push(row(false, `Wallet root error: ${status.wallet.error}`));
  }

  return rows;
}

function buildLocalStoreRows(status: PassiveClientStatus): StatusRow[] {
  const rows = [
    row(status.storeExists, `Store exists: ${formatYesNo(status.storeExists)}`),
    row(status.storeInitialized, `Store initialized: ${formatYesNo(status.storeInitialized)}`),
  ];

  if (status.storeError !== null) {
    rows.push(row(false, `Store error: ${status.storeError}`));
  }

  if (status.indexedTip === null) {
    rows.push(row(false, "Indexed tip: none"));
  } else {
    rows.push(row(true, `Indexed tip height: ${status.indexedTip.height}`));
    rows.push(row(true, `Indexed tip hash: ${status.indexedTip.blockHashHex}`));
    rows.push(row(status.indexedTip.stateHashHex !== null, `Indexed tip state hash: ${formatValue(status.indexedTip.stateHashHex)}`));
  }

  if (status.latestCheckpoint === null) {
    rows.push(row(false, "Latest checkpoint: none"));
  } else {
    rows.push(row(true, `Latest checkpoint height: ${status.latestCheckpoint.height}`));
    rows.push(row(true, `Latest checkpoint hash: ${status.latestCheckpoint.blockHashHex}`));
  }

  if (status.indexedTip !== null && status.indexer.appliedTipHeight !== null) {
    const delta = status.indexedTip.height - status.indexer.appliedTipHeight;
    rows.push(row(Math.abs(delta) <= 1, `Store/indexer height delta: ${formatSignedDelta(delta)}`));
  }

  return rows;
}

function buildBootstrapRows(status: PassiveClientStatus): StatusRow[] {
  if (status.bootstrap === null) {
    return [row(false, "Bootstrap state: none")];
  }

  return [
    row(status.bootstrap.lastError === null, `Bootstrap phase: ${status.bootstrap.phase}`),
    row(
      status.bootstrap.lastError === null,
      `Bootstrap download: ${status.bootstrap.downloadedBytes} / ${status.bootstrap.totalBytes} bytes (${formatBootstrapPercent(status.bootstrap.downloadedBytes, status.bootstrap.totalBytes)}%)`,
    ),
    row(status.bootstrap.validated, `Bootstrap validated: ${formatYesNo(status.bootstrap.validated)}`),
    row(status.bootstrap.loadTxOutSetComplete, `Bootstrap loaded: ${formatYesNo(status.bootstrap.loadTxOutSetComplete)}`),
    row(status.bootstrap.baseHeight !== null, `Bootstrap base height: ${formatValue(status.bootstrap.baseHeight)}`),
    row(status.bootstrap.tipHashHex !== null, `Bootstrap tip hash: ${formatValue(status.bootstrap.tipHashHex)}`),
    row(status.bootstrap.snapshotHeight !== null, `Bootstrap snapshot height: ${formatValue(status.bootstrap.snapshotHeight)}`),
    row(status.bootstrap.lastError === null, `Bootstrap last error: ${formatValue(status.bootstrap.lastError)}`),
  ];
}

function buildManagedBitcoindRows(status: PassiveClientStatus): StatusRow[] {
  if (status.managedBitcoind.error !== null) {
    return [
      row(false, "Managed bitcoind: corrupt"),
      row(false, `Managed bitcoind status path: ${formatValue(status.managedBitcoind.statusPath)}`),
      row(false, `Managed bitcoind status error: ${status.managedBitcoind.error}`),
    ];
  }

  if (!status.managedBitcoind.present) {
    return [row(false, "Managed bitcoind: unavailable")];
  }

  return [
    row(status.managedBitcoind.state === "ready", `Managed bitcoind: ${formatValue(status.managedBitcoind.state)}`),
    row(status.managedBitcoind.processId !== null, `Managed bitcoind pid: ${formatValue(status.managedBitcoind.processId)}`),
    row(status.managedBitcoind.walletRootId !== null, `Managed bitcoind wallet root: ${formatValue(status.managedBitcoind.walletRootId)}`),
    row(status.managedBitcoind.heartbeatAtUnixMs !== null, `Managed bitcoind heartbeat: ${formatValue(status.managedBitcoind.heartbeatAtUnixMs)}`),
    row(status.managedBitcoind.updatedAtUnixMs !== null, `Managed bitcoind updated: ${formatValue(status.managedBitcoind.updatedAtUnixMs)}`),
    row(status.managedBitcoind.lastError === null, `Managed bitcoind last error: ${formatValue(status.managedBitcoind.lastError)}`),
  ];
}

function isIndexerBinaryVersionStale(status: PassiveClientStatus, version: string): boolean {
  if (status.indexer.binaryVersion === null) {
    return false;
  }

  const comparison = compareSemver(status.indexer.binaryVersion, version);
  return comparison !== null && comparison < 0;
}

function buildIndexerRows(status: PassiveClientStatus, version: string): StatusRow[] {
  if (status.indexer.error !== null) {
    return [
      row(false, "Indexer: corrupt"),
      row(false, `Indexer status path: ${formatValue(status.indexer.statusPath)}`),
      row(false, `Indexer status error: ${status.indexer.error}`),
    ];
  }

  if (!status.indexer.present) {
    return [row(false, "Indexer: unavailable")];
  }

  const indexerBinaryStale = isIndexerBinaryVersionStale(status, version);
  const rows = [
    row(status.indexer.state === "synced" && !indexerBinaryStale, `Indexer: ${formatValue(status.indexer.state)}`),
    row(status.indexer.processId !== null, `Indexer pid: ${formatValue(status.indexer.processId)}`),
    row(status.indexer.walletRootId !== null, `Indexer wallet root: ${formatValue(status.indexer.walletRootId)}`),
    row(!indexerBinaryStale, `Indexer binary version: ${formatValue(status.indexer.binaryVersion)}`),
    row(status.indexer.coreBestHeight !== null, `Indexer core best height: ${formatValue(status.indexer.coreBestHeight)}`),
    row(status.indexer.appliedTipHeight !== null, `Indexer applied tip height: ${formatValue(status.indexer.appliedTipHeight)}`),
    row(status.indexer.appliedTipHash !== null, `Indexer applied tip hash: ${formatValue(status.indexer.appliedTipHash)}`),
    row(status.indexer.heartbeatAtUnixMs !== null, `Indexer heartbeat: ${formatValue(status.indexer.heartbeatAtUnixMs)}`),
    row(status.indexer.updatedAtUnixMs !== null, `Indexer updated: ${formatValue(status.indexer.updatedAtUnixMs)}`),
    row(status.indexer.lastError === null, `Indexer last error: ${formatValue(status.indexer.lastError)}`),
  ];

  if (indexerBinaryStale) {
    rows.push(row(false, `Indexer note: ${STALE_INDEXER_BINARY_NOTE}`));
  }

  if (status.indexer.coreBestHeight !== null && status.indexer.appliedTipHeight !== null) {
    const lag = Math.max(0, status.indexer.coreBestHeight - status.indexer.appliedTipHeight);
    rows.push(row(lag === 0, `Indexer lag: ${lag} blocks`));
  }

  return rows;
}

function buildManagedServicesRows(status: PassiveClientStatus, version: string): StatusRow[] {
  return [
    ...buildManagedBitcoindRows(status),
    ...buildIndexerRows(status, version),
  ];
}

function isForegroundMiningStatusStale(status: PassiveClientStatus, nowUnixMs: number): boolean {
  if (status.mining.runMode !== "foreground") {
    return false;
  }

  return status.mining.updatedAtUnixMs === null
    || (nowUnixMs - status.mining.updatedAtUnixMs) > FOREGROUND_MINING_STATUS_STALE_MS;
}

function buildMiningRows(status: PassiveClientStatus, nowUnixMs: number): StatusRow[] {
  if (status.mining.error !== null) {
    return [
      row(false, "Mining state: corrupt"),
      row(false, `Mining status path: ${formatValue(status.mining.statusPath)}`),
      row(false, `Mining status error: ${status.mining.error}`),
    ];
  }

  if (!status.mining.present) {
    return [row(false, "Mining state: unavailable")];
  }

  const miningStatusStale = isForegroundMiningStatusStale(status, nowUnixMs);
  const miningHasError = status.mining.lastError !== null || miningStatusStale;
  const miningNote = miningStatusStale
    ? FOREGROUND_MINING_STATUS_STALE_NOTE
    : status.mining.note;
  const needsBackgroundWorker = status.mining.runMode === "background";
  const diagnostics = status.mining.competitivenessGateDiagnostics;
  const gateRows = status.mining.competitivenessGateReason === null
    ? []
    : [
      row(false, `Competitiveness gate reason: ${status.mining.competitivenessGateReason}`),
      row(status.mining.mempoolSequenceCacheStatus !== null, `Gate cache: ${formatValue(status.mining.mempoolSequenceCacheStatus)}`),
      row(status.mining.lastMempoolSequence !== null, `Last mempool sequence: ${formatValue(status.mining.lastMempoolSequence)}`),
      row(status.mining.lastCompetitivenessGateAtUnixMs !== null, `Last gate check: ${formatValue(status.mining.lastCompetitivenessGateAtUnixMs)}`),
      row(diagnostics?.visibleMempoolTxCount !== null && diagnostics?.visibleMempoolTxCount !== undefined, `Visible mempool txs: ${formatValue(diagnostics?.visibleMempoolTxCount)}`),
      row(diagnostics?.indexedContextCount !== null && diagnostics?.indexedContextCount !== undefined, `Indexed mempool contexts: ${formatValue(diagnostics?.indexedContextCount)}`),
      row(diagnostics?.negativeTxCount !== null && diagnostics?.negativeTxCount !== undefined, `Known non-Cog txs: ${formatValue(diagnostics?.negativeTxCount)}`),
      row(diagnostics?.unknownTxCount !== null && diagnostics?.unknownTxCount !== undefined, `Unknown mempool txs: ${formatValue(diagnostics?.unknownTxCount)}`),
      row(diagnostics?.hydratedTxCount !== null && diagnostics?.hydratedTxCount !== undefined, `Hydrated mempool txs: ${formatValue(diagnostics?.hydratedTxCount)}`),
      row(diagnostics?.mempoolEntryCount !== null && diagnostics?.mempoolEntryCount !== undefined, `Mempool entries checked: ${formatValue(diagnostics?.mempoolEntryCount)}`),
      row(diagnostics?.missingEntryCount === 0, `Missing mempool entries: ${formatValue(diagnostics?.missingEntryCount)}`),
      row(diagnostics?.candidateRank !== null && diagnostics?.candidateRank !== undefined, `Candidate rank: ${formatValue(diagnostics?.candidateRank)}`),
      row(diagnostics?.higherRankedCompetitorDomainCount !== null && diagnostics?.higherRankedCompetitorDomainCount !== undefined, `Higher-ranked competitor domains: ${formatValue(diagnostics?.higherRankedCompetitorDomainCount)}`),
      row(diagnostics?.dedupedCompetitorDomainCount !== null && diagnostics?.dedupedCompetitorDomainCount !== undefined, `Deduped competitor domains: ${formatValue(diagnostics?.dedupedCompetitorDomainCount)}`),
    ];

  return [
    row(!miningHasError, `Mining run mode: ${formatValue(status.mining.runMode)}`),
    row(!miningHasError, `Mining state: ${formatValue(status.mining.miningState)}`),
    row(!miningHasError, `Mining phase: ${formatValue(status.mining.currentPhase)}`),
    row(!needsBackgroundWorker || status.mining.backgroundWorkerPid !== null, `Mining background worker pid: ${formatValue(status.mining.backgroundWorkerPid)}`),
    row(!needsBackgroundWorker || status.mining.backgroundWorkerHealth !== null, `Mining background worker health: ${formatValue(status.mining.backgroundWorkerHealth)}`),
    row(status.mining.updatedAtUnixMs !== null, `Mining updated: ${formatValue(status.mining.updatedAtUnixMs)}`),
    row(!miningHasError, `Mining last error: ${formatValue(status.mining.lastError)}`),
    row(miningNote === null, `Mining note: ${formatValue(miningNote)}`),
    ...gateRows,
  ];
}

function buildPassiveModeRows(): StatusRow[] {
  return [
    row(true, "Live node: not checked"),
    row(true, "Password prompt: not required"),
    row(true, "RPC-backed balance: not checked"),
  ];
}

export function formatStatusReport(
  status: PassiveClientStatus,
  version: string,
  options: {
    nowUnixMs?: number;
  } = {},
): string {
  const nowUnixMs = options.nowUnixMs ?? Date.now();

  return [
    `⛭ Cogcoin Status v${version} (passive) ⛭`,
    formatSection("Paths", buildPathsRows(status)),
    formatSection("Wallet", buildWalletRows(status)),
    formatSection("Local Store", buildLocalStoreRows(status)),
    formatSection("Bootstrap", buildBootstrapRows(status)),
    formatSection("Managed Services", buildManagedServicesRows(status, version)),
    formatSection("Mining", buildMiningRows(status, nowUnixMs)),
    formatSection("Passive Mode", buildPassiveModeRows()),
    "Run cogcoin status --live for RPC-backed balance and full service verification.",
  ].join("\n\n");
}
