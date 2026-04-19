import { readFile } from "node:fs/promises";

import { loadBundledGenesisParameters } from "@cogcoin/indexer";

import { readPackageVersionFromDisk } from "../package-version.js";
import {
  attachOrStartIndexerDaemon,
  readObservedIndexerDaemonStatus,
  type IndexerDaemonClient,
} from "./indexer-daemon.js";
import { resolveCogcoinProcessingStartHeight } from "./processing-start-height.js";
import { resolveManagedServicePaths, UNINITIALIZED_WALLET_ROOT_ID } from "./service-paths.js";
import { attachOrStartManagedBitcoindService } from "./service.js";
import type {
  ManagedBitcoindObservedStatus,
  ManagedIndexerDaemonObservedStatus,
} from "./types.js";

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function resolveStartOptions(options: {
  dataDir: string;
  walletRootId: string;
}): Promise<{
  chain: "main" | "regtest";
  startHeight: number;
}> {
  const paths = resolveManagedServicePaths(options.dataDir, options.walletRootId);
  const observedStatus = await readJsonFile<ManagedBitcoindObservedStatus>(paths.bitcoindStatusPath).catch(() => null);

  if (observedStatus !== null) {
    return {
      chain: observedStatus.chain,
      startHeight: observedStatus.startHeight,
    };
  }

  const genesisParameters = await loadBundledGenesisParameters();
  return {
    chain: "main",
    startHeight: resolveCogcoinProcessingStartHeight(genesisParameters),
  };
}

export interface ManagedIndexerMonitor {
  getStatus(): Promise<ManagedIndexerDaemonObservedStatus>;
  close(): Promise<void>;
}

export async function openManagedIndexerMonitor(options: {
  dataDir: string;
  databasePath: string;
  walletRootId?: string;
  startupTimeoutMs?: number;
  expectedBinaryVersion?: string | null;
}): Promise<ManagedIndexerMonitor> {
  const expectedBinaryVersion = options.expectedBinaryVersion === undefined
    ? await readPackageVersionFromDisk()
    : options.expectedBinaryVersion;
  const walletRootId = options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;
  const startOptions = await resolveStartOptions({
    dataDir: options.dataDir,
    walletRootId,
  });

  await attachOrStartManagedBitcoindService({
    dataDir: options.dataDir,
    chain: startOptions.chain,
    startHeight: startOptions.startHeight,
    walletRootId,
    startupTimeoutMs: options.startupTimeoutMs,
  });

  const daemon = await attachOrStartIndexerDaemon({
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    walletRootId,
    startupTimeoutMs: options.startupTimeoutMs,
    ensureBackgroundFollow: true,
    expectedBinaryVersion,
  });

  return createManagedIndexerMonitor({
    daemon,
    dataDir: options.dataDir,
    walletRootId,
  });
}

function createManagedIndexerMonitor(options: {
  daemon: IndexerDaemonClient;
  dataDir: string;
  walletRootId: string;
}): ManagedIndexerMonitor {
  let closed = false;

  return {
    async getStatus() {
      if (closed) {
        throw new Error("managed_indexer_monitor_closed");
      }

      try {
        return await options.daemon.getStatus();
      } catch (error) {
        const observed = await readObservedIndexerDaemonStatus({
          dataDir: options.dataDir,
          walletRootId: options.walletRootId,
        }).catch(() => null);

        if (observed !== null) {
          return observed;
        }

        throw error;
      }
    },
    async close() {
      if (closed) {
        return;
      }

      closed = true;
      await options.daemon.close().catch(() => undefined);
    },
  };
}
