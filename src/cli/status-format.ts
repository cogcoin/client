import type { inspectPassiveClientStatus } from "../passive-status.js";

function formatBootstrapPercent(current: number, total: number): string {
  if (total <= 0) {
    return "0.00";
  }

  return ((current / total) * 100).toFixed(2);
}

export function formatStatusReport(status: Awaited<ReturnType<typeof inspectPassiveClientStatus>>): string {
  const lines = [
    "Cogcoin Client Status",
    `DB path: ${status.dbPath}`,
    `Bitcoin datadir: ${status.bitcoinDataDir}`,
    `Store exists: ${status.storeExists ? "yes" : "no"}`,
    `Store initialized: ${status.storeInitialized ? "yes" : "no"}`,
  ];

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

  lines.push("Live node: not checked (passive status)");
  return lines.join("\n");
}
