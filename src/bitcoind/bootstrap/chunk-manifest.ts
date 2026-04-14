import {
  DEFAULT_SNAPSHOT_CHUNK_SIZE_BYTES,
  SNAPSHOT_CHUNK_MANIFEST_VERSION,
} from "./constants.js";
import { DEFAULT_SNAPSHOT_CHUNK_MANIFEST } from "./default-snapshot-chunk-manifest.js";
import { DEFAULT_SNAPSHOT_METADATA } from "./constants.js";
import type { BootstrapPersistentState } from "./types.js";
import type { SnapshotChunkManifest, SnapshotMetadata } from "../types.js";

function snapshotMatchesManifest(
  manifest: SnapshotChunkManifest,
  snapshot: SnapshotMetadata,
): boolean {
  return manifest.snapshotFilename === snapshot.filename
    && manifest.snapshotHeight === snapshot.height
    && manifest.snapshotSizeBytes === snapshot.sizeBytes
    && manifest.snapshotSha256 === snapshot.sha256;
}

function snapshotMatchesDefault(snapshot: SnapshotMetadata): boolean {
  return snapshot.filename === DEFAULT_SNAPSHOT_METADATA.filename
    && snapshot.height === DEFAULT_SNAPSHOT_METADATA.height
    && snapshot.sizeBytes === DEFAULT_SNAPSHOT_METADATA.sizeBytes
    && snapshot.sha256 === DEFAULT_SNAPSHOT_METADATA.sha256;
}

export function resolveBundledSnapshotChunkManifest(
  snapshot: SnapshotMetadata = DEFAULT_SNAPSHOT_METADATA,
): SnapshotChunkManifest {
  if (!snapshotMatchesDefault(snapshot)) {
    throw new Error(`snapshot_chunk_manifest_unavailable_${snapshot.filename}`);
  }

  if (!snapshotMatchesManifest(DEFAULT_SNAPSHOT_CHUNK_MANIFEST, snapshot)) {
    throw new Error(`snapshot_chunk_manifest_mismatch_${snapshot.filename}`);
  }

  return DEFAULT_SNAPSHOT_CHUNK_MANIFEST;
}

export function resolveSnapshotChunkCount(
  manifest: SnapshotChunkManifest,
): number {
  return manifest.chunkSha256s.length;
}

export function resolveSnapshotChunkSize(
  manifest: SnapshotChunkManifest,
  chunkIndex: number,
): number {
  if (chunkIndex < 0 || chunkIndex >= manifest.chunkSha256s.length) {
    throw new Error(`snapshot_chunk_index_out_of_range_${chunkIndex}`);
  }

  const lastChunkIndex = manifest.chunkSha256s.length - 1;

  if (chunkIndex < lastChunkIndex) {
    return manifest.chunkSizeBytes;
  }

  const trailingBytes = manifest.snapshotSizeBytes % manifest.chunkSizeBytes;
  return trailingBytes === 0 ? manifest.chunkSizeBytes : trailingBytes;
}

export function resolveVerifiedChunkBytes(
  manifest: SnapshotChunkManifest,
  verifiedChunkCount: number,
): number {
  const chunkCount = clampVerifiedChunkCount(manifest, verifiedChunkCount);

  if (chunkCount <= 0) {
    return 0;
  }

  if (chunkCount >= manifest.chunkSha256s.length) {
    return manifest.snapshotSizeBytes;
  }

  return chunkCount * manifest.chunkSizeBytes;
}

export function resolveVerifiedChunkCountFromBytes(
  manifest: SnapshotChunkManifest,
  bytes: number,
): number {
  if (bytes >= manifest.snapshotSizeBytes) {
    return manifest.chunkSha256s.length;
  }

  if (bytes <= 0) {
    return 0;
  }

  return Math.floor(bytes / manifest.chunkSizeBytes);
}

export function clampVerifiedChunkCount(
  manifest: SnapshotChunkManifest,
  verifiedChunkCount: number,
): number {
  if (!Number.isFinite(verifiedChunkCount) || verifiedChunkCount <= 0) {
    return 0;
  }

  return Math.min(Math.trunc(verifiedChunkCount), manifest.chunkSha256s.length);
}

export function stateHasTrustedIntegrityFrontier(
  state: BootstrapPersistentState,
  manifest: SnapshotChunkManifest,
): boolean {
  if (state.integrityVersion !== SNAPSHOT_CHUNK_MANIFEST_VERSION) {
    return false;
  }

  if (state.chunkSizeBytes !== manifest.chunkSizeBytes) {
    return false;
  }

  const verifiedChunkCount = clampVerifiedChunkCount(manifest, state.verifiedChunkCount);
  const verifiedBytes = resolveVerifiedChunkBytes(manifest, verifiedChunkCount);
  return state.downloadedBytes === verifiedBytes;
}

export function createSnapshotChunkManifestRecord(options: {
  snapshot: SnapshotMetadata;
  chunkSha256s: string[];
  chunkSizeBytes?: number;
}): SnapshotChunkManifest {
  return {
    formatVersion: SNAPSHOT_CHUNK_MANIFEST_VERSION,
    chunkSizeBytes: options.chunkSizeBytes ?? DEFAULT_SNAPSHOT_CHUNK_SIZE_BYTES,
    snapshotFilename: options.snapshot.filename,
    snapshotHeight: options.snapshot.height,
    snapshotSizeBytes: options.snapshot.sizeBytes,
    snapshotSha256: options.snapshot.sha256,
    chunkSha256s: options.chunkSha256s,
  };
}
