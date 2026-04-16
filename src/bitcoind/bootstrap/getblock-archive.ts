import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ManagedProgressController } from "../progress.js";
import type { GetblockArchiveManifest, GetblockRangeManifest } from "../types.js";
import { DOWNLOAD_RETRY_BASE_MS, DOWNLOAD_RETRY_MAX_MS } from "./constants.js";

const GETBLOCK_ARCHIVE_STATE_VERSION = 1;
const GETBLOCK_ARCHIVE_BASE_HEIGHT = 910_000;
const GETBLOCK_ARCHIVE_RANGE_SIZE = 500;
const GETBLOCK_ARCHIVE_FIRST_HEIGHT = GETBLOCK_ARCHIVE_BASE_HEIGHT + 1;
const GETBLOCK_ARCHIVE_MANIFEST_FILENAME = "getblock-manifest.json";
const GETBLOCK_ARCHIVE_REMOTE_BASE_URL = "https://snapshots.cogcoin.org/";
const GETBLOCK_ARCHIVE_REMOTE_MANIFEST_URL = `${GETBLOCK_ARCHIVE_REMOTE_BASE_URL}getblock-manifest.json`;
const TRUSTED_FRONTIER_REVERIFY_CHUNKS = 2;
const HASH_READ_BUFFER_BYTES = 1024 * 1024;
const IMPORT_POLL_MS = 2_000;

interface GetblockArchivePaths {
  directory: string;
  artifactPath: string;
  partialArtifactPath: string;
  statePath: string;
}

interface GetblockArchiveDownloadState {
  metadataVersion: number;
  formatVersion: number;
  firstBlockHeight: number | null;
  lastBlockHeight: number | null;
  artifactSizeBytes: number;
  artifactSha256: string | null;
  chunkSizeBytes: number;
  verifiedChunkCount: number;
  downloadedBytes: number;
  validated: boolean;
  lastError: string | null;
  updatedAt: number;
}

export interface ReadyGetblockArchive {
  manifest: GetblockArchiveManifest;
  artifactPath: string;
}

export interface RefreshedGetblockManifest {
  manifest: GetblockRangeManifest | null;
  source: "remote" | "cache" | "none";
}

function buildRangeFilename(firstBlockHeight: number, lastBlockHeight: number): string {
  return `getblock-${firstBlockHeight}-${lastBlockHeight}.dat`;
}

function resolveManifestCachePath(dataDir: string): string {
  return join(dataDir, "bootstrap", "getblock", GETBLOCK_ARCHIVE_MANIFEST_FILENAME);
}

function createInitialState(): GetblockArchiveDownloadState {
  return {
    metadataVersion: GETBLOCK_ARCHIVE_STATE_VERSION,
    formatVersion: 0,
    firstBlockHeight: null,
    lastBlockHeight: null,
    artifactSizeBytes: 0,
    artifactSha256: null,
    chunkSizeBytes: 0,
    verifiedChunkCount: 0,
    downloadedBytes: 0,
    validated: false,
    lastError: null,
    updatedAt: Date.now(),
  };
}

function assertRangeManifestShape(parsed: unknown): GetblockArchiveManifest {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("managed_getblock_archive_manifest_invalid");
  }

  const manifest = parsed as Partial<GetblockArchiveManifest>;

  if (
    manifest.formatVersion !== 1
    || manifest.chain !== "main"
    || manifest.baseSnapshotHeight !== GETBLOCK_ARCHIVE_BASE_HEIGHT
    || typeof manifest.firstBlockHeight !== "number"
    || typeof manifest.lastBlockHeight !== "number"
    || typeof manifest.artifactFilename !== "string"
    || typeof manifest.artifactSizeBytes !== "number"
    || typeof manifest.artifactSha256 !== "string"
    || typeof manifest.chunkSizeBytes !== "number"
    || !Array.isArray(manifest.chunkSha256s)
    || manifest.chunkSha256s.some((hash) => typeof hash !== "string")
  ) {
    throw new Error("managed_getblock_archive_manifest_invalid");
  }

  if (
    manifest.lastBlockHeight - manifest.firstBlockHeight + 1 !== GETBLOCK_ARCHIVE_RANGE_SIZE
    || manifest.artifactFilename !== buildRangeFilename(manifest.firstBlockHeight, manifest.lastBlockHeight)
  ) {
    throw new Error("managed_getblock_archive_manifest_invalid");
  }

  return manifest as GetblockArchiveManifest;
}

function assertAggregateManifestShape(parsed: unknown): GetblockRangeManifest {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("managed_getblock_archive_manifest_invalid");
  }

  const manifest = parsed as Partial<GetblockRangeManifest>;

  if (
    manifest.formatVersion !== 1
    || manifest.chain !== "main"
    || manifest.baseSnapshotHeight !== GETBLOCK_ARCHIVE_BASE_HEIGHT
    || manifest.rangeSizeBlocks !== GETBLOCK_ARCHIVE_RANGE_SIZE
    || typeof manifest.publishedThroughHeight !== "number"
    || !Array.isArray(manifest.ranges)
  ) {
    throw new Error("managed_getblock_archive_manifest_invalid");
  }

  const ranges = manifest.ranges.map((entry) => assertRangeManifestShape(entry));
  let expectedFirstBlockHeight = GETBLOCK_ARCHIVE_FIRST_HEIGHT;

  for (const range of ranges) {
    if (range.firstBlockHeight !== expectedFirstBlockHeight) {
      throw new Error("managed_getblock_archive_manifest_invalid");
    }

    expectedFirstBlockHeight = range.lastBlockHeight + 1;
  }

  const expectedPublishedThrough = ranges.length === 0
    ? GETBLOCK_ARCHIVE_BASE_HEIGHT
    : ranges[ranges.length - 1]!.lastBlockHeight;

  if (manifest.publishedThroughHeight !== expectedPublishedThrough) {
    throw new Error("managed_getblock_archive_manifest_invalid");
  }

  return {
    formatVersion: manifest.formatVersion,
    chain: manifest.chain,
    baseSnapshotHeight: manifest.baseSnapshotHeight,
    rangeSizeBlocks: manifest.rangeSizeBlocks,
    publishedThroughHeight: manifest.publishedThroughHeight,
    ranges,
  };
}

function resolvePaths(
  dataDir: string,
  firstBlockHeight: number,
  lastBlockHeight: number,
): GetblockArchivePaths {
  const directory = join(dataDir, "bootstrap", "getblock");
  const artifactFilename = buildRangeFilename(firstBlockHeight, lastBlockHeight);

  return {
    directory,
    artifactPath: join(directory, artifactFilename),
    partialArtifactPath: join(directory, `${artifactFilename}.part`),
    statePath: join(directory, `getblock-${firstBlockHeight}-${lastBlockHeight}.state.json`),
  };
}

async function statOrNull(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJsonAtomic(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, JSON.stringify(payload, null, 2));
  await rename(tempPath, path);
}

async function writeTextAtomic(path: string, payload: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, payload);
  await rename(tempPath, path);
}

async function loadState(paths: GetblockArchivePaths): Promise<GetblockArchiveDownloadState> {
  try {
    const parsed = JSON.parse(await readFile(paths.statePath, "utf8")) as Partial<GetblockArchiveDownloadState>;

    if (typeof parsed.downloadedBytes !== "number" || typeof parsed.verifiedChunkCount !== "number") {
      throw new Error("managed_getblock_archive_state_invalid");
    }

    return {
      metadataVersion: GETBLOCK_ARCHIVE_STATE_VERSION,
      formatVersion: typeof parsed.formatVersion === "number" ? parsed.formatVersion : 0,
      firstBlockHeight: typeof parsed.firstBlockHeight === "number" ? parsed.firstBlockHeight : null,
      lastBlockHeight: typeof parsed.lastBlockHeight === "number" ? parsed.lastBlockHeight : null,
      artifactSizeBytes: typeof parsed.artifactSizeBytes === "number" ? parsed.artifactSizeBytes : 0,
      artifactSha256: typeof parsed.artifactSha256 === "string" ? parsed.artifactSha256 : null,
      chunkSizeBytes: typeof parsed.chunkSizeBytes === "number" ? parsed.chunkSizeBytes : 0,
      verifiedChunkCount: parsed.verifiedChunkCount,
      downloadedBytes: parsed.downloadedBytes,
      validated: parsed.validated === true,
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Ignore corrupt state and start cleanly.
    }

    const state = createInitialState();
    await saveState(paths, state);
    return state;
  }
}

async function saveState(paths: GetblockArchivePaths, state: GetblockArchiveDownloadState): Promise<void> {
  state.updatedAt = Date.now();
  await mkdir(paths.directory, { recursive: true });
  await writeJsonAtomic(paths.statePath, state);
}

function resolveChunkSize(manifest: GetblockArchiveManifest, chunkIndex: number): number {
  const lastChunkIndex = manifest.chunkSha256s.length - 1;

  if (chunkIndex < lastChunkIndex) {
    return manifest.chunkSizeBytes;
  }

  const trailingBytes = manifest.artifactSizeBytes % manifest.chunkSizeBytes;
  return trailingBytes === 0 ? manifest.chunkSizeBytes : trailingBytes;
}

function resolveVerifiedBytes(manifest: GetblockArchiveManifest, verifiedChunkCount: number): number {
  if (verifiedChunkCount <= 0) {
    return 0;
  }

  if (verifiedChunkCount >= manifest.chunkSha256s.length) {
    return manifest.artifactSizeBytes;
  }

  return verifiedChunkCount * manifest.chunkSizeBytes;
}

function resolveVerifiedChunkCountFromBytes(manifest: GetblockArchiveManifest, bytes: number): number {
  let verifiedChunkCount = 0;

  while (
    verifiedChunkCount < manifest.chunkSha256s.length
    && resolveVerifiedBytes(manifest, verifiedChunkCount + 1) <= bytes
  ) {
    verifiedChunkCount += 1;
  }

  return verifiedChunkCount;
}

function stateMatchesManifest(state: GetblockArchiveDownloadState, manifest: GetblockArchiveManifest): boolean {
  return state.firstBlockHeight === manifest.firstBlockHeight
    && state.lastBlockHeight === manifest.lastBlockHeight
    && state.artifactSha256 === manifest.artifactSha256
    && state.artifactSizeBytes === manifest.artifactSizeBytes
    && state.chunkSizeBytes === manifest.chunkSizeBytes
    && state.formatVersion === manifest.formatVersion;
}

async function hashChunkRange(path: string, manifest: GetblockArchiveManifest, chunkIndex: number): Promise<string | null> {
  const file = await open(path, "r");
  const chunkSizeBytes = resolveChunkSize(manifest, chunkIndex);
  const buffer = Buffer.allocUnsafe(Math.min(HASH_READ_BUFFER_BYTES, chunkSizeBytes));
  const hash = createHash("sha256");
  let remainingBytes = chunkSizeBytes;
  let position = resolveVerifiedBytes(manifest, chunkIndex);

  try {
    while (remainingBytes > 0) {
      const readLength = Math.min(buffer.length, remainingBytes);
      const { bytesRead } = await file.read(buffer, 0, readLength, position);

      if (bytesRead === 0) {
        return null;
      }

      hash.update(buffer.subarray(0, bytesRead));
      remainingBytes -= bytesRead;
      position += bytesRead;
    }
  } finally {
    await file.close();
  }

  return hash.digest("hex");
}

async function scanVerifiedPrefix(path: string, manifest: GetblockArchiveManifest, fileSize: number): Promise<number> {
  for (let chunkIndex = 0; chunkIndex < manifest.chunkSha256s.length; chunkIndex += 1) {
    const chunkEnd = resolveVerifiedBytes(manifest, chunkIndex + 1);

    if (fileSize < chunkEnd) {
      return chunkIndex;
    }

    const actualSha256 = await hashChunkRange(path, manifest, chunkIndex);

    if (actualSha256 !== manifest.chunkSha256s[chunkIndex]) {
      return chunkIndex;
    }
  }

  return manifest.chunkSha256s.length;
}

async function reverifyTrustedFrontier(
  path: string,
  manifest: GetblockArchiveManifest,
  verifiedChunkCount: number,
  fileSize: number,
): Promise<number> {
  const maxCompleteChunkCount = resolveVerifiedChunkCountFromBytes(
    manifest,
    Math.min(fileSize, manifest.artifactSizeBytes),
  );
  const tentative = Math.min(Math.max(0, verifiedChunkCount), maxCompleteChunkCount);
  const startChunk = Math.max(0, tentative - TRUSTED_FRONTIER_REVERIFY_CHUNKS);

  for (let chunkIndex = startChunk; chunkIndex < tentative; chunkIndex += 1) {
    const actualSha256 = await hashChunkRange(path, manifest, chunkIndex);

    if (actualSha256 !== manifest.chunkSha256s[chunkIndex]) {
      return chunkIndex;
    }
  }

  return tentative;
}

async function truncateFile(path: string, size: number): Promise<void> {
  const file = await open(path, "a+");

  try {
    await file.truncate(size);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function reconcilePartialDownloadArtifacts(
  paths: GetblockArchivePaths,
  manifest: GetblockArchiveManifest,
  state: GetblockArchiveDownloadState,
): Promise<void> {
  const partialInfo = await statOrNull(paths.partialArtifactPath);

  if (partialInfo === null || !stateMatchesManifest(state, manifest)) {
    await rm(paths.partialArtifactPath, { force: true }).catch(() => undefined);
    state.formatVersion = manifest.formatVersion;
    state.firstBlockHeight = manifest.firstBlockHeight;
    state.lastBlockHeight = manifest.lastBlockHeight;
    state.artifactSizeBytes = manifest.artifactSizeBytes;
    state.artifactSha256 = manifest.artifactSha256;
    state.chunkSizeBytes = manifest.chunkSizeBytes;
    state.verifiedChunkCount = 0;
    state.downloadedBytes = 0;
    state.validated = false;
    state.lastError = null;
    await saveState(paths, state);
    return;
  }

  const partialSize = Number(partialInfo.size);
  const verifiedChunkCount = stateMatchesManifest(state, manifest)
    ? await reverifyTrustedFrontier(paths.partialArtifactPath, manifest, state.verifiedChunkCount, partialSize)
    : await scanVerifiedPrefix(paths.partialArtifactPath, manifest, partialSize);
  const verifiedBytes = resolveVerifiedBytes(manifest, verifiedChunkCount);

  if (partialSize !== verifiedBytes) {
    await truncateFile(paths.partialArtifactPath, verifiedBytes);
  }

  state.formatVersion = manifest.formatVersion;
  state.firstBlockHeight = manifest.firstBlockHeight;
  state.lastBlockHeight = manifest.lastBlockHeight;
  state.artifactSizeBytes = manifest.artifactSizeBytes;
  state.artifactSha256 = manifest.artifactSha256;
  state.chunkSizeBytes = manifest.chunkSizeBytes;
  state.verifiedChunkCount = verifiedChunkCount;
  state.downloadedBytes = verifiedBytes;
  state.validated = false;
  state.lastError = null;
  await saveState(paths, state);
}

async function validateWholeFile(path: string, manifest: GetblockArchiveManifest): Promise<void> {
  const file = await open(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_READ_BUFFER_BYTES);
  let position = 0;

  try {
    while (position < manifest.artifactSizeBytes) {
      const length = Math.min(buffer.length, manifest.artifactSizeBytes - position);
      const { bytesRead } = await file.read(buffer, 0, length, position);

      if (bytesRead === 0) {
        throw new Error("managed_getblock_archive_truncated");
      }

      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await file.close();
  }

  if (hash.digest("hex") !== manifest.artifactSha256) {
    throw new Error("managed_getblock_archive_sha256_mismatch");
  }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }

  if (signal?.aborted) {
    throw new Error("managed_getblock_archive_aborted");
  }

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("managed_getblock_archive_aborted"));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function updateDownloadProgress(
  progress: Pick<ManagedProgressController, "setPhase">,
  manifest: GetblockArchiveManifest,
  state: GetblockArchiveDownloadState,
  startedAtUnixMs: number,
  attemptStartBytes: number,
  downloadedBytes: number,
): Promise<void> {
  const elapsedSeconds = Math.max(0.001, (Date.now() - startedAtUnixMs) / 1000);
  const bytesPerSecond = Math.max(0, (downloadedBytes - attemptStartBytes) / elapsedSeconds);
  const remaining = Math.max(0, manifest.artifactSizeBytes - downloadedBytes);

  await progress.setPhase("getblock_archive_download", {
    message: "Downloading getblock range.",
    resumed: downloadedBytes > 0,
    downloadedBytes,
    totalBytes: manifest.artifactSizeBytes,
    percent: manifest.artifactSizeBytes > 0 ? (downloadedBytes / manifest.artifactSizeBytes) * 100 : 0,
    bytesPerSecond,
    etaSeconds: bytesPerSecond > 0 ? remaining / bytesPerSecond : null,
    targetHeight: manifest.lastBlockHeight,
    lastError: state.lastError,
  });
}

async function downloadRemoteArchive(
  paths: GetblockArchivePaths,
  manifest: GetblockArchiveManifest,
  state: GetblockArchiveDownloadState,
  progress: Pick<ManagedProgressController, "setPhase">,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<void> {
  await reconcilePartialDownloadArtifacts(paths, manifest, state);

  if (state.downloadedBytes >= manifest.artifactSizeBytes) {
    await validateWholeFile(paths.partialArtifactPath, manifest);
    await rename(paths.partialArtifactPath, paths.artifactPath);
    state.validated = true;
    state.verifiedChunkCount = manifest.chunkSha256s.length;
    state.downloadedBytes = manifest.artifactSizeBytes;
    state.lastError = null;
    await saveState(paths, state);
    return;
  }

  let retryDelayMs = DOWNLOAD_RETRY_BASE_MS;

  while (true) {
    const startOffset = state.downloadedBytes;

    try {
      const response = await fetchImpl(`${GETBLOCK_ARCHIVE_REMOTE_BASE_URL}${manifest.artifactFilename}`, {
        headers: startOffset > 0 ? { Range: `bytes=${startOffset}-` } : undefined,
        signal,
      });

      if (startOffset > 0 && response.status !== 206) {
        throw new Error(response.status === 200
          ? "managed_getblock_archive_resume_requires_partial_content"
          : `managed_getblock_archive_http_${response.status}`);
      }

      if (startOffset === 0 && response.status !== 200) {
        throw new Error(`managed_getblock_archive_http_${response.status}`);
      }

      if (response.body === null) {
        throw new Error("managed_getblock_archive_response_body_missing");
      }

      const file = await open(paths.partialArtifactPath, startOffset > 0 ? "a" : "w");
      const reader = response.body.getReader();
      const startedAtUnixMs = Date.now();
      let downloadedBytes = startOffset;
      let currentChunkIndex = state.verifiedChunkCount;
      let currentChunkBytes = 0;
      let currentChunkHash = createHash("sha256");

      try {
        await updateDownloadProgress(progress, manifest, state, startedAtUnixMs, startOffset, downloadedBytes);

        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          if (value === undefined || value.byteLength === 0) {
            continue;
          }

          let offset = 0;

          while (offset < value.byteLength) {
            const chunkSizeBytes = resolveChunkSize(manifest, currentChunkIndex);
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

              if (actualSha256 !== manifest.chunkSha256s[currentChunkIndex]) {
                const verifiedBytes = resolveVerifiedBytes(manifest, currentChunkIndex);
                await file.truncate(verifiedBytes);
                await file.sync();
                throw new Error(`managed_getblock_archive_chunk_sha256_mismatch_${currentChunkIndex}`);
              }

              currentChunkIndex += 1;
              currentChunkBytes = 0;
              currentChunkHash = createHash("sha256");
              state.verifiedChunkCount = currentChunkIndex;
              state.downloadedBytes = resolveVerifiedBytes(manifest, currentChunkIndex);
              state.lastError = null;
              await file.sync();
              await saveState(paths, state);
            }
          }

          await updateDownloadProgress(progress, manifest, state, startedAtUnixMs, startOffset, downloadedBytes);
        }
      } finally {
        await file.close();
      }

      await validateWholeFile(paths.partialArtifactPath, manifest);
      await rename(paths.partialArtifactPath, paths.artifactPath);
      state.validated = true;
      state.verifiedChunkCount = manifest.chunkSha256s.length;
      state.downloadedBytes = manifest.artifactSizeBytes;
      state.lastError = null;
      await saveState(paths, state);
      await progress.setPhase("getblock_archive_download", {
        message: "Downloading getblock range.",
        resumed: startOffset > 0,
        downloadedBytes: manifest.artifactSizeBytes,
        totalBytes: manifest.artifactSizeBytes,
        percent: 100,
        bytesPerSecond: null,
        etaSeconds: 0,
        targetHeight: manifest.lastBlockHeight,
        lastError: null,
      });
      return;
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      await saveState(paths, state);

      if (signal?.aborted) {
        throw error;
      }

      await progress.setPhase("getblock_archive_download", {
        message: "Downloading getblock range.",
        resumed: startOffset > 0,
        downloadedBytes: state.downloadedBytes,
        totalBytes: manifest.artifactSizeBytes,
        percent: manifest.artifactSizeBytes > 0 ? (state.downloadedBytes / manifest.artifactSizeBytes) * 100 : 0,
        bytesPerSecond: null,
        etaSeconds: null,
        targetHeight: manifest.lastBlockHeight,
        lastError: state.lastError,
      });
      await sleep(retryDelayMs, signal);
      retryDelayMs = Math.min(retryDelayMs * 2, DOWNLOAD_RETRY_MAX_MS);
    }
  }
}

async function fetchManifestRange(
  fetchImpl: typeof fetch,
  firstBlockHeight: number,
  lastBlockHeight: number,
  signal?: AbortSignal,
): Promise<GetblockArchiveManifest | null> {
  const refreshed = await refreshGetblockManifestCache({
    dataDir: "",
    fetchImpl,
    signal,
    persist: false,
  });

  if (refreshed.manifest === null) {
    return null;
  }

  return resolveGetblockArchiveRange(
    refreshed.manifest,
    firstBlockHeight,
    lastBlockHeight,
  );
}

async function fetchAggregateManifest(
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ manifest: GetblockRangeManifest; rawText: string }> {
  const response = await fetchImpl(GETBLOCK_ARCHIVE_REMOTE_MANIFEST_URL, { signal });

  if (!response.ok) {
    throw new Error(`managed_getblock_archive_manifest_http_${response.status}`);
  }

  const rawText = await response.text();
  return {
    manifest: assertAggregateManifestShape(JSON.parse(rawText)),
    rawText,
  };
}

async function loadCachedAggregateManifest(dataDir: string): Promise<GetblockRangeManifest | null> {
  try {
    return assertAggregateManifestShape(
      JSON.parse(await readFile(resolveManifestCachePath(dataDir), "utf8")),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    return null;
  }
}

async function saveCachedAggregateManifest(dataDir: string, rawText: string): Promise<void> {
  await writeTextAtomic(resolveManifestCachePath(dataDir), rawText);
}

export async function refreshGetblockManifestCache(options: {
  dataDir: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  persist?: boolean;
}): Promise<RefreshedGetblockManifest> {
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const { manifest, rawText } = await fetchAggregateManifest(fetchImpl, options.signal);

    if (options.persist !== false) {
      await saveCachedAggregateManifest(options.dataDir, rawText).catch(() => undefined);
    }

    return {
      manifest,
      source: "remote",
    };
  } catch {
    if (options.persist === false) {
      return {
        manifest: null,
        source: "none",
      };
    }

    const cachedManifest = await loadCachedAggregateManifest(options.dataDir);

    return {
      manifest: cachedManifest,
      source: cachedManifest === null ? "none" : "cache",
    };
  }
}

export function resolveGetblockArchiveRange(
  manifest: GetblockRangeManifest,
  firstBlockHeight: number,
  lastBlockHeight: number,
): GetblockArchiveManifest | null {
  return manifest.ranges.find((range) =>
    range.firstBlockHeight === firstBlockHeight && range.lastBlockHeight === lastBlockHeight,
  ) ?? null;
}

export function resolveGetblockArchiveRangeForHeight(
  manifest: GetblockRangeManifest,
  height: number,
): GetblockArchiveManifest | null {
  return manifest.ranges.find((range) =>
    range.firstBlockHeight <= height && height <= range.lastBlockHeight,
  ) ?? null;
}

export function resolveGetblockArchivePathsForTesting(
  dataDir: string,
  firstBlockHeight = GETBLOCK_ARCHIVE_FIRST_HEIGHT,
  lastBlockHeight = GETBLOCK_ARCHIVE_BASE_HEIGHT + GETBLOCK_ARCHIVE_RANGE_SIZE,
): GetblockArchivePaths {
  return resolvePaths(dataDir, firstBlockHeight, lastBlockHeight);
}

async function resolveReadyLocalGetblockArchive(
  paths: GetblockArchivePaths,
  manifest: GetblockArchiveManifest,
  state: GetblockArchiveDownloadState | null = null,
): Promise<ReadyGetblockArchive | null> {
  const info = await statOrNull(paths.artifactPath);

  if (info === null || info.size !== manifest.artifactSizeBytes) {
    return null;
  }

  const loadedState = state ?? await loadState(paths);

  if (!(loadedState.validated && stateMatchesManifest(loadedState, manifest))) {
    try {
      await validateWholeFile(paths.artifactPath, manifest);
      loadedState.formatVersion = manifest.formatVersion;
      loadedState.firstBlockHeight = manifest.firstBlockHeight;
      loadedState.lastBlockHeight = manifest.lastBlockHeight;
      loadedState.artifactSizeBytes = manifest.artifactSizeBytes;
      loadedState.artifactSha256 = manifest.artifactSha256;
      loadedState.chunkSizeBytes = manifest.chunkSizeBytes;
      loadedState.verifiedChunkCount = manifest.chunkSha256s.length;
      loadedState.downloadedBytes = manifest.artifactSizeBytes;
      loadedState.validated = true;
      loadedState.lastError = null;
      await saveState(paths, loadedState);
    } catch {
      return null;
    }
  }

  return {
    manifest,
    artifactPath: paths.artifactPath,
  };
}

export async function resolveReadyGetblockArchiveForTesting(
  dataDir: string,
  manifest: GetblockArchiveManifest,
): Promise<ReadyGetblockArchive | null> {
  return resolveReadyLocalGetblockArchive(
    resolvePaths(dataDir, manifest.firstBlockHeight, manifest.lastBlockHeight),
    manifest,
  );
}

export async function preparePublishedGetblockArchiveRange(options: {
  dataDir: string;
  progress: Pick<ManagedProgressController, "setPhase">;
  manifest: GetblockArchiveManifest;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<ReadyGetblockArchive> {
  const paths = resolvePaths(options.dataDir, options.manifest.firstBlockHeight, options.manifest.lastBlockHeight);
  await mkdir(paths.directory, { recursive: true });
  const state = await loadState(paths);
  const readyLocal = await resolveReadyLocalGetblockArchive(paths, options.manifest, state);

  if (readyLocal !== null) {
    return readyLocal;
  }

  await downloadRemoteArchive(
    paths,
    options.manifest,
    state,
    options.progress,
    options.fetchImpl ?? fetch,
    options.signal,
  );

  const ready = await resolveReadyLocalGetblockArchive(paths, options.manifest, state);

  if (ready === null) {
    throw new Error("managed_getblock_archive_ready_resolution_failed");
  }

  return ready;
}

export async function prepareGetblockArchiveRange(options: {
  dataDir: string;
  progress: Pick<ManagedProgressController, "setPhase">;
  firstBlockHeight: number;
  lastBlockHeight: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<ReadyGetblockArchive | null> {
  const paths = resolvePaths(options.dataDir, options.firstBlockHeight, options.lastBlockHeight);
  await mkdir(paths.directory, { recursive: true });
  const state = await loadState(paths);
  const fetchImpl = options.fetchImpl ?? fetch;
  const refreshed = await refreshGetblockManifestCache({
    dataDir: options.dataDir,
    fetchImpl,
    signal: options.signal,
  });
  const publishedRange = refreshed.manifest === null
    ? null
    : resolveGetblockArchiveRange(refreshed.manifest, options.firstBlockHeight, options.lastBlockHeight);

  if (publishedRange !== null) {
    return preparePublishedGetblockArchiveRange({
      dataDir: options.dataDir,
      progress: options.progress,
      manifest: publishedRange,
      fetchImpl,
      signal: options.signal,
    });
  }

  const readyLocal = {
    formatVersion: state.formatVersion,
    chain: "main" as const,
    baseSnapshotHeight: GETBLOCK_ARCHIVE_BASE_HEIGHT,
    firstBlockHeight: state.firstBlockHeight ?? options.firstBlockHeight,
    lastBlockHeight: state.lastBlockHeight ?? options.lastBlockHeight,
    artifactFilename: buildRangeFilename(
      state.firstBlockHeight ?? options.firstBlockHeight,
      state.lastBlockHeight ?? options.lastBlockHeight,
    ),
    artifactSizeBytes: state.artifactSizeBytes,
    artifactSha256: state.artifactSha256 ?? "",
    chunkSizeBytes: state.chunkSizeBytes,
    chunkSha256s: [],
  };

  if (
    state.validated
    && state.firstBlockHeight === options.firstBlockHeight
    && state.lastBlockHeight === options.lastBlockHeight
    && state.artifactSha256 !== null
  ) {
    const resolved = await resolveReadyLocalGetblockArchive(paths, readyLocal, state).catch(() => null);

    if (resolved !== null) {
      return resolved;
    }
  }

  if (refreshed.source === "none") {
    throw new Error("managed_getblock_archive_manifest_refresh_failed");
  }

  return null;
}

export async function deleteGetblockArchiveRange(options: {
  dataDir: string;
  firstBlockHeight: number;
  lastBlockHeight: number;
}): Promise<void> {
  const paths = resolvePaths(options.dataDir, options.firstBlockHeight, options.lastBlockHeight);
  await rm(paths.artifactPath, { force: true }).catch(() => undefined);
  await rm(paths.partialArtifactPath, { force: true }).catch(() => undefined);
  await rm(paths.statePath, { force: true }).catch(() => undefined);
}

export async function prepareLatestGetblockArchive(options: {
  dataDir: string;
  progress: Pick<ManagedProgressController, "setPhase">;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<ReadyGetblockArchive | null> {
  return prepareGetblockArchiveRange({
    ...options,
    firstBlockHeight: GETBLOCK_ARCHIVE_FIRST_HEIGHT,
    lastBlockHeight: GETBLOCK_ARCHIVE_BASE_HEIGHT + GETBLOCK_ARCHIVE_RANGE_SIZE,
  });
}

export const prepareLatestGetblockArchiveForTesting = prepareLatestGetblockArchive;
export const prepareGetblockArchiveRangeForTesting = prepareGetblockArchiveRange;
export const preparePublishedGetblockArchiveRangeForTesting = preparePublishedGetblockArchiveRange;
export const deleteGetblockArchiveRangeForTesting = deleteGetblockArchiveRange;
export const refreshGetblockManifestCacheForTesting = refreshGetblockManifestCache;
export const resolveGetblockArchiveRangeForHeightForTesting = resolveGetblockArchiveRangeForHeight;

export async function waitForGetblockArchiveImportForTesting(
  rpc: Pick<{ getBlockchainInfo(): Promise<{ blocks: number; headers: number; bestblockhash: string }> }, "getBlockchainInfo">,
  progress: Pick<ManagedProgressController, "setPhase">,
  targetEndHeight: number,
  signal?: AbortSignal,
): Promise<void> {
  await waitForGetblockArchiveImport(rpc, progress, targetEndHeight, signal);
}

export async function waitForGetblockArchiveImport(
  rpc: Pick<{ getBlockchainInfo(): Promise<{ blocks: number; headers: number; bestblockhash: string }> }, "getBlockchainInfo">,
  progress: Pick<ManagedProgressController, "setPhase">,
  targetEndHeight: number,
  signal?: AbortSignal,
): Promise<void> {
  while (true) {
    if (signal?.aborted) {
      throw new Error("managed_getblock_archive_aborted");
    }

    const info = await rpc.getBlockchainInfo();
    await progress.setPhase("getblock_archive_import", {
      message: "Bitcoin Core is importing getblock range blocks.",
      blocks: info.blocks,
      headers: info.headers,
      targetHeight: targetEndHeight,
      etaSeconds: null,
      lastError: null,
    });

    if (info.blocks >= targetEndHeight) {
      return;
    }

    await sleep(IMPORT_POLL_MS, signal);
  }
}
