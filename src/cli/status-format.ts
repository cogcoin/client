import type { inspectPassiveClientStatus } from "../passive-status.js";

function formatBootstrapPercent(current: number, total: number): string {
  if (total <= 0) {
    return "0.00";
  }

  return ((current / total) * 100).toFixed(2);
}

export function formatStatusReport(status: Awaited<ReturnType<typeof inspectPassiveClientStatus>>): string {
  const lines = [
    "Cogcoin Client Status (passive)",
    `DB path: ${status.dbPath}`,
    `Bitcoin datadir: ${status.bitcoinDataDir}`,
    `Wallet root: ${status.wallet.walletRootId ?? "unknown"} (${status.wallet.source})`,
    `Store exists: ${status.storeExists ? "yes" : "no"}`,
    `Store initialized: ${status.storeInitialized ? "yes" : "no"}`,
  ];

  if (status.wallet.error !== null) {
    lines.push(`Wallet root error: ${status.wallet.error}`);
  }

  if (status.storeError !== null) {
    lines.push(`Store error: ${status.storeError}`);
  }

  if (status.indexedTip === null) {
    lines.push("Indexed tip: none");
  } else {
    lines.push(`Indexed tip height: ${status.indexedTip.height}`);
    lines.push(`Indexed tip hash: ${status.indexedTip.blockHashHex}`);
    lines.push(`Indexed tip state hash: ${status.indexedTip.stateHashHex ?? "none"}`);
  }

  if (status.latestCheckpoint === null) {
    lines.push("Latest checkpoint: none");
  } else {
    lines.push(`Latest checkpoint height: ${status.latestCheckpoint.height}`);
    lines.push(`Latest checkpoint hash: ${status.latestCheckpoint.blockHashHex}`);
  }

  if (status.bootstrap === null) {
    lines.push("Bootstrap state: none");
  } else {
    lines.push(`Bootstrap phase: ${status.bootstrap.phase}`);
    lines.push(
      `Bootstrap download: ${status.bootstrap.downloadedBytes} / ${status.bootstrap.totalBytes} bytes (${formatBootstrapPercent(status.bootstrap.downloadedBytes, status.bootstrap.totalBytes)}%)`,
    );
    lines.push(`Bootstrap validated: ${status.bootstrap.validated ? "yes" : "no"}`);
    lines.push(`Bootstrap loaded: ${status.bootstrap.loadTxOutSetComplete ? "yes" : "no"}`);
    lines.push(`Bootstrap base height: ${status.bootstrap.baseHeight ?? "none"}`);
    lines.push(`Bootstrap tip hash: ${status.bootstrap.tipHashHex ?? "none"}`);
    lines.push(`Bootstrap snapshot height: ${status.bootstrap.snapshotHeight ?? "none"}`);
    lines.push(`Bootstrap last error: ${status.bootstrap.lastError ?? "none"}`);
  }

  if (status.managedBitcoind.error !== null) {
    lines.push("Managed bitcoind state: corrupt");
    lines.push(`Managed bitcoind status path: ${status.managedBitcoind.statusPath ?? "none"}`);
    lines.push(`Managed bitcoind status error: ${status.managedBitcoind.error}`);
  } else if (!status.managedBitcoind.present) {
    lines.push("Managed bitcoind state: unavailable");
  } else {
    lines.push(`Managed bitcoind state: ${status.managedBitcoind.state ?? "unknown"}`);
    lines.push(`Managed bitcoind pid: ${status.managedBitcoind.processId ?? "none"}`);
    lines.push(`Managed bitcoind wallet root: ${status.managedBitcoind.walletRootId ?? "unknown"}`);
    lines.push(`Managed bitcoind heartbeat: ${status.managedBitcoind.heartbeatAtUnixMs ?? "none"}`);
    lines.push(`Managed bitcoind updated: ${status.managedBitcoind.updatedAtUnixMs ?? "none"}`);
    lines.push(`Managed bitcoind last error: ${status.managedBitcoind.lastError ?? "none"}`);
  }

  if (status.indexer.error !== null) {
    lines.push("Indexer state: corrupt");
    lines.push(`Indexer status path: ${status.indexer.statusPath ?? "none"}`);
    lines.push(`Indexer status error: ${status.indexer.error}`);
  } else if (!status.indexer.present) {
    lines.push("Indexer state: unavailable");
  } else {
    lines.push(`Indexer state: ${status.indexer.state ?? "unknown"}`);
    lines.push(`Indexer pid: ${status.indexer.processId ?? "none"}`);
    lines.push(`Indexer wallet root: ${status.indexer.walletRootId ?? "unknown"}`);
    lines.push(`Indexer core best height: ${status.indexer.coreBestHeight ?? "none"}`);
    lines.push(`Indexer applied tip height: ${status.indexer.appliedTipHeight ?? "none"}`);
    lines.push(`Indexer applied tip hash: ${status.indexer.appliedTipHash ?? "none"}`);
    lines.push(`Indexer heartbeat: ${status.indexer.heartbeatAtUnixMs ?? "none"}`);
    lines.push(`Indexer updated: ${status.indexer.updatedAtUnixMs ?? "none"}`);
    lines.push(`Indexer last error: ${status.indexer.lastError ?? "none"}`);
  }

  if (status.mining.error !== null) {
    lines.push("Mining state: corrupt");
    lines.push(`Mining status path: ${status.mining.statusPath ?? "none"}`);
    lines.push(`Mining status error: ${status.mining.error}`);
  } else if (!status.mining.present) {
    lines.push("Mining state: unavailable");
  } else {
    lines.push(`Mining run mode: ${status.mining.runMode ?? "unknown"}`);
    lines.push(`Mining state: ${status.mining.miningState ?? "unknown"}`);
    lines.push(`Mining phase: ${status.mining.currentPhase ?? "unknown"}`);
    lines.push(`Mining background worker pid: ${status.mining.backgroundWorkerPid ?? "none"}`);
    lines.push(`Mining background worker health: ${status.mining.backgroundWorkerHealth ?? "none"}`);
    lines.push(`Mining updated: ${status.mining.updatedAtUnixMs ?? "none"}`);
    lines.push(`Mining last error: ${status.mining.lastError ?? "none"}`);
    lines.push(`Mining note: ${status.mining.note ?? "none"}`);
  }

  lines.push("Live node: not checked (passive status)");
  lines.push("Run cogcoin status --live for RPC-backed balance and full service verification.");
  return lines.join("\n");
}
