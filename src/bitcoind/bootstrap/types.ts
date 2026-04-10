import type { ManagedProgressController } from "../progress.js";
import type { BootstrapPhase, SnapshotMetadata } from "../types.js";

export interface BootstrapPersistentState {
  metadataVersion: number;
  snapshot: SnapshotMetadata;
  phase: BootstrapPhase;
  downloadedBytes: number;
  validated: boolean;
  loadTxOutSetComplete: boolean;
  baseHeight: number | null;
  tipHashHex: string | null;
  lastError: string | null;
  updatedAt: number;
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
  paths: BootstrapPaths;
  progress: Pick<ManagedProgressController, "setPhase">;
  state: BootstrapPersistentState;
}
