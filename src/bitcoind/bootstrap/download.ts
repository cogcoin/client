import { mkdir, open, rename, rm } from "node:fs/promises";

import { formatManagedSyncErrorMessage } from "../errors.js";
import type { ManagedProgressController } from "../progress.js";
import {
  DEFAULT_SNAPSHOT_METADATA,
  DOWNLOAD_RETRY_BASE_MS,
  DOWNLOAD_RETRY_MAX_MS,
} from "./constants.js";
import { resetSnapshotFiles, statOrNull, validateSnapshotFileForTesting } from "./snapshot-file.js";
import { saveBootstrapState } from "./state.js";
import type {
  BootstrapPersistentState,
  DownloadSnapshotOptions,
} from "./types.js";
import type { SnapshotMetadata } from "../types.js";

function describeSnapshotDownloadError(error: unknown, url: string): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  if (error.message !== "fetch failed") {
    return error.message;
  }

  let source = url;

  try {
    source = new URL(url).host;
  } catch {
    // Keep the original URL string when parsing fails.
  }

  const cause = (error as Error & { cause?: unknown }).cause;
  const causeMessage = cause instanceof Error
    ? cause.message
    : typeof cause === "string"
      ? cause
      : null;

  return causeMessage !== null && causeMessage.length > 0
    ? `snapshot download failed from ${source}: ${causeMessage}`
    : `snapshot download failed from ${source}: fetch failed`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function updateDownloadProgress(
  progress: Pick<ManagedProgressController, "setPhase">,
  state: BootstrapPersistentState,
  downloadedBytes: number,
  resumed: boolean,
  startedAt: number,
): Promise<void> {
  const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
  const bytesPerSecond = Math.max(0, (downloadedBytes - state.downloadedBytes) / elapsedSeconds);
  const remaining = Math.max(0, state.snapshot.sizeBytes - downloadedBytes);

  return progress.setPhase("snapshot_download", {
    message: "Downloading UTXO snapshot.",
    resumed,
    downloadedBytes,
    totalBytes: state.snapshot.sizeBytes,
    percent: (downloadedBytes / state.snapshot.sizeBytes) * 100,
    bytesPerSecond,
    etaSeconds: bytesPerSecond > 0 ? remaining / bytesPerSecond : null,
    targetHeight: state.snapshot.height,
    lastError: state.lastError,
  });
}

export async function downloadSnapshotFileForTesting(
  options: DownloadSnapshotOptions,
): Promise<void> {
  const { metadata, paths, progress, fetchImpl = fetch } = options;
  const state = options.state;
  await mkdir(paths.directory, { recursive: true });

  const existingPart = await statOrNull(paths.partialSnapshotPath);
  const existingFull = await statOrNull(paths.snapshotPath);

  if (state.validated && existingFull?.size === metadata.sizeBytes) {
    await progress.setPhase("snapshot_download", {
      resumed: false,
      downloadedBytes: metadata.sizeBytes,
      totalBytes: metadata.sizeBytes,
      percent: 100,
      bytesPerSecond: null,
      etaSeconds: 0,
      lastError: null,
    });
    return;
  }

  if (!state.validated && existingFull?.size === metadata.sizeBytes) {
    try {
      await validateSnapshotFileForTesting(paths.snapshotPath, metadata);
      state.validated = true;
      state.downloadedBytes = metadata.sizeBytes;
      state.lastError = null;
      await saveBootstrapState(paths, state);
      await progress.setPhase("snapshot_download", {
        resumed: false,
        downloadedBytes: metadata.sizeBytes,
        totalBytes: metadata.sizeBytes,
        percent: 100,
        bytesPerSecond: null,
        etaSeconds: 0,
        lastError: null,
      });
      return;
    } catch {
      await resetSnapshotFiles(paths);
      state.downloadedBytes = 0;
      state.validated = false;
      await saveBootstrapState(paths, state);
    }
  }

  let retryDelayMs = DOWNLOAD_RETRY_BASE_MS;

  while (true) {
    let startOffset = existingPart?.size ?? (await statOrNull(paths.partialSnapshotPath))?.size ?? 0;

    if (startOffset > metadata.sizeBytes) {
      await rm(paths.partialSnapshotPath, { force: true });
      startOffset = 0;
    }

    const resumed = startOffset > 0;

    try {
      const headers = resumed ? { Range: `bytes=${startOffset}-` } : undefined;
      const response = await fetchImpl(metadata.url, { headers });

      if (!(response.status === 200 || response.status === 206)) {
        throw new Error(`snapshot_http_${response.status}`);
      }

      if (response.body === null) {
        throw new Error("snapshot_response_body_missing");
      }

      let writeFrom = startOffset;

      if (resumed && response.status === 200) {
        await rm(paths.partialSnapshotPath, { force: true });
        writeFrom = 0;
      }

      const file = await open(paths.partialSnapshotPath, writeFrom === 0 ? "w" : "a");
      const reader = response.body.getReader();
      const startedAt = Date.now();
      let downloadedBytes = writeFrom;
      let lastPersistAt = 0;

      await progress.setPhase("snapshot_download", {
        resumed,
        downloadedBytes,
        totalBytes: metadata.sizeBytes,
        percent: (downloadedBytes / metadata.sizeBytes) * 100,
        bytesPerSecond: null,
        etaSeconds: null,
        lastError: state.lastError,
      });

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          if (value === undefined) {
            continue;
          }

          await file.write(value);
          downloadedBytes += value.byteLength;
          const now = Date.now();
          await updateDownloadProgress(progress, state, downloadedBytes, resumed, startedAt);

          if (now - lastPersistAt >= 1_000) {
            state.downloadedBytes = downloadedBytes;
            state.lastError = null;
            await saveBootstrapState(paths, state);
            lastPersistAt = now;
          }
        }
      } finally {
        await file.close();
      }

      state.downloadedBytes = downloadedBytes;
      await saveBootstrapState(paths, state);
      await validateSnapshotFileForTesting(paths.partialSnapshotPath, metadata);
      await rename(paths.partialSnapshotPath, paths.snapshotPath);
      state.validated = true;
      state.downloadedBytes = metadata.sizeBytes;
      state.lastError = null;
      await saveBootstrapState(paths, state);
      await progress.setPhase("snapshot_download", {
        resumed,
        downloadedBytes: metadata.sizeBytes,
        totalBytes: metadata.sizeBytes,
        percent: 100,
        bytesPerSecond: null,
        etaSeconds: 0,
        lastError: null,
      });
      return;
    } catch (error) {
      const message = formatManagedSyncErrorMessage(describeSnapshotDownloadError(error, metadata.url));

      if (
        message.startsWith("snapshot_sha256_mismatch_")
        || message.startsWith("snapshot_size_mismatch_")
      ) {
        await resetSnapshotFiles(paths);
        state.downloadedBytes = 0;
        state.validated = false;
      }

      state.lastError = message;
      await saveBootstrapState(paths, state);
      await progress.setPhase("snapshot_download", {
        resumed,
        downloadedBytes: state.downloadedBytes,
        totalBytes: metadata.sizeBytes,
        percent: metadata.sizeBytes > 0 ? (state.downloadedBytes / metadata.sizeBytes) * 100 : null,
        bytesPerSecond: null,
        etaSeconds: null,
        lastError: message,
      });
      await sleep(retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, DOWNLOAD_RETRY_MAX_MS);
    }
  }
}
