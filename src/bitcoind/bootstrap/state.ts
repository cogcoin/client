import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  BOOTSTRAP_STATE_VERSION,
  DEFAULT_SNAPSHOT_METADATA,
} from "./constants.js";
import type {
  BootstrapPaths,
  BootstrapPersistentState,
  LoadedBootstrapState,
} from "./types.js";
import type {
  BootstrapPhase,
  SnapshotMetadata,
} from "../types.js";

function createInitialBootstrapState(snapshot: SnapshotMetadata): BootstrapPersistentState {
  return {
    metadataVersion: BOOTSTRAP_STATE_VERSION,
    snapshot,
    phase: "snapshot_download",
    integrityVersion: 0,
    chunkSizeBytes: 0,
    verifiedChunkCount: 0,
    downloadedBytes: 0,
    validated: false,
    loadTxOutSetComplete: false,
    baseHeight: null,
    tipHashHex: null,
    lastError: null,
    updatedAt: Date.now(),
  };
}

async function writeJsonAtomic(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, JSON.stringify(payload, null, 2));
  await rename(tempPath, path);
}

function snapshotIdentityMatches(
  parsed: Partial<BootstrapPersistentState>,
  snapshot: SnapshotMetadata,
): boolean {
  return parsed.snapshot?.sha256 === snapshot.sha256
    && parsed.snapshot?.sizeBytes === snapshot.sizeBytes
    && parsed.snapshot?.height === snapshot.height
    && parsed.snapshot?.filename === snapshot.filename;
}

function normalizeLoadedBootstrapState(
  parsed: Partial<BootstrapPersistentState>,
  snapshot: SnapshotMetadata,
): BootstrapPersistentState | null {
  if (
    typeof parsed.downloadedBytes !== "number"
    || typeof parsed.validated !== "boolean"
    || typeof parsed.loadTxOutSetComplete !== "boolean"
  ) {
    return null;
  }

  return {
    metadataVersion: BOOTSTRAP_STATE_VERSION,
    snapshot,
    phase: parsed.phase ?? "snapshot_download",
    integrityVersion: typeof parsed.integrityVersion === "number" ? parsed.integrityVersion : 0,
    chunkSizeBytes: typeof parsed.chunkSizeBytes === "number" ? parsed.chunkSizeBytes : 0,
    verifiedChunkCount: typeof parsed.verifiedChunkCount === "number" ? parsed.verifiedChunkCount : 0,
    downloadedBytes: parsed.downloadedBytes,
    validated: parsed.validated,
    loadTxOutSetComplete: parsed.loadTxOutSetComplete,
    baseHeight: parsed.baseHeight ?? null,
    tipHashHex: parsed.tipHashHex ?? null,
    lastError: parsed.lastError ?? null,
    updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
  };
}

export async function loadBootstrapStateRecord(
  paths: BootstrapPaths,
  snapshot: SnapshotMetadata,
): Promise<LoadedBootstrapState> {
  try {
    const raw = await readFile(paths.statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<BootstrapPersistentState>;
    const snapshotIdentity = parsed.snapshot === undefined
      ? "unknown"
      : snapshotIdentityMatches(parsed, snapshot)
        ? "current"
        : "different";
    const normalized = normalizeLoadedBootstrapState(parsed, snapshot);

    if (normalized !== null) {
      return {
        state: normalized,
        snapshotIdentity,
      };
    }
  } catch {
    // Fall back to a fresh state.
  }

  const state = createInitialBootstrapState(snapshot);
  await writeJsonAtomic(paths.statePath, state);
  return {
    state,
    snapshotIdentity: "unknown",
  };
}

export async function loadBootstrapState(
  paths: BootstrapPaths,
  snapshot: SnapshotMetadata,
): Promise<BootstrapPersistentState> {
  return (await loadBootstrapStateRecord(paths, snapshot)).state;
}

export async function saveBootstrapState(
  paths: BootstrapPaths,
  state: BootstrapPersistentState,
): Promise<void> {
  state.updatedAt = Date.now();
  await writeJsonAtomic(paths.statePath, state);
}

export function createBootstrapStateForTesting(
  snapshot: SnapshotMetadata = DEFAULT_SNAPSHOT_METADATA,
): {
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
} {
  return createInitialBootstrapState(snapshot);
}

export async function loadBootstrapStateForTesting(
  paths: BootstrapPaths,
  snapshot: SnapshotMetadata = DEFAULT_SNAPSHOT_METADATA,
): Promise<{
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
}> {
  return loadBootstrapState(paths, snapshot);
}

export async function saveBootstrapStateForTesting(
  paths: BootstrapPaths,
  state: {
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
  },
): Promise<void> {
  await saveBootstrapState(paths, { ...state });
}
