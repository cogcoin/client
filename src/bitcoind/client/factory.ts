import { loadBundledGenesisParameters } from "@cogcoin/indexer";

import { resolveDefaultBitcoindDataDirForTesting } from "../../app-paths.js";
import { openClient } from "../../client.js";
import {
  AssumeUtxoBootstrapController,
  DEFAULT_SNAPSHOT_METADATA,
  prepareLatestGetblockArchiveForTesting,
  resolveBootstrapPathsForTesting,
} from "../bootstrap.js";
import { attachOrStartIndexerDaemon } from "../indexer-daemon.js";
import { createRpcClient } from "../node.js";
import {
  assertCogcoinProcessingStartHeight,
  resolveCogcoinProcessingStartHeight,
} from "../processing-start-height.js";
import { ManagedProgressController } from "../progress.js";
import {
  attachOrStartManagedBitcoindService,
  probeManagedBitcoindService,
  stopManagedBitcoindService,
} from "../service.js";
import type {
  InternalManagedBitcoindOptions,
  ManagedBitcoindClient,
} from "../types.js";
import { DefaultManagedBitcoindClient } from "./managed-client.js";

const DEFAULT_SYNC_DEBOUNCE_MS = 250;

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

    let getblockArchive = options.chain === "main"
      ? await prepareLatestGetblockArchiveForTesting({
        dataDir,
        progress,
        fetchImpl: options.fetchImpl,
      })
      : null;

    if (options.chain === "main" && getblockArchive !== null) {
      const existingProbe = await probeManagedBitcoindService({
        ...options,
        dataDir,
      });

      if (existingProbe.compatibility === "compatible" && existingProbe.status !== null) {
        const currentArchiveEndHeight = existingProbe.status.getblockArchiveEndHeight ?? null;
        const currentArchiveSha256 = existingProbe.status.getblockArchiveSha256 ?? null;
        const nextArchiveEndHeight = getblockArchive.manifest.endHeight;
        const nextArchiveSha256 = getblockArchive.manifest.artifactSha256;
        const needsRestart = currentArchiveEndHeight !== nextArchiveEndHeight
          || currentArchiveSha256 !== nextArchiveSha256;

        if (needsRestart) {
          const restartApproved = options.confirmGetblockArchiveRestart === undefined
            ? false
            : await options.confirmGetblockArchiveRestart({
              currentArchiveEndHeight,
              nextArchiveEndHeight,
            });

          if (restartApproved) {
            await stopManagedBitcoindService({
              dataDir,
              walletRootId: options.walletRootId,
              shutdownTimeoutMs: options.shutdownTimeoutMs,
            });
          } else {
            getblockArchive = null;
          }
        }
      }
    }

    const node = await attachOrStartManagedBitcoindService({
      ...options,
      dataDir,
      getblockArchivePath: getblockArchive?.artifactPath ?? null,
      getblockArchiveEndHeight: getblockArchive?.manifest.endHeight ?? null,
      getblockArchiveSha256: getblockArchive?.manifest.artifactSha256 ?? null,
    });
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
    });
    const indexerDaemon = options.databasePath
      ? await attachOrStartIndexerDaemon({
        dataDir,
        databasePath: options.databasePath,
        walletRootId: options.walletRootId,
        startupTimeoutMs: options.startupTimeoutMs,
      })
      : null;

    await indexerDaemon?.pauseBackgroundFollow();

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
