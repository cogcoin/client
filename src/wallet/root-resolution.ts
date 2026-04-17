import { UNINITIALIZED_WALLET_ROOT_ID } from "../bitcoind/service-paths.js";
import type { WalletRuntimePaths } from "./runtime.js";
import type { WalletSecretProvider } from "./state/provider.js";
import {
  extractWalletRootIdHintFromWalletStateEnvelope,
  loadRawWalletStateEnvelope,
  type RawWalletStateEnvelope,
} from "./state/storage.js";

export type WalletRootResolutionSource =
  | "wallet-state"
  | "default-uninitialized";

export interface WalletRootResolution {
  walletRootId: string;
  source: WalletRootResolutionSource;
}

export async function resolveWalletRootIdFromLocalArtifacts(options: {
  paths: WalletRuntimePaths;
  provider: WalletSecretProvider;
  loadRawWalletStateEnvelope?: (paths: {
    primaryPath: string;
    backupPath: string;
  }) => Promise<RawWalletStateEnvelope | null>;
}): Promise<WalletRootResolution> {
  const rawEnvelope = await (options.loadRawWalletStateEnvelope ?? loadRawWalletStateEnvelope)({
    primaryPath: options.paths.walletStatePath,
    backupPath: options.paths.walletStateBackupPath,
  }).catch(() => null);
  const walletStateRootId = extractWalletRootIdHintFromWalletStateEnvelope(rawEnvelope?.envelope ?? null);

  if (walletStateRootId !== null) {
    return {
      walletRootId: walletStateRootId,
      source: "wallet-state",
    };
  }

  return {
    walletRootId: UNINITIALIZED_WALLET_ROOT_ID,
    source: "default-uninitialized",
  };
}
