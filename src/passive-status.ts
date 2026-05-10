import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { resolveManagedServicePaths } from "./bitcoind/service-paths.js";
import type {
  ManagedBitcoindObservedStatus,
  ManagedIndexerDaemonObservedStatus,
} from "./bitcoind/types.js";
import { openReadonlySqliteDatabase } from "./sqlite/driver.js";
import { loadLatestCheckpoint } from "./sqlite/checkpoints.js";
import { loadTipMeta } from "./sqlite/tip-meta.js";
import type { MiningRuntimeStatusV1 } from "./wallet/mining/types.js";
import type { WalletRuntimePaths } from "./wallet/runtime.js";
import {
  extractWalletRootIdHintFromWalletStateEnvelope,
  loadRawWalletStateEnvelope,
} from "./wallet/state/storage.js";

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

export interface PassiveWalletStatus {
  walletRootId: string | null;
  source: "wallet-state" | "none" | "unreadable";
  error: string | null;
}

export interface PassiveManagedBitcoindStatus {
  statusPath: string | null;
  present: boolean;
  state: string | null;
  processId: number | null;
  walletRootId: string | null;
  heartbeatAtUnixMs: number | null;
  updatedAtUnixMs: number | null;
  lastError: string | null;
  error: string | null;
}

export interface PassiveIndexerStatus {
  statusPath: string | null;
  present: boolean;
  state: string | null;
  processId: number | null;
  walletRootId: string | null;
  coreBestHeight: number | null;
  appliedTipHeight: number | null;
  appliedTipHash: string | null;
  heartbeatAtUnixMs: number | null;
  updatedAtUnixMs: number | null;
  lastError: string | null;
  error: string | null;
}

export interface PassiveMiningStatus {
  statusPath: string | null;
  present: boolean;
  runMode: string | null;
  miningState: string | null;
  currentPhase: string | null;
  backgroundWorkerPid: number | null;
  backgroundWorkerHealth: string | null;
  updatedAtUnixMs: number | null;
  lastError: string | null;
  note: string | null;
  error: string | null;
}

export interface PassiveClientStatus {
  dbPath: string;
  bitcoinDataDir: string;
  wallet: PassiveWalletStatus;
  storeInitialized: boolean;
  storeExists: boolean;
  indexedTip: PassiveTipStatus | null;
  latestCheckpoint: PassiveCheckpointStatus | null;
  bootstrap: PassiveBootstrapStatus | null;
  managedBitcoind: PassiveManagedBitcoindStatus;
  indexer: PassiveIndexerStatus;
  mining: PassiveMiningStatus;
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

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function inspectWalletStatus(runtimePaths: WalletRuntimePaths | undefined): Promise<PassiveWalletStatus> {
  if (runtimePaths === undefined) {
    return {
      walletRootId: null,
      source: "none",
      error: null,
    };
  }

  try {
    const raw = await loadRawWalletStateEnvelope({
      primaryPath: runtimePaths.walletStatePath,
      backupPath: runtimePaths.walletStateBackupPath,
    });

    if (raw === null) {
      return {
        walletRootId: null,
        source: "none",
        error: null,
      };
    }

    return {
      walletRootId: extractWalletRootIdHintFromWalletStateEnvelope(raw.envelope),
      source: "wallet-state",
      error: null,
    };
  } catch (error) {
    return {
      walletRootId: null,
      source: "unreadable",
      error: formatUnknownError(error),
    };
  }
}

async function readRuntimeStatusFile<TStatus>(
  statusPath: string | null,
): Promise<{
  status: TStatus | null;
  present: boolean;
  error: string | null;
}> {
  if (statusPath === null) {
    return {
      status: null,
      present: false,
      error: null,
    };
  }

  try {
    return {
      status: JSON.parse(await readFile(statusPath, "utf8")) as TStatus,
      present: true,
      error: null,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        status: null,
        present: false,
        error: null,
      };
    }

    return {
      status: null,
      present: true,
      error: formatUnknownError(error),
    };
  }
}

function emptyManagedBitcoindStatus(
  statusPath: string | null,
  present: boolean,
  error: string | null,
): PassiveManagedBitcoindStatus {
  return {
    statusPath,
    present,
    state: null,
    processId: null,
    walletRootId: null,
    heartbeatAtUnixMs: null,
    updatedAtUnixMs: null,
    lastError: null,
    error,
  };
}

function emptyIndexerStatus(
  statusPath: string | null,
  present: boolean,
  error: string | null,
): PassiveIndexerStatus {
  return {
    statusPath,
    present,
    state: null,
    processId: null,
    walletRootId: null,
    coreBestHeight: null,
    appliedTipHeight: null,
    appliedTipHash: null,
    heartbeatAtUnixMs: null,
    updatedAtUnixMs: null,
    lastError: null,
    error,
  };
}

function emptyMiningStatus(
  statusPath: string | null,
  present: boolean,
  error: string | null,
): PassiveMiningStatus {
  return {
    statusPath,
    present,
    runMode: null,
    miningState: null,
    currentPhase: null,
    backgroundWorkerPid: null,
    backgroundWorkerHealth: null,
    updatedAtUnixMs: null,
    lastError: null,
    note: null,
    error,
  };
}

function resolvePassiveServiceStatusPaths(
  bitcoinDataDir: string,
  runtimePaths: WalletRuntimePaths | undefined,
  walletRootId: string | null,
): {
  bitcoindStatusPath: string | null;
  indexerStatusPath: string | null;
  miningStatusPath: string | null;
} {
  if (walletRootId !== null) {
    const servicePaths = resolveManagedServicePaths(bitcoinDataDir, walletRootId);
    return {
      bitcoindStatusPath: servicePaths.bitcoindStatusPath,
      indexerStatusPath: servicePaths.indexerDaemonStatusPath,
      miningStatusPath: runtimePaths?.miningStatusPath ?? null,
    };
  }

  return {
    bitcoindStatusPath: runtimePaths?.bitcoindStatusPath ?? null,
    indexerStatusPath: runtimePaths?.indexerStatusPath ?? null,
    miningStatusPath: runtimePaths?.miningStatusPath ?? null,
  };
}

async function inspectManagedBitcoindStatus(statusPath: string | null): Promise<PassiveManagedBitcoindStatus> {
  const result = await readRuntimeStatusFile<ManagedBitcoindObservedStatus>(statusPath);

  if (result.status === null) {
    return emptyManagedBitcoindStatus(statusPath, result.present, result.error);
  }

  return {
    statusPath,
    present: true,
    state: result.status.state ?? null,
    processId: result.status.processId ?? null,
    walletRootId: result.status.walletRootId ?? null,
    heartbeatAtUnixMs: result.status.heartbeatAtUnixMs ?? null,
    updatedAtUnixMs: result.status.updatedAtUnixMs ?? null,
    lastError: result.status.lastError ?? null,
    error: null,
  };
}

async function inspectIndexerStatus(statusPath: string | null): Promise<PassiveIndexerStatus> {
  const result = await readRuntimeStatusFile<ManagedIndexerDaemonObservedStatus>(statusPath);

  if (result.status === null) {
    return emptyIndexerStatus(statusPath, result.present, result.error);
  }

  return {
    statusPath,
    present: true,
    state: result.status.state ?? null,
    processId: result.status.processId ?? null,
    walletRootId: result.status.walletRootId ?? null,
    coreBestHeight: result.status.coreBestHeight ?? null,
    appliedTipHeight: result.status.appliedTipHeight ?? null,
    appliedTipHash: result.status.appliedTipHash ?? null,
    heartbeatAtUnixMs: result.status.heartbeatAtUnixMs ?? null,
    updatedAtUnixMs: result.status.updatedAtUnixMs ?? null,
    lastError: result.status.lastError ?? null,
    error: null,
  };
}

async function inspectMiningStatus(statusPath: string | null): Promise<PassiveMiningStatus> {
  const result = await readRuntimeStatusFile<MiningRuntimeStatusV1>(statusPath);

  if (result.status === null) {
    return emptyMiningStatus(statusPath, result.present, result.error);
  }

  return {
    statusPath,
    present: true,
    runMode: result.status.runMode ?? null,
    miningState: result.status.miningState ?? null,
    currentPhase: result.status.currentPhase ?? null,
    backgroundWorkerPid: result.status.backgroundWorkerPid ?? null,
    backgroundWorkerHealth: result.status.backgroundWorkerHealth ?? null,
    updatedAtUnixMs: result.status.updatedAtUnixMs ?? null,
    lastError: result.status.lastError ?? null,
    note: result.status.note ?? null,
    error: null,
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
  runtimePaths?: WalletRuntimePaths,
): Promise<PassiveClientStatus> {
  const storeExists = await fileExists(dbPath);
  const bootstrapPath = join(bitcoinDataDir, "bootstrap", "state.json");
  const wallet = await inspectWalletStatus(runtimePaths);
  const statusPaths = resolvePassiveServiceStatusPaths(
    bitcoinDataDir,
    runtimePaths,
    wallet.walletRootId,
  );
  const managedBitcoind = await inspectManagedBitcoindStatus(statusPaths.bitcoindStatusPath);
  const indexer = await inspectIndexerStatus(statusPaths.indexerStatusPath);
  const mining = await inspectMiningStatus(statusPaths.miningStatusPath);
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
      wallet,
      storeInitialized: false,
      storeExists: false,
      indexedTip: null,
      latestCheckpoint: null,
      bootstrap,
      managedBitcoind,
      indexer,
      mining,
      storeError: null,
    };
  }

  try {
    const store = await inspectSqliteStore(dbPath);
    return {
      dbPath,
      bitcoinDataDir,
      wallet,
      storeInitialized: store.storeInitialized,
      storeExists: true,
      indexedTip: store.indexedTip,
      latestCheckpoint: store.latestCheckpoint,
      bootstrap,
      managedBitcoind,
      indexer,
      mining,
      storeError: null,
    };
  } catch (error) {
    return {
      dbPath,
      bitcoinDataDir,
      wallet,
      storeInitialized: false,
      storeExists: true,
      indexedTip: null,
      latestCheckpoint: null,
      bootstrap,
      managedBitcoind,
      indexer,
      mining,
      storeError: formatUnknownError(error),
    };
  }
}
