import { createHash } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";

import { formatManagedSyncErrorMessage } from "../errors.js";
import type { ManagedProgressController } from "../progress.js";
import {
  DOWNLOAD_RETRY_BASE_MS,
  DOWNLOAD_RETRY_MAX_MS,
} from "./constants.js";
import {
  applyVerifiedFrontierState,
  reconcileSnapshotDownloadArtifacts,
} from "./chunk-recovery.js";
import {
  resolveBundledSnapshotChunkManifest,
  resolveSnapshotChunkCount,
  resolveSnapshotChunkSize,
  resolveVerifiedChunkBytes,
} from "./chunk-manifest.js";
import { statOrNull, validateSnapshotFileForTesting } from "./snapshot-file.js";
import { saveBootstrapState } from "./state.js";
import type {
  BootstrapPersistentState,
  DownloadSnapshotOptions,
} from "./types.js";
import type { SnapshotChunkManifest, SnapshotMetadata } from "../types.js";

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

function createAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;

  if (reason instanceof Error) {
    return reason;
  }

  const error = new Error("managed_sync_aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }

  return error instanceof Error
    && (error.name === "AbortError" || error.message === "managed_sync_aborted");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(createAbortError(signal));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function updateDownloadProgress(
  progress: Pick<ManagedProgressController, "setPhase">,
  state: BootstrapPersistentState,
  attemptStartBytes: number,
  downloadedBytes: number,
  resumed: boolean,
  startedAt: number,
): Promise<void> {
  const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
  const bytesPerSecond = Math.max(0, (downloadedBytes - attemptStartBytes) / elapsedSeconds);
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

async function persistVerifiedChunk(
  state: BootstrapPersistentState,
  manifest: SnapshotChunkManifest,
  verifiedChunkCount: number,
  options: Pick<DownloadSnapshotOptions, "paths">,
): Promise<void> {
  applyVerifiedFrontierState(state, manifest, verifiedChunkCount);
  state.validated = false;
  state.lastError = null;
  await saveBootstrapState(options.paths, state);
}

async function finalizeSnapshotDownload(
  metadata: SnapshotMetadata,
  manifest: SnapshotChunkManifest,
  state: BootstrapPersistentState,
  options: Pick<DownloadSnapshotOptions, "paths" | "progress">,
  resumed: boolean,
): Promise<void> {
  await validateSnapshotFileForTesting(options.paths.partialSnapshotPath, metadata);
  await rename(options.paths.partialSnapshotPath, options.paths.snapshotPath);
  applyVerifiedFrontierState(state, manifest, resolveSnapshotChunkCount(manifest));
  state.validated = true;
  state.lastError = null;
  await saveBootstrapState(options.paths, state);
  await options.progress.setPhase("snapshot_download", {
    resumed,
    downloadedBytes: metadata.sizeBytes,
    totalBytes: metadata.sizeBytes,
    percent: 100,
    bytesPerSecond: null,
    etaSeconds: 0,
    lastError: null,
  });
}

async function finalizeExistingSnapshot(
  metadata: SnapshotMetadata,
  manifest: SnapshotChunkManifest,
  state: BootstrapPersistentState,
  options: Pick<DownloadSnapshotOptions, "paths" | "progress">,
): Promise<void> {
  applyVerifiedFrontierState(state, manifest, resolveSnapshotChunkCount(manifest));
  state.validated = true;
  state.lastError = null;
  await saveBootstrapState(options.paths, state);
  await rm(options.paths.partialSnapshotPath, { force: true });
  await options.progress.setPhase("snapshot_download", {
    resumed: false,
    downloadedBytes: metadata.sizeBytes,
    totalBytes: metadata.sizeBytes,
    percent: 100,
    bytesPerSecond: null,
    etaSeconds: 0,
    lastError: null,
  });
}

async function truncateToVerifiedFrontier(
  path: string,
  verifiedBytes: number,
): Promise<void> {
  const file = await open(path, "a+");

  try {
    await file.truncate(verifiedBytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function downloadSnapshotFileForTesting(
  options: DownloadSnapshotOptions,
): Promise<void> {
  const {
    metadata,
    paths,
    progress,
    fetchImpl = fetch,
    signal,
    snapshotIdentity = "current",
  } = options;
  const manifest = options.manifest ?? resolveBundledSnapshotChunkManifest(metadata);
  const state = options.state;
  await mkdir(paths.directory, { recursive: true });

  const existingFull = await statOrNull(paths.snapshotPath);

  if (state.validated && existingFull?.size === metadata.sizeBytes) {
    await finalizeExistingSnapshot(metadata, manifest, state, { paths, progress });
    return;
  }

  if (existingFull?.size === metadata.sizeBytes) {
    try {
      await validateSnapshotFileForTesting(paths.snapshotPath, metadata);
      await finalizeExistingSnapshot(metadata, manifest, state, { paths, progress });
      return;
    } catch {
      state.validated = false;
    }
  } else if (state.validated) {
    state.validated = false;
  }

  await reconcileSnapshotDownloadArtifacts(paths, state, manifest, snapshotIdentity);
  await saveBootstrapState(paths, state);
  throwIfAborted(signal);

  if (state.downloadedBytes >= metadata.sizeBytes) {
    await finalizeSnapshotDownload(metadata, manifest, state, { paths, progress }, state.downloadedBytes > 0);
    return;
  }

  let retryDelayMs = DOWNLOAD_RETRY_BASE_MS;

  while (true) {
    const startOffset = state.downloadedBytes;
    const resumed = startOffset > 0;

    try {
      throwIfAborted(signal);
      const headers = resumed ? { Range: `bytes=${startOffset}-` } : undefined;
      const response = await fetchImpl(metadata.url, { headers, signal });

      if (resumed && response.status !== 206) {
        throw new Error(response.status === 200
          ? "snapshot_resume_requires_partial_content"
          : `snapshot_http_${response.status}`);
      }

      if (!resumed && response.status !== 200) {
        throw new Error(`snapshot_http_${response.status}`);
      }

      if (response.body === null) {
        throw new Error("snapshot_response_body_missing");
      }

      const file = await open(paths.partialSnapshotPath, resumed ? "a" : "w");
      const reader = response.body.getReader();
      const startedAt = Date.now();
      const attemptStartBytes = startOffset;
      let downloadedBytes = startOffset;
      let currentChunkIndex = state.verifiedChunkCount;
      let currentChunkBytes = 0;
      let currentChunkHash = createHash("sha256");

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
          throwIfAborted(signal);
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          if (value === undefined || value.byteLength === 0) {
            continue;
          }

          let offset = 0;

          while (offset < value.byteLength) {
            if (currentChunkIndex >= manifest.chunkSha256s.length) {
              throw new Error(`snapshot_size_mismatch_${downloadedBytes + (value.byteLength - offset)}`);
            }

            const chunkSizeBytes = resolveSnapshotChunkSize(manifest, currentChunkIndex);
            const remainingChunkBytes = chunkSizeBytes - currentChunkBytes;
            const writeLength = Math.min(remainingChunkBytes, value.byteLength - offset);
            const segment = value.subarray(offset, offset + writeLength);

            await file.write(segment);
            currentChunkHash.update(segment);
            currentChunkBytes += segment.byteLength;
            downloadedBytes += segment.byteLength;
            offset += writeLength;

            if (currentChunkBytes === chunkSizeBytes) {
              const actualSha256 = currentChunkHash.digest("hex");
              const expectedSha256 = manifest.chunkSha256s[currentChunkIndex];

              if (actualSha256 !== expectedSha256) {
                const verifiedBytes = resolveVerifiedChunkBytes(manifest, currentChunkIndex);
                await file.truncate(verifiedBytes);
                await file.sync();
                throw new Error(`snapshot_chunk_sha256_mismatch_${currentChunkIndex}`);
              }

              currentChunkIndex += 1;
              currentChunkBytes = 0;
              currentChunkHash = createHash("sha256");
              await file.sync();
              await persistVerifiedChunk(state, manifest, currentChunkIndex, { paths });
            }
          }

          await updateDownloadProgress(progress, state, attemptStartBytes, downloadedBytes, resumed, startedAt);
        }

        if (downloadedBytes !== metadata.sizeBytes) {
          throw new Error(`snapshot_download_incomplete_${downloadedBytes}`);
        }
      } catch (error) {
        if (!isAbortError(error, signal)) {
          await file.truncate(state.downloadedBytes);
          await file.sync();
        }

        throw error;
      } finally {
        await file.close();
      }

      await finalizeSnapshotDownload(metadata, manifest, state, { paths, progress }, resumed);
      return;
    } catch (error) {
      if (isAbortError(error, signal)) {
        const partialInfo = await statOrNull(paths.partialSnapshotPath);

        if (partialInfo !== null) {
          await truncateToVerifiedFrontier(paths.partialSnapshotPath, state.downloadedBytes);
        }

        state.lastError = null;
        state.validated = false;
        await saveBootstrapState(paths, state);
        throw createAbortError(signal);
      }

      const message = formatManagedSyncErrorMessage(describeSnapshotDownloadError(error, metadata.url));
      state.lastError = message;
      state.validated = false;
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
      await sleep(retryDelayMs, signal);
      retryDelayMs = Math.min(retryDelayMs * 2, DOWNLOAD_RETRY_MAX_MS);
    }
  }
}
