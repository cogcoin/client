import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  DEFAULT_SNAPSHOT_METADATA,
  SNAPSHOT_METADATA_VERSION,
} from "./constants.js";
import type {
  BootstrapPaths,
  BootstrapPersistentState,
} from "./types.js";
import type {
  BootstrapPhase,
  SnapshotMetadata,
} from "../types.js";

function createInitialBootstrapState(snapshot: SnapshotMetadata): BootstrapPersistentState {
  return {
    metadataVersion: SNAPSHOT_METADATA_VERSION,
    snapshot,
    phase: "snapshot_download",
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

export async function loadBootstrapState(
  paths: BootstrapPaths,
  snapshot: SnapshotMetadata,
): Promise<BootstrapPersistentState> {
  try {
    const raw = await readFile(paths.statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<BootstrapPersistentState>;

    if (
      parsed.metadataVersion === SNAPSHOT_METADATA_VERSION
      && parsed.snapshot?.url === snapshot.url
      && parsed.snapshot?.sha256 === snapshot.sha256
      && parsed.snapshot?.sizeBytes === snapshot.sizeBytes
      && parsed.snapshot?.height === snapshot.height
      && parsed.snapshot?.filename === snapshot.filename
      && typeof parsed.downloadedBytes === "number"
      && typeof parsed.validated === "boolean"
      && typeof parsed.loadTxOutSetComplete === "boolean"
    ) {
      return {
        metadataVersion: SNAPSHOT_METADATA_VERSION,
        snapshot,
        phase: parsed.phase ?? "snapshot_download",
        downloadedBytes: parsed.downloadedBytes,
        validated: parsed.validated,
        loadTxOutSetComplete: parsed.loadTxOutSetComplete,
        baseHeight: parsed.baseHeight ?? null,
        tipHashHex: parsed.tipHashHex ?? null,
        lastError: parsed.lastError ?? null,
        updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      };
    }
  } catch {
    // Fall back to a fresh state.
  }

  const state = createInitialBootstrapState(snapshot);
  await writeJsonAtomic(paths.statePath, state);
  return state;
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
