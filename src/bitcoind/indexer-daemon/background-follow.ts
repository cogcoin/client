import type { GenesisParameters } from "@cogcoin/indexer/types";

import { openManagedBitcoindClientInternal } from "../client.js";
import { DEFAULT_SNAPSHOT_METADATA } from "../bootstrap.js";
import { openSqliteStore } from "../../sqlite/index.js";
import { normalizeCogcoinProcessingStartHeight } from "../processing-start-height.js";
import { createBootstrapProgress } from "../progress/formatting.js";
import { resolveManagedServicePaths } from "../service-paths.js";
import type { ManagedIndexerDaemonStatus } from "../types.js";
import type { IndexerDaemonRuntimeState } from "./types.js";
import { readManagedBitcoindStatus } from "./status.js";

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorCode: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(errorCode)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

export async function recordBackgroundFollowFailure(options: {
  state: IndexerDaemonRuntimeState;
  message: string;
  writeStatus(): Promise<ManagedIndexerDaemonStatus>;
}): Promise<void> {
  const now = Date.now();
  options.state.heartbeatAtUnixMs = now;
  options.state.updatedAtUnixMs = now;
  options.state.state = "failed";
  options.state.lastError = options.message;
  options.state.backgroundFollowError = options.message;
  options.state.backgroundFollowActive = false;
  options.state.bootstrapPhase = "error";
  options.state.bootstrapProgress = {
    ...createBootstrapProgress("error", DEFAULT_SNAPSHOT_METADATA),
    blocks: options.state.coreBestHeight,
    headers: options.state.coreBestHeight,
    targetHeight: options.state.coreBestHeight,
    message: options.message,
    lastError: options.message,
    updatedAt: now,
  };
  options.state.cogcoinSyncHeight = options.state.appliedTipHeight;
  options.state.cogcoinSyncTargetHeight = options.state.coreBestHeight;
  await options.writeStatus();
}

export async function pauseBackgroundFollow(options: {
  state: IndexerDaemonRuntimeState;
}): Promise<void> {
  const pendingResume = options.state.backgroundResumePromise;
  options.state.backgroundResumePromise = null;
  await pendingResume?.catch(() => undefined);

  const client = options.state.backgroundClient;
  const store = options.state.backgroundStore;
  options.state.backgroundClient = null;
  options.state.backgroundStore = null;

  await client?.close().catch(() => undefined);
  await store?.close().catch(() => undefined);
  options.state.backgroundFollowError = null;
  options.state.backgroundFollowActive = false;
  options.state.bootstrapPhase = "paused";
  options.state.bootstrapProgress = createBootstrapProgress("paused", DEFAULT_SNAPSHOT_METADATA);
  options.state.cogcoinSyncHeight = options.state.appliedTipHeight;
  options.state.cogcoinSyncTargetHeight = options.state.coreBestHeight;
}

export async function resumeBackgroundFollow(options: {
  dataDir: string;
  databasePath: string;
  walletRootId: string;
  paths: ReturnType<typeof resolveManagedServicePaths>;
  state: IndexerDaemonRuntimeState;
  genesisParameters: GenesisParameters;
  forceResumeErrorEnv: string;
  writeStatus(): Promise<ManagedIndexerDaemonStatus>;
}): Promise<void> {
  if (options.state.backgroundClient !== null) {
    return;
  }

  if (options.state.backgroundResumePromise !== null) {
    return options.state.backgroundResumePromise;
  }

  options.state.backgroundResumePromise = (async () => {
    let store: Awaited<ReturnType<typeof openSqliteStore>> | null = null;
    try {
      const forcedResumeError = process.env[options.forceResumeErrorEnv]?.trim();
      if (forcedResumeError) {
        throw new Error(forcedResumeError);
      }

      const bitcoindStatus = await readManagedBitcoindStatus(options.paths);
      store = await openSqliteStore({ filename: options.databasePath });
      const openedStore = store;
      const chain = bitcoindStatus?.chain ?? "main";
      const startHeight = normalizeCogcoinProcessingStartHeight({
        chain,
        startHeight: bitcoindStatus?.startHeight,
        genesisParameters: options.genesisParameters,
      });

      const client = await openManagedBitcoindClientInternal({
        store: openedStore,
        dataDir: options.dataDir,
        chain,
        startHeight,
        walletRootId: options.walletRootId,
        progressOutput: "none",
      });

      options.state.backgroundStore = openedStore;
      options.state.backgroundClient = client;
      options.state.backgroundFollowError = null;
      options.state.backgroundFollowActive = true;

      void client.startFollowingTip().catch(async (error) => {
        if (options.state.backgroundClient !== client || options.state.backgroundStore !== openedStore) {
          return;
        }

        options.state.backgroundClient = null;
        options.state.backgroundStore = null;
        options.state.backgroundFollowActive = false;
        await client.close().catch(() => undefined);
        await openedStore.close().catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        await recordBackgroundFollowFailure({
          state: options.state,
          message,
          writeStatus: options.writeStatus,
        }).catch(() => undefined);
      });
    } catch (error) {
      await store?.close().catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      await recordBackgroundFollowFailure({
        state: options.state,
        message,
        writeStatus: options.writeStatus,
      }).catch(() => undefined);
      throw error;
    }
  })();

  try {
    await options.state.backgroundResumePromise;
  } finally {
    options.state.backgroundResumePromise = null;
  }
}
