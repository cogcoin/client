import { loadBundledGenesisParameters } from "@cogcoin/indexer";

import { resolveDefaultBitcoindDataDirForTesting } from "../../app-paths.js";
import { openClient } from "../../client.js";
import {
  AssumeUtxoBootstrapController,
  DEFAULT_SNAPSHOT_METADATA,
  resolveBootstrapPathsForTesting,
} from "../bootstrap.js";
import {
  attachOrStartIndexerDaemon,
  stopIndexerDaemonService,
  type IndexerDaemonClient,
} from "../indexer-daemon.js";
import { createRpcClient } from "../node.js";
import {
  assertCogcoinProcessingStartHeight,
  resolveCogcoinProcessingStartHeight,
} from "../processing-start-height.js";
import { ManagedProgressController } from "../progress.js";
import {
  attachOrStartManagedBitcoindService,
} from "../service.js";
import type {
  InternalManagedBitcoindOptions,
  ManagedBitcoindClient,
} from "../types.js";
import { DefaultManagedBitcoindClient } from "./managed-client.js";
import type { SyncRecoveryClient } from "./internal-types.js";

const DEFAULT_SYNC_DEBOUNCE_MS = 250;

function isRecoverableIndexerDaemonPauseError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (
    error.message === "indexer_daemon_request_timeout"
    || error.message === "indexer_daemon_connection_closed"
    || error.message === "indexer_daemon_protocol_error"
  ) {
    return true;
  }

  if ("code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET";
  }

  return false;
}

export async function pauseIndexerDaemonForForegroundClientForTesting(options: {
  daemon: IndexerDaemonClient;
  dataDir: string;
  walletRootId: string;
  shutdownTimeoutMs?: number;
  stopDaemon?: typeof stopIndexerDaemonService;
}): Promise<IndexerDaemonClient | null> {
  try {
    await options.daemon.pauseBackgroundFollow();
    return options.daemon;
  } catch (error) {
    await options.daemon.close().catch(() => undefined);

    if (!isRecoverableIndexerDaemonPauseError(error)) {
      throw error;
    }

    await (options.stopDaemon ?? stopIndexerDaemonService)({
      dataDir: options.dataDir,
      walletRootId: options.walletRootId,
      shutdownTimeoutMs: options.shutdownTimeoutMs,
    });
    return null;
  }
}

async function createManagedBitcoindClient(
  options: InternalManagedBitcoindOptions,
): Promise<ManagedBitcoindClient> {
  const genesisParameters = options.genesisParameters ?? await loadBundledGenesisParameters();
  assertCogcoinProcessingStartHeight({
    chain: options.chain,
    startHeight: options.startHeight,
    genesisParameters,
  });
  const dataDir = options.dataDir ?? resolveDefaultBitcoindDataDirForTesting();
  const progress = new ManagedProgressController({
    onProgress: options.onProgress,
    progressOutput: options.progressOutput,
    quoteStatePath: resolveBootstrapPathsForTesting(dataDir, DEFAULT_SNAPSHOT_METADATA).quoteStatePath,
    snapshot: DEFAULT_SNAPSHOT_METADATA,
  });

  let progressStarted = false;

  try {
    await progress.start();
    progressStarted = true;

    const node = await attachOrStartManagedBitcoindService({
      ...options,
      dataDir,
      getblockArchivePath: null,
      getblockArchiveEndHeight: null,
      getblockArchiveSha256: null,
    });
    const walletRootId = options.walletRootId ?? node.walletRootId;

    if (walletRootId === undefined) {
      throw new Error("managed_bitcoind_wallet_root_unavailable");
    }
    const rpc = createRpcClient(node.rpc);
    const bootstrap = new AssumeUtxoBootstrapController({
      rpc,
      dataDir: node.dataDir,
      progress,
      snapshot: DEFAULT_SNAPSHOT_METADATA,
    });
    const client = await openClient({
      store: options.store,
      genesisParameters,
      snapshotInterval: options.snapshotInterval,
    }) as SyncRecoveryClient;
    const indexerDaemon = options.databasePath
      ? await pauseIndexerDaemonForForegroundClientForTesting({
        daemon: await attachOrStartIndexerDaemon({
          dataDir,
          databasePath: options.databasePath,
          walletRootId: options.walletRootId,
          startupTimeoutMs: options.startupTimeoutMs,
        }),
        dataDir,
        walletRootId,
        shutdownTimeoutMs: options.shutdownTimeoutMs,
      })
      : null;

    // The persistent service may already exist from a non-processing attach path
    // that used startHeight 0. Cogcoin replay still begins at the requested
    // processing boundary for this managed client.
    const databasePath = options.databasePath ?? null;

    return new DefaultManagedBitcoindClient(
      client,
      options.store,
      node,
      rpc,
      progress,
      bootstrap,
      indexerDaemon,
      databasePath
        ? async () => attachOrStartIndexerDaemon({
          dataDir,
          databasePath,
          walletRootId: options.walletRootId,
          startupTimeoutMs: options.startupTimeoutMs,
        })
        : null,
      options.startHeight,
      options.syncDebounceMs ?? DEFAULT_SYNC_DEBOUNCE_MS,
      dataDir,
      walletRootId,
      options.startupTimeoutMs,
      options.shutdownTimeoutMs,
      options.fetchImpl,
    );
  } catch (error) {
    if (progressStarted) {
      await progress.close().catch(() => undefined);
    }
    throw error;
  }
}

export async function openManagedBitcoindClient(
  options: Omit<InternalManagedBitcoindOptions, "chain" | "startHeight">,
): Promise<ManagedBitcoindClient> {
  const genesisParameters = options.genesisParameters ?? await loadBundledGenesisParameters();

  return createManagedBitcoindClient({
    ...options,
    genesisParameters,
    chain: "main",
    startHeight: resolveCogcoinProcessingStartHeight(genesisParameters),
  });
}

export async function openManagedBitcoindClientInternal(
  options: InternalManagedBitcoindOptions,
): Promise<ManagedBitcoindClient> {
  return createManagedBitcoindClient(options);
}
