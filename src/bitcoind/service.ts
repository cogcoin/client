import { readManagedBitcoindObservedStatus } from "./managed-runtime/bitcoind-status.js";
import { UNINITIALIZED_WALLET_ROOT_ID } from "./service-paths.js";
import {
  buildManagedServiceArgsForTesting,
  resolveManagedBitcoindDbcacheMiB,
  writeBitcoinConfForTesting,
} from "./managed-bitcoind-service-config.js";
import {
  attachOrStartManagedBitcoindService,
  probeManagedBitcoindService,
  shutdownManagedBitcoindServiceForTesting,
  stopManagedBitcoindService,
  stopManagedBitcoindServiceWithLockHeld,
  withClaimedUninitializedManagedRuntime,
} from "./managed-bitcoind-service-lifecycle.js";
import { createManagedWalletReplica } from "./managed-bitcoind-service-replica.js";

export type {
  ManagedBitcoindServiceCompatibility,
  ManagedBitcoindServiceProbeResult,
} from "./managed-runtime/types.js";
export type { ManagedBitcoindServiceStopResult } from "./managed-bitcoind-service-types.js";

export {
  attachOrStartManagedBitcoindService,
  createManagedWalletReplica,
  probeManagedBitcoindService,
  resolveManagedBitcoindDbcacheMiB,
  stopManagedBitcoindService,
  stopManagedBitcoindServiceWithLockHeld,
  withClaimedUninitializedManagedRuntime,
  writeBitcoinConfForTesting,
  buildManagedServiceArgsForTesting,
};

export async function readManagedBitcoindServiceStatusForTesting(
  dataDir: string,
  walletRootId = UNINITIALIZED_WALLET_ROOT_ID,
) {
  return readManagedBitcoindObservedStatus({
    dataDir,
    walletRootId,
  });
}

export {
  shutdownManagedBitcoindServiceForTesting,
};
