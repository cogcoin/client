import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { openReadonlySqliteDatabase } from "./sqlite/driver.js";
import { loadLatestCheckpoint } from "./sqlite/checkpoints.js";
import { loadTipMeta } from "./sqlite/tip-meta.js";

interface PassiveTipStatus {
  height: number;
  blockHashHex: string;
  previousHashHex: string | null;
  stateHashHex: string | null;
  updatedAt: number;
}

interface PassiveCheckpointStatus {
  height: number;
  blockHashHex: string;
  createdAt: number;
}

interface PassiveBootstrapStatus {
  phase: string;
  downloadedBytes: number;
  totalBytes: number;
  validated: boolean;
  loadTxOutSetComplete: boolean;
  baseHeight: number | null;
  tipHashHex: string | null;
  lastError: string | null;
  snapshotHeight: number | null;
  updatedAt: number | null;
}

export interface PassiveClientStatus {
  dbPath: string;
  bitcoinDataDir: string;
  storeInitialized: boolean;
  storeExists: boolean;
  indexedTip: PassiveTipStatus | null;
  latestCheckpoint: PassiveCheckpointStatus | null;
  bootstrap: PassiveBootstrapStatus | null;
  storeError: string | null;
}

function fileExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function readBootstrapState(
  raw: string,
): PassiveBootstrapStatus {
  const parsed = JSON.parse(raw) as {
    phase?: string;
    downloadedBytes?: number;
    validated?: boolean;
    loadTxOutSetComplete?: boolean;
    baseHeight?: number | null;
    tipHashHex?: string | null;
    lastError?: string | null;
    updatedAt?: number | null;
    snapshot?: {
      height?: number;
      sizeBytes?: number;
    };
  };

  return {
    phase: parsed.phase ?? "unknown",
    downloadedBytes: parsed.downloadedBytes ?? 0,
    totalBytes: parsed.snapshot?.sizeBytes ?? 0,
    validated: parsed.validated ?? false,
    loadTxOutSetComplete: parsed.loadTxOutSetComplete ?? false,
    baseHeight: parsed.baseHeight ?? null,
    tipHashHex: parsed.tipHashHex ?? null,
    lastError: parsed.lastError ?? null,
    snapshotHeight: parsed.snapshot?.height ?? null,
    updatedAt: parsed.updatedAt ?? null,
  };
}

async function inspectSqliteStore(
  dbPath: string,
): Promise<{
  storeInitialized: boolean;
  indexedTip: PassiveTipStatus | null;
  latestCheckpoint: PassiveCheckpointStatus | null;
}> {
  const database = await openReadonlySqliteDatabase(dbPath);

  try {
    const indexedTipMeta = await loadTipMeta(database);
    const checkpointRow = await loadLatestCheckpoint(database);

    return {
      storeInitialized: true,
      indexedTip: indexedTipMeta === null
        ? null
        : {
          height: indexedTipMeta.tip.height,
          blockHashHex: indexedTipMeta.tip.blockHashHex,
          previousHashHex: indexedTipMeta.tip.previousHashHex,
          stateHashHex: indexedTipMeta.tip.stateHashHex,
          updatedAt: indexedTipMeta.updatedAt,
        },
      latestCheckpoint: checkpointRow === null
        ? null
        : {
          height: checkpointRow.height,
          blockHashHex: checkpointRow.blockHashHex,
          createdAt: checkpointRow.createdAt,
        },
    };
  } finally {
    await database.close();
  }
}

export async function inspectPassiveClientStatus(
  dbPath: string,
  bitcoinDataDir: string,
): Promise<PassiveClientStatus> {
  const storeExists = await fileExists(dbPath);
  const bootstrapPath = join(bitcoinDataDir, "bootstrap", "state.json");
  let bootstrap: PassiveBootstrapStatus | null = null;

  try {
    bootstrap = readBootstrapState(await readFile(bootstrapPath, "utf8"));
  } catch {
    bootstrap = null;
  }

  if (!storeExists) {
    return {
      dbPath,
      bitcoinDataDir,
      storeInitialized: false,
      storeExists: false,
      indexedTip: null,
      latestCheckpoint: null,
      bootstrap,
      storeError: null,
    };
  }

  try {
    const store = await inspectSqliteStore(dbPath);
    return {
      dbPath,
      bitcoinDataDir,
      storeInitialized: store.storeInitialized,
      storeExists: true,
      indexedTip: store.indexedTip,
      latestCheckpoint: store.latestCheckpoint,
      bootstrap,
      storeError: null,
    };
  } catch (error) {
    return {
      dbPath,
      bitcoinDataDir,
      storeInitialized: false,
      storeExists: true,
      indexedTip: null,
      latestCheckpoint: null,
      bootstrap,
      storeError: error instanceof Error ? error.message : String(error),
    };
  }
}
