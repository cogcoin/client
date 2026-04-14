import type { ManagedProgressController } from "../progress.js";
import type { BootstrapPhase, SnapshotChunkManifest, SnapshotMetadata } from "../types.js";

export interface BootstrapPersistentState {
  metadataVersion: number;
  snapshot: SnapshotMetadata;
  phase: BootstrapPhase;
  integrityVersion: number;
  chunkSizeBytes: number;
  verifiedChunkCount: number;
  downloadedBytes: number;
  validated: boolean;
  loadTxOutSetComplete: boolean;
  baseHeight: number | null;
  tipHashHex: string | null;
  lastError: string | null;
  updatedAt: number;
}

export type BootstrapStateSnapshotIdentity = "current" | "different" | "unknown";

export interface LoadedBootstrapState {
  state: BootstrapPersistentState;
  snapshotIdentity: BootstrapStateSnapshotIdentity;
}

export interface BootstrapPaths {
  directory: string;
  snapshotPath: string;
  partialSnapshotPath: string;
  statePath: string;
  quoteStatePath: string;
}

export interface DownloadSnapshotOptions {
  fetchImpl?: typeof fetch;
  metadata: SnapshotMetadata;
  manifest?: SnapshotChunkManifest;
  paths: BootstrapPaths;
  progress: Pick<ManagedProgressController, "setPhase">;
  state: BootstrapPersistentState;
  signal?: AbortSignal;
  snapshotIdentity?: BootstrapStateSnapshotIdentity;
}
