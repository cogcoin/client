import { loadBundledGenesisParameters } from "@cogcoin/indexer";

import {
  attachOrStartIndexerDaemon,
  INDEXER_DAEMON_BACKGROUND_FOLLOW_RECOVERY_FAILED,
  probeIndexerDaemon,
  readObservedIndexerDaemonStatus,
  readSnapshotWithRetry,
  type IndexerDaemonClient,
} from "../../bitcoind/indexer-daemon.js";
import type { ManagedWalletReadServiceBundle } from "../../bitcoind/managed-runtime/types.js";
import { createRpcClient } from "../../bitcoind/node.js";
import {
  attachOrStartManagedBitcoindService,
  probeManagedBitcoindService,
} from "../../bitcoind/service.js";
import type { ManagedBitcoindNodeHandle } from "../../bitcoind/types.js";
import { verifyManagedCoreWalletReplica } from "../lifecycle.js";
import type { WalletLocalStateStatus } from "./types.js";
import {
  deriveNodeHealthForTesting,
  openManagedWalletBitcoindReadState,
  type ManagedWalletBitcoindReadDeps,
} from "./managed-bitcoind.js";
import {
  openManagedWalletIndexerReadState,
  type ManagedWalletIndexerReadDeps,
} from "./managed-indexer.js";

type ManagedWalletReadServiceDeps = ManagedWalletBitcoindReadDeps & ManagedWalletIndexerReadDeps;

const defaultManagedWalletReadServiceDeps: ManagedWalletReadServiceDeps = {
  loadBundledGenesisParameters,
  probeManagedBitcoindService,
  attachOrStartManagedBitcoindService,
  createRpcClient,
  verifyManagedCoreWalletReplica,
  probeIndexerDaemon,
  attachOrStartIndexerDaemon,
  readSnapshotWithRetry,
  readObservedIndexerDaemonStatus,
};

export async function openManagedWalletReadServiceBundle(
  options: {
    dataDir: string;
    databasePath: string;
    walletRootId: string;
    localState: WalletLocalStateStatus;
    startupTimeoutMs: number;
    expectedIndexerBinaryVersion: string | null;
    now: number;
  },
  dependencies: ManagedWalletReadServiceDeps = defaultManagedWalletReadServiceDeps,
): Promise<ManagedWalletReadServiceBundle<
  ManagedBitcoindNodeHandle,
  ReturnType<typeof createRpcClient>,
  IndexerDaemonClient
>> {
  const bitcoindState = await openManagedWalletBitcoindReadState({
    dataDir: options.dataDir,
    walletRootId: options.walletRootId,
    localState: options.localState,
    startupTimeoutMs: options.startupTimeoutMs,
  }, dependencies);
  const indexerState = await openManagedWalletIndexerReadState({
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    walletRootId: options.walletRootId,
    startupTimeoutMs: options.startupTimeoutMs,
    expectedIndexerBinaryVersion: options.expectedIndexerBinaryVersion,
    now: options.now,
    nodeHandle: bitcoindState.node.handle,
  }, dependencies);

  return {
    node: bitcoindState.node,
    bitcoind: bitcoindState.bitcoind,
    nodeHealth: bitcoindState.nodeHealth,
    nodeMessage: bitcoindState.nodeMessage,
    daemonClient: indexerState.daemonClient,
    indexer: indexerState.indexer,
    snapshot: indexerState.snapshot,
    async close(): Promise<void> {
      await indexerState.daemonClient?.close().catch(() => undefined);
      await bitcoindState.node.handle?.stop().catch(() => undefined);
    },
  };
}

export { deriveNodeHealthForTesting };
