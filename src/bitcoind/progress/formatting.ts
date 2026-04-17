import type { BootstrapPhase, BootstrapProgress, SnapshotMetadata, WritingQuote } from "../types.js";
import {
  FIELD_LEFT,
  FIELD_WIDTH,
  PREPARING_SYNC_LINE,
  PROGRESS_TICK_MS,
  SCROLL_WINDOW_LEFT,
  SCROLL_WINDOW_WIDTH,
  STATUS_ELLIPSIS_TICK_MS,
  STATUS_ELLIPSIS_WIDTH,
} from "./constants.js";

export function createDefaultMessage(phase: BootstrapPhase): string {
  switch (phase) {
    case "getblock_archive_download":
      return "Downloading getblock range.";
    case "getblock_archive_import":
      return "Bitcoin Core is importing getblock range blocks.";
    case "snapshot_download":
      return "Downloading UTXO snapshot.";
    case "wait_headers_for_snapshot":
      return "Pre-synchronizing blockheaders.";
    case "load_snapshot":
      return "Loading the UTXO snapshot into bitcoind.";
    case "bitcoin_sync":
      return "Bitcoin Core is syncing blocks.";
    case "cogcoin_sync":
      return "Cogcoin indexer is replaying blocks.";
    case "follow_tip":
      return "Following the live Bitcoin tip.";
    case "error":
      return "Sync paused by an error.";
    case "complete":
      return "Sync complete.";
    case "paused":
    default:
      return "Waiting to start managed sync.";
  }
}

export function createBootstrapProgress(
  phase: BootstrapPhase,
  snapshot: SnapshotMetadata,
): BootstrapProgress {
  return {
    phase,
    message: createDefaultMessage(phase),
    resumed: false,
    downloadedBytes: null,
    totalBytes: snapshot.sizeBytes,
    percent: null,
    bytesPerSecond: null,
    etaSeconds: null,
    headers: null,
    blocks: null,
    targetHeight: phase === "wait_headers_for_snapshot" ? snapshot.height : null,
    baseHeight: null,
    tipHashHex: null,
    lastError: null,
    updatedAt: Date.now(),
  };
}

export const createBootstrapProgressForTesting = createBootstrapProgress;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return "--:--:--";
  }

  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

export function renderBar(current: number, total: number, width: number): string {
  const safeTotal = total <= 0 ? 1 : total;
  const ratio = Math.max(0, Math.min(1, current / safeTotal));
  const filled = Math.round(width * ratio);
  return `[${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}]`;
}

export function renderIndeterminateBar(width: number, now: number): string {
  const segmentWidth = Math.min(5, width);
  const cycleWidth = width + segmentWidth;
  const offset = Math.floor(Math.max(0, now) / PROGRESS_TICK_MS) % cycleWidth;
  const start = offset - segmentWidth + 1;
  const cells = Array.from({ length: width }, (_value, index) =>
    index >= start && index < start + segmentWidth ? "█" : "░");
  return `[${cells.join("")}]`;
}

export function truncateLine(line: string, width: number): string {
  if (line.length <= width) {
    return line;
  }

  if (width <= 1) {
    return line.slice(0, width);
  }

  return `${line.slice(0, Math.max(0, width - 1))}\u2026`;
}

export function normalizeInlineText(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : "";
}

export function centerLine(line: string, width: number): string {
  const centered = truncateLine(line, width);
  const leftPadding = Math.max(0, Math.floor((width - centered.length) / 2));
  return `${" ".repeat(leftPadding)}${centered}`.padEnd(width, " ");
}

export function rightAlignLine(line: string, width: number): string {
  const aligned = truncateLine(line, width);
  const leftPadding = Math.max(0, width - aligned.length);
  return `${" ".repeat(leftPadding)}${aligned}`.padEnd(width, " ");
}

export function positionLine(line: string, width: number, leftPadding: number): string {
  const positioned = truncateLine(line, width);
  const safePadding = Math.max(0, Math.min(leftPadding, Math.max(0, width - positioned.length)));
  return `${" ".repeat(safePadding)}${positioned}`.padEnd(width, " ");
}

export function computeCenteredLeftPadding(line: string, width: number): number {
  return Math.max(0, Math.floor((width - truncateLine(line, width).length) / 2));
}

export function centerFieldText(text: string): string {
  return centerLine(text, FIELD_WIDTH);
}

export function replaceSegment(line: string, left: number, width: number, segment: string): string {
  return `${line.slice(0, left)}${segment}${line.slice(left + width)}`;
}

export function replaceWindowSegment(line: string, windowLine: string): string {
  return replaceSegment(line, SCROLL_WINDOW_LEFT, SCROLL_WINDOW_WIDTH, windowLine);
}

function animateStatusEllipsis(now: number): string {
  const dotCount = Math.floor(Math.max(0, now) / STATUS_ELLIPSIS_TICK_MS) % (STATUS_ELLIPSIS_WIDTH + 1);
  return ".".repeat(dotCount).padEnd(STATUS_ELLIPSIS_WIDTH, " ");
}

export function resolveStatusFieldText(
  progress: BootstrapProgress,
  snapshotHeight: number,
  now = 0,
): string {
  switch (progress.phase) {
    case "getblock_archive_download":
      return `Downloading getblock range${animateStatusEllipsis(now)}`;
    case "getblock_archive_import":
      return `Importing getblock range${animateStatusEllipsis(now)}`;
    case "paused":
    case "snapshot_download":
      return `Downloading snapshot to ${snapshotHeight}${animateStatusEllipsis(now)}`;
    case "wait_headers_for_snapshot":
      return progress.message === "Waiting for Bitcoin headers to reach the snapshot height."
        ? `Waiting for Bitcoin headers to reach the snapshot height${animateStatusEllipsis(now)}`
        : `Pre-synchronizing blockheaders${animateStatusEllipsis(now)}`;
    case "load_snapshot":
    case "bitcoin_sync":
      return `Syncing Bitcoin Blocks${animateStatusEllipsis(now)}`;
    case "cogcoin_sync":
      return `Syncing Cogcoin Blocks${animateStatusEllipsis(now)}`;
    case "follow_tip":
      return `Waiting for next block to be mined${animateStatusEllipsis(now)}`;
    case "complete":
      return `Sync complete${animateStatusEllipsis(now)}`;
    case "error":
      return progress.lastError === null
        ? progress.message
        : `Error: ${progress.lastError}`;
    default:
      return progress.message;
  }
}

export const resolveStatusFieldTextForTesting = resolveStatusFieldText;

export function overlayCenteredField(frame: string[], rowIndex: number, text: string): void {
  if (text.length === 0) {
    return;
  }

  const row = frame[rowIndex];

  if (row === undefined) {
    return;
  }

  frame[rowIndex] = replaceSegment(row, FIELD_LEFT, FIELD_WIDTH, centerFieldText(text));
}

export function formatQuoteLine(
  quote: WritingQuote | null,
  width = 120,
): string {
  const line = quote === null
    ? PREPARING_SYNC_LINE
    : `"${quote.quote}" - ${quote.author}`;
  return truncateLine(line, width);
}

export const formatQuoteLineForTesting = formatQuoteLine;

export function formatProgressLine(
  progress: BootstrapProgress,
  cogcoinSyncHeight: number | null,
  cogcoinSyncTargetHeight: number | null,
  width = 120,
  now = Date.now(),
): string {
  let line: string;

  switch (progress.phase) {
    case "getblock_archive_download": {
      const current = progress.downloadedBytes ?? 0;
      const total = progress.totalBytes ?? 0;
      const bar = renderBar(current, total, 20);
      const percent = progress.percent ?? (total > 0 ? (current / total) * 100 : 0);
      const speed = progress.bytesPerSecond === null ? "--" : `${formatBytes(progress.bytesPerSecond)}/s`;
      const resumed = progress.resumed ? " resumed" : "";
      line = `${bar} ${percent.toFixed(2)}% ${formatBytes(current)} / ${formatBytes(total)} ${speed} ETA ${formatDuration(progress.etaSeconds)}${resumed}`;
      break;
    }
    case "snapshot_download": {
      const current = progress.downloadedBytes ?? 0;
      const total = progress.totalBytes ?? 0;
      const bar = renderBar(current, total, 20);
      const percent = progress.percent ?? (total > 0 ? (current / total) * 100 : 0);
      const speed = progress.bytesPerSecond === null ? "--" : `${formatBytes(progress.bytesPerSecond)}/s`;
      const resumed = progress.resumed ? " resumed" : "";
      line = `${bar} ${percent.toFixed(2)}% ${formatBytes(current)} / ${formatBytes(total)} ${speed} ETA ${formatDuration(progress.etaSeconds)}${resumed}`;
      break;
    }
    case "wait_headers_for_snapshot": {
      const headers = progress.headers ?? 0;
      const target = progress.targetHeight ?? headers;
      const bar = renderBar(headers, target, 20);
      line = `${bar} Headers ${headers.toLocaleString()} / ${target.toLocaleString()} ${progress.message}`;
      break;
    }
    case "bitcoin_sync": {
      const blocks = progress.blocks ?? 0;
      const target = progress.targetHeight ?? progress.headers ?? blocks;
      const bar = renderBar(blocks, target, 20);
      line = `${bar} Bitcoin ${blocks.toLocaleString()} / ${target.toLocaleString()} ETA ${formatDuration(progress.etaSeconds)} ${progress.message}`;
      break;
    }
    case "getblock_archive_import": {
      const blocks = progress.blocks ?? 0;
      const target = progress.targetHeight ?? blocks;
      const bar = renderBar(blocks, target, 20);
      line = `${bar} Bitcoin ${blocks.toLocaleString()} / ${target.toLocaleString()} ${progress.message}`;
      break;
    }
    case "cogcoin_sync": {
      const current = cogcoinSyncHeight ?? 0;
      const target = cogcoinSyncTargetHeight ?? current;
      const bar = renderBar(current, Math.max(1, target), 20);
      line = `${bar} Cogcoin ${current.toLocaleString()} / ${target.toLocaleString()} ETA ${formatDuration(progress.etaSeconds)} ${progress.message}`;
      break;
    }
    case "load_snapshot": {
      const bar = renderIndeterminateBar(20, now);
      line = `${bar} ${progress.message}`;
      break;
    }
    case "follow_tip": {
      const bar = renderIndeterminateBar(20, now);
      line = `${bar} ${progress.message}`;
      break;
    }
    case "complete":
      line = progress.message;
      break;
    case "error":
      line = `Error: ${progress.lastError ?? progress.message}`;
      break;
    case "paused": {
      const current = progress.downloadedBytes ?? 0;
      const total = progress.totalBytes ?? 0;
      const bar = renderBar(current, Math.max(1, total), 20);
      const percent = progress.percent ?? 0;
      line = `${bar} ${percent.toFixed(2)}% ${formatBytes(current)} / ${formatBytes(total)} ${progress.message}`;
      break;
    }
    default:
      line = progress.message;
      break;
  }

  return truncateLine(line, width);
}

export const formatProgressLineForTesting = formatProgressLine;
