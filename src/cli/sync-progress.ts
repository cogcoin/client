import { formatBytes, formatDuration } from "../bitcoind/progress/formatting.js";
import type { ManagedBitcoindProgressEvent } from "../bitcoind/types.js";
import type { ParsedCliArgs } from "./types.js";

const SYNC_PROGRESS_LOG_INTERVAL_MS = 5_000;

export function createSyncProgressReporter(options: {
  progressOutput: ParsedCliArgs["progressOutput"];
  write: (line: string) => void;
}): (event: ManagedBitcoindProgressEvent) => void {
  let lastPhase: ManagedBitcoindProgressEvent["phase"] | null = null;
  let lastMessage = "";
  let lastDownloadPrintedAt = 0;
  let lastDownloadBytes: number | null = null;
  let lastImportPrintedAt = 0;
  let lastImportBlocks: number | null = null;
  const infoEnabled = options.progressOutput !== "none";

  function shouldPrintEntryMessage(message: string, phase: ManagedBitcoindProgressEvent["phase"]): boolean {
    if (message === "Waiting to start managed sync." || message === "Sync complete.") {
      return false;
    }

    if (message.startsWith("Warning:")) {
      return true;
    }

    if (!infoEnabled) {
      return false;
    }

    if (phase === "getblock_archive_download" || phase === "getblock_archive_import") {
      return true;
    }

    return phase === "snapshot_download"
      || phase === "wait_headers_for_snapshot"
      || phase === "load_snapshot"
      || phase === "bitcoin_sync"
      || phase === "cogcoin_sync"
      || message.includes("Getblock manifest")
      || message.startsWith("Fetching Getblock manifest.")
      || message.startsWith("Refreshing Getblock manifest.")
      || message.startsWith("Using Getblock range ");
  }

  function formatDownloadLine(
    label: string,
    event: ManagedBitcoindProgressEvent,
  ): string {
    const current = event.progress.downloadedBytes ?? 0;
    const total = event.progress.totalBytes ?? 0;
    const percent = event.progress.percent ?? (total > 0 ? (current / total) * 100 : 0);
    const speed = event.progress.bytesPerSecond === null ? "--" : `${formatBytes(event.progress.bytesPerSecond)}/s`;
    return `${label}: ${percent.toFixed(2)}% (${formatBytes(current)} / ${formatBytes(total)}, ${speed}, ETA ${formatDuration(event.progress.etaSeconds)})`;
  }

  return (event) => {
    const message = event.progress.message.trim();
    const phaseChanged = event.phase !== lastPhase;
    const messageChanged = message !== lastMessage;

    if ((phaseChanged || messageChanged) && shouldPrintEntryMessage(message, event.phase)) {
      options.write(message);
    }

    if (infoEnabled && event.phase === "getblock_archive_download") {
      const now = Date.now();
      const currentBytes = event.progress.downloadedBytes ?? 0;
      const isComplete = (event.progress.percent ?? 0) >= 100;
      const shouldPrintMilestone = phaseChanged
        || lastDownloadBytes !== currentBytes && (
          isComplete
          || now - lastDownloadPrintedAt >= SYNC_PROGRESS_LOG_INTERVAL_MS
        );

      if (shouldPrintMilestone) {
        options.write(formatDownloadLine("Getblock download", event));
        lastDownloadPrintedAt = now;
        lastDownloadBytes = currentBytes;
      }
    } else if (infoEnabled && event.phase === "snapshot_download") {
      const now = Date.now();
      const currentBytes = event.progress.downloadedBytes ?? 0;
      const isComplete = (event.progress.percent ?? 0) >= 100;
      const shouldPrintMilestone = phaseChanged
        || lastDownloadBytes !== currentBytes && (
          isComplete
          || now - lastDownloadPrintedAt >= SYNC_PROGRESS_LOG_INTERVAL_MS
        );

      if (shouldPrintMilestone) {
        options.write(formatDownloadLine("Snapshot download", event));
        lastDownloadPrintedAt = now;
        lastDownloadBytes = currentBytes;
      }
    } else if (infoEnabled && event.phase === "getblock_archive_import") {
      const now = Date.now();
      const currentBlocks = event.progress.blocks ?? 0;
      const targetBlocks = event.progress.targetHeight ?? currentBlocks;
      const isComplete = currentBlocks >= targetBlocks;
      const shouldPrintMilestone = phaseChanged
        || lastImportBlocks !== currentBlocks && (
          isComplete
          || now - lastImportPrintedAt >= SYNC_PROGRESS_LOG_INTERVAL_MS
        );

      if (shouldPrintMilestone) {
        options.write(
          `Getblock import: Bitcoin ${currentBlocks.toLocaleString()} / ${targetBlocks.toLocaleString()}`,
        );
        lastImportPrintedAt = now;
        lastImportBlocks = currentBlocks;
      }
    }

    lastPhase = event.phase;
    lastMessage = message;
  };
}
