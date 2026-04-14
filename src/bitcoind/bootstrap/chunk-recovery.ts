import { createHash } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";

import {
  clampVerifiedChunkCount,
  resolveSnapshotChunkCount,
  resolveSnapshotChunkSize,
  resolveVerifiedChunkBytes,
  resolveVerifiedChunkCountFromBytes,
  stateHasTrustedIntegrityFrontier,
} from "./chunk-manifest.js";
import { resetSnapshotFiles, statOrNull } from "./snapshot-file.js";
import type {
  BootstrapPaths,
  BootstrapPersistentState,
  BootstrapStateSnapshotIdentity,
} from "./types.js";
import type { SnapshotChunkManifest } from "../types.js";

const TRUSTED_FRONTIER_REVERIFY_CHUNKS = 2;
const HASH_READ_BUFFER_BYTES = 1024 * 1024;

async function moveSnapshotPathToPartial(paths: BootstrapPaths): Promise<void> {
  const partInfo = await statOrNull(paths.partialSnapshotPath);
  const fullInfo = await statOrNull(paths.snapshotPath);

  if (fullInfo === null) {
    return;
  }

  if (partInfo !== null && partInfo.size > fullInfo.size) {
    await rm(paths.snapshotPath, { force: true });
    return;
  }

  if (partInfo !== null) {
    await rm(paths.partialSnapshotPath, { force: true });
  }

  await rename(paths.snapshotPath, paths.partialSnapshotPath);
}

async function hashChunkRange(
  path: string,
  manifest: SnapshotChunkManifest,
  chunkIndex: number,
): Promise<string | null> {
  const file = await open(path, "r");
  const chunkSizeBytes = resolveSnapshotChunkSize(manifest, chunkIndex);
  const buffer = Buffer.allocUnsafe(Math.min(HASH_READ_BUFFER_BYTES, chunkSizeBytes));
  const hash = createHash("sha256");
  let remainingBytes = chunkSizeBytes;
  let position = resolveVerifiedChunkBytes(manifest, chunkIndex);

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

      if (bytesRead < readLength) {
        return remainingBytes === 0 ? hash.digest("hex") : null;
      }
    }
  } finally {
    await file.close();
  }

  return hash.digest("hex");
}

async function scanVerifiedPrefix(
  path: string,
  manifest: SnapshotChunkManifest,
  fileSize: number,
): Promise<number> {
  const chunkCount = resolveSnapshotChunkCount(manifest);

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const expectedChunkEnd = resolveVerifiedChunkBytes(manifest, chunkIndex + 1);

    if (fileSize < expectedChunkEnd) {
      return chunkIndex;
    }

    const actualSha256 = await hashChunkRange(path, manifest, chunkIndex);

    if (actualSha256 !== manifest.chunkSha256s[chunkIndex]) {
      return chunkIndex;
    }
  }

  return chunkCount;
}

async function reverifyTrustedFrontier(
  path: string,
  manifest: SnapshotChunkManifest,
  verifiedChunkCount: number,
  fileSize: number,
): Promise<number> {
  const maxCompleteChunkCount = resolveVerifiedChunkCountFromBytes(
    manifest,
    Math.min(fileSize, manifest.snapshotSizeBytes),
  );
  const tentativeVerifiedChunkCount = Math.min(
    clampVerifiedChunkCount(manifest, verifiedChunkCount),
    maxCompleteChunkCount,
  );
  const startChunk = Math.max(0, tentativeVerifiedChunkCount - TRUSTED_FRONTIER_REVERIFY_CHUNKS);

  for (let chunkIndex = startChunk; chunkIndex < tentativeVerifiedChunkCount; chunkIndex += 1) {
    const actualSha256 = await hashChunkRange(path, manifest, chunkIndex);

    if (actualSha256 !== manifest.chunkSha256s[chunkIndex]) {
      return chunkIndex;
    }
  }

  return tentativeVerifiedChunkCount;
}

async function truncatePartialSnapshot(
  paths: BootstrapPaths,
  verifiedBytes: number,
): Promise<void> {
  const file = await open(paths.partialSnapshotPath, "a+");

  try {
    await file.truncate(verifiedBytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

export function applyVerifiedFrontierState(
  state: BootstrapPersistentState,
  manifest: SnapshotChunkManifest,
  verifiedChunkCount: number,
): void {
  const clampedVerifiedChunkCount = clampVerifiedChunkCount(manifest, verifiedChunkCount);
  state.integrityVersion = manifest.formatVersion;
  state.chunkSizeBytes = manifest.chunkSizeBytes;
  state.verifiedChunkCount = clampedVerifiedChunkCount;
  state.downloadedBytes = resolveVerifiedChunkBytes(manifest, clampedVerifiedChunkCount);
}

export async function reconcileSnapshotDownloadArtifacts(
  paths: BootstrapPaths,
  state: BootstrapPersistentState,
  manifest: SnapshotChunkManifest,
  snapshotIdentity: BootstrapStateSnapshotIdentity,
): Promise<void> {
  if (snapshotIdentity === "different") {
    await resetSnapshotFiles(paths);
    state.phase = "snapshot_download";
    state.loadTxOutSetComplete = false;
    state.baseHeight = null;
    state.tipHashHex = null;
    state.lastError = null;
    applyVerifiedFrontierState(state, manifest, 0);
    state.validated = false;
    return;
  }

  if (!state.validated) {
    await moveSnapshotPathToPartial(paths);
  }

  const partialInfo = await statOrNull(paths.partialSnapshotPath);

  if (partialInfo === null) {
    applyVerifiedFrontierState(state, manifest, 0);
    state.validated = false;
    return;
  }

  const verifiedChunkCount = stateHasTrustedIntegrityFrontier(state, manifest)
    ? await reverifyTrustedFrontier(paths.partialSnapshotPath, manifest, state.verifiedChunkCount, partialInfo.size)
    : await scanVerifiedPrefix(paths.partialSnapshotPath, manifest, partialInfo.size);
  const verifiedBytes = resolveVerifiedChunkBytes(manifest, verifiedChunkCount);

  if (partialInfo.size !== verifiedBytes) {
    await truncatePartialSnapshot(paths, verifiedBytes);
  }

  applyVerifiedFrontierState(state, manifest, verifiedChunkCount);
  state.validated = false;
}
