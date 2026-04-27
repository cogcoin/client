import { readPackageVersionFromDisk } from "../../package-version.js";

export {
  readSnapshotWithRetry,
} from "../../bitcoind/indexer-daemon.js";
import { UNINITIALIZED_WALLET_ROOT_ID } from "../../bitcoind/service-paths.js";
import { inspectMiningControlPlane } from "../mining/index.js";
import { resolveWalletRuntimePathsForTesting } from "../runtime.js";
import {
  createDefaultWalletSecretProvider,
  type WalletSecretProvider,
} from "../state/provider.js";
import { openManagedWalletReadServiceBundle } from "./managed-services.js";
import { inspectWalletLocalState, readFundingBalanceSummary } from "./local-state.js";
import { createWalletReadModel } from "./project.js";
import type {
  WalletReadContext,
} from "./types.js";
import type { WalletRuntimePaths } from "../runtime.js";

const DEFAULT_SERVICE_START_TIMEOUT_MS = 60_000;

export async function openWalletReadContext(options: {
  dataDir: string;
  databasePath: string;
  secretProvider?: WalletSecretProvider;
  walletControlLockHeld?: boolean;
  startupTimeoutMs?: number;
  expectedIndexerBinaryVersion?: string | null;
  now?: number;
  paths?: WalletRuntimePaths;
}): Promise<WalletReadContext> {
  const expectedIndexerBinaryVersion = options.expectedIndexerBinaryVersion === undefined
    ? await readPackageVersionFromDisk()
    : options.expectedIndexerBinaryVersion;
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_SERVICE_START_TIMEOUT_MS;
  const now = options.now ?? Date.now();
  const localState = await inspectWalletLocalState({
    dataDir: options.dataDir,
    secretProvider: options.secretProvider,
    walletControlLockHeld: options.walletControlLockHeld,
    now,
    paths: options.paths,
  });
  const walletRootId = localState.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;
  const managedServices = await openManagedWalletReadServiceBundle({
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    walletRootId,
    localState,
    startupTimeoutMs,
    expectedIndexerBinaryVersion,
    now,
  });
  const {
    fundingDisplaySats,
    fundingSpendableSats,
  } = await readFundingBalanceSummary({
    state: localState.state,
    rpc: managedServices.node.rpc,
  });
  const mining = await inspectMiningControlPlane({
    provider: options.secretProvider,
    localState,
    bitcoind: managedServices.bitcoind,
    nodeStatus: managedServices.node.status,
    nodeHealth: managedServices.nodeHealth,
    indexer: managedServices.indexer,
    nowUnixMs: now,
    paths: options.paths,
  });

  return {
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    localState,
    bitcoind: managedServices.bitcoind,
    nodeStatus: managedServices.node.status,
    nodeHealth: managedServices.nodeHealth,
    nodeMessage: managedServices.nodeMessage,
    indexer: managedServices.indexer,
    snapshot: managedServices.snapshot,
    model: localState.state === null
      ? null
      : createWalletReadModel(localState.state, managedServices.snapshot),
    fundingDisplaySats,
    fundingSpendableSats,
    mining,
    async close(): Promise<void> {
      await managedServices.close();
    },
  };
}

export {
  inspectWalletLocalState,
};
