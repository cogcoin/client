import { loadBundledGenesisParameters } from "@cogcoin/indexer";

import { resolveDefaultBitcoindDataDirForTesting } from "../../app-paths.js";
import { openClient } from "../../client.js";
import { AssumeUtxoBootstrapController, DEFAULT_SNAPSHOT_METADATA, resolveBootstrapPathsForTesting } from "../bootstrap.js";
import { attachOrStartIndexerDaemon } from "../indexer-daemon.js";
import { createRpcClient } from "../node.js";
import { ManagedProgressController } from "../progress.js";
import { attachOrStartManagedBitcoindService } from "../service.js";
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
  const dataDir = options.dataDir ?? resolveDefaultBitcoindDataDirForTesting();
  const node = await attachOrStartManagedBitcoindService({
    ...options,
    dataDir,
  });
  const rpc = createRpcClient(node.rpc);
  const progress = new ManagedProgressController({
    onProgress: options.onProgress,
    progressOutput: options.progressOutput,
    quoteStatePath: resolveBootstrapPathsForTesting(node.dataDir, DEFAULT_SNAPSHOT_METADATA).quoteStatePath,
    snapshot: DEFAULT_SNAPSHOT_METADATA,
  });
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

  return new DefaultManagedBitcoindClient(
    client,
    options.store,
    node,
    rpc,
    progress,
    bootstrap,
    indexerDaemon,
    options.syncDebounceMs ?? DEFAULT_SYNC_DEBOUNCE_MS,
  );
}

export async function openManagedBitcoindClient(
  options: Omit<InternalManagedBitcoindOptions, "chain" | "startHeight">,
): Promise<ManagedBitcoindClient> {
  const genesisParameters = options.genesisParameters ?? await loadBundledGenesisParameters();

  return createManagedBitcoindClient({
    ...options,
    genesisParameters,
    chain: "main",
    startHeight: genesisParameters.genesisBlock,
  });
}

export async function openManagedBitcoindClientInternal(
  options: InternalManagedBitcoindOptions,
): Promise<ManagedBitcoindClient> {
  return createManagedBitcoindClient(options);
}
