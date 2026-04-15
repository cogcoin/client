import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ManagedProgressController } from "../progress.js";
import type { GetblockArchiveManifest } from "../types.js";
import { DOWNLOAD_RETRY_BASE_MS, DOWNLOAD_RETRY_MAX_MS } from "./constants.js";

const GETBLOCK_ARCHIVE_STATE_VERSION = 1;
const GETBLOCK_ARCHIVE_BASE_HEIGHT = 910_000;
const GETBLOCK_ARCHIVE_FILENAME = "getblock-910000-latest.dat";
const GETBLOCK_ARCHIVE_MANIFEST_FILENAME = "getblock-910000-latest.json";
const GETBLOCK_ARCHIVE_REMOTE_DATA_URL = "https://snapshots.cogcoin.org/getblock-910000-latest.dat";
const GETBLOCK_ARCHIVE_REMOTE_MANIFEST_URL = "https://snapshots.cogcoin.org/getblock-910000-latest.json";
const TRUSTED_FRONTIER_REVERIFY_CHUNKS = 2;
const HASH_READ_BUFFER_BYTES = 1024 * 1024;
const IMPORT_POLL_MS = 2_000;

interface GetblockArchivePaths {
  directory: string;
  artifactPath: string;
  partialArtifactPath: string;
  manifestPath: string;
  partialManifestPath: string;
  statePath: string;
}

interface GetblockArchiveDownloadState {
  metadataVersion: number;
  formatVersion: number;
  endHeight: number | null;
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
  manifestPath: string;
}

function createInitialState(): GetblockArchiveDownloadState {
  return {
    metadataVersion: GETBLOCK_ARCHIVE_STATE_VERSION,
    formatVersion: 0,
    endHeight: null,
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

function assertManifestShape(parsed: unknown): GetblockArchiveManifest {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("managed_getblock_archive_manifest_invalid");
  }

  const manifest = parsed as Partial<GetblockArchiveManifest>;

  if (
    manifest.chain !== "main"
    || manifest.baseSnapshotHeight !== GETBLOCK_ARCHIVE_BASE_HEIGHT
    || manifest.artifactFilename !== GETBLOCK_ARCHIVE_FILENAME
    || typeof manifest.firstBlockHeight !== "number"
    || typeof manifest.endHeight !== "number"
    || typeof manifest.blockCount !== "number"
    || typeof manifest.artifactSizeBytes !== "number"
    || typeof manifest.artifactSha256 !== "string"
    || typeof manifest.chunkSizeBytes !== "number"
    || !Array.isArray(manifest.chunkSha256s)
    || !Array.isArray(manifest.blocks)
  ) {
    throw new Error("managed_getblock_archive_manifest_invalid");
  }

  return manifest as GetblockArchiveManifest;
}

function resolvePaths(dataDir: string): GetblockArchivePaths {
  const directory = join(dataDir, "bootstrap", "getblock");
  return {
    directory,
    artifactPath: join(directory, GETBLOCK_ARCHIVE_FILENAME),
    partialArtifactPath: join(directory, `${GETBLOCK_ARCHIVE_FILENAME}.part`),
    manifestPath: join(directory, GETBLOCK_ARCHIVE_MANIFEST_FILENAME),
    partialManifestPath: join(directory, `${GETBLOCK_ARCHIVE_MANIFEST_FILENAME}.part`),
    statePath: join(directory, "state.json"),
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

async function readManifest(path: string): Promise<GetblockArchiveManifest | null> {
  try {
    return assertManifestShape(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
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
      endHeight: typeof parsed.endHeight === "number" ? parsed.endHeight : null,
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
  return state.endHeight === manifest.endHeight
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
  const partialManifest = await readManifest(paths.partialManifestPath).catch(() => null);

  if (partialManifest === null || partialManifest.endHeight !== manifest.endHeight || partialManifest.artifactSha256 !== manifest.artifactSha256) {
    await rm(paths.partialArtifactPath, { force: true }).catch(() => undefined);
    await rm(paths.partialManifestPath, { force: true }).catch(() => undefined);
    state.formatVersion = manifest.formatVersion;
    state.endHeight = manifest.endHeight;
    state.artifactSizeBytes = manifest.artifactSizeBytes;
    state.artifactSha256 = manifest.artifactSha256;
    state.chunkSizeBytes = manifest.chunkSizeBytes;
    state.verifiedChunkCount = 0;
    state.downloadedBytes = 0;
    state.validated = false;
    state.lastError = null;
    await writeJsonAtomic(paths.partialManifestPath, manifest);
    await saveState(paths, state);
    return;
  }

  const partialInfo = await statOrNull(paths.partialArtifactPath);

  if (partialInfo === null) {
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
  state.endHeight = manifest.endHeight;
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
    message: "Downloading getblock archive.",
    resumed: downloadedBytes > 0,
    downloadedBytes,
    totalBytes: manifest.artifactSizeBytes,
    percent: manifest.artifactSizeBytes > 0 ? (downloadedBytes / manifest.artifactSizeBytes) * 100 : 0,
    bytesPerSecond,
    etaSeconds: bytesPerSecond > 0 ? remaining / bytesPerSecond : null,
    targetHeight: manifest.endHeight,
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
    await rename(paths.partialManifestPath, paths.manifestPath);
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
      const response = await fetchImpl(`${GETBLOCK_ARCHIVE_REMOTE_DATA_URL}?end=${manifest.endHeight}`, {
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
      await rename(paths.partialManifestPath, paths.manifestPath);
      state.validated = true;
      state.verifiedChunkCount = manifest.chunkSha256s.length;
      state.downloadedBytes = manifest.artifactSizeBytes;
      state.lastError = null;
      await saveState(paths, state);
      await progress.setPhase("getblock_archive_download", {
        message: "Downloading getblock archive.",
        resumed: startOffset > 0,
        downloadedBytes: manifest.artifactSizeBytes,
        totalBytes: manifest.artifactSizeBytes,
        percent: 100,
        bytesPerSecond: null,
        etaSeconds: 0,
        targetHeight: manifest.endHeight,
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
        message: "Downloading getblock archive.",
        resumed: startOffset > 0,
        downloadedBytes: state.downloadedBytes,
        totalBytes: manifest.artifactSizeBytes,
        percent: manifest.artifactSizeBytes > 0 ? (state.downloadedBytes / manifest.artifactSizeBytes) * 100 : 0,
        bytesPerSecond: null,
        etaSeconds: null,
        targetHeight: manifest.endHeight,
        lastError: state.lastError,
      });
      await sleep(retryDelayMs, signal);
      retryDelayMs = Math.min(retryDelayMs * 2, DOWNLOAD_RETRY_MAX_MS);
    }
  }
}

async function fetchLatestManifest(fetchImpl: typeof fetch, cacheBustEnd: number | null, signal?: AbortSignal): Promise<GetblockArchiveManifest> {
  const url = cacheBustEnd === null
    ? GETBLOCK_ARCHIVE_REMOTE_MANIFEST_URL
    : `${GETBLOCK_ARCHIVE_REMOTE_MANIFEST_URL}?end=${cacheBustEnd}`;
  const response = await fetchImpl(url, { signal });

  if (!response.ok) {
    throw new Error(`managed_getblock_archive_manifest_http_${response.status}`);
  }

  return assertManifestShape(await response.json());
}

export function resolveGetblockArchivePathsForTesting(dataDir: string): GetblockArchivePaths {
  return resolvePaths(dataDir);
}

export async function resolveReadyGetblockArchiveForTesting(dataDir: string): Promise<ReadyGetblockArchive | null> {
  return resolveReadyLocalGetblockArchive(resolvePaths(dataDir));
}

async function resolveReadyLocalGetblockArchive(
  paths: GetblockArchivePaths,
  state: GetblockArchiveDownloadState | null = null,
): Promise<ReadyGetblockArchive | null> {
  const manifest = await readManifest(paths.manifestPath).catch(() => null);

  if (manifest === null) {
    return null;
  }

  const info = await statOrNull(paths.artifactPath);

  if (info === null || info.size !== manifest.artifactSizeBytes) {
    return null;
  }

  const loadedState = state ?? await loadState(paths);

  if (!(loadedState.validated && stateMatchesManifest(loadedState, manifest))) {
    try {
      await validateWholeFile(paths.artifactPath, manifest);
      loadedState.formatVersion = manifest.formatVersion;
      loadedState.endHeight = manifest.endHeight;
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
    manifestPath: paths.manifestPath,
  };
}

export async function prepareLatestGetblockArchive(options: {
  dataDir: string;
  progress: Pick<ManagedProgressController, "setPhase">;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<ReadyGetblockArchive | null> {
  const paths = resolvePaths(options.dataDir);
  await mkdir(paths.directory, { recursive: true });
  const state = await loadState(paths);
  const readyLocal = await resolveReadyLocalGetblockArchive(paths, state);
  const fetchImpl = options.fetchImpl ?? fetch;
  let remoteManifest: GetblockArchiveManifest;

  try {
    remoteManifest = await fetchLatestManifest(fetchImpl, readyLocal?.manifest.endHeight ?? null, options.signal);
  } catch {
    return readyLocal;
  }

  if (
    readyLocal !== null
    && readyLocal.manifest.endHeight === remoteManifest.endHeight
    && readyLocal.manifest.artifactSha256 === remoteManifest.artifactSha256
  ) {
    return readyLocal;
  }

  if (readyLocal !== null && readyLocal.manifest.endHeight > remoteManifest.endHeight) {
    return readyLocal;
  }

  await writeJsonAtomic(paths.partialManifestPath, remoteManifest);

  try {
    await downloadRemoteArchive(paths, remoteManifest, state, options.progress, fetchImpl, options.signal);
  } catch {
    return readyLocal;
  }

  return resolveReadyLocalGetblockArchive(paths, state);
}

export const prepareLatestGetblockArchiveForTesting = prepareLatestGetblockArchive;

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
      message: "Bitcoin Core is importing getblock archive blocks.",
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
