import { UNINITIALIZED_WALLET_ROOT_ID } from "../bitcoind/service-paths.js";
import type { WalletRuntimePaths } from "./runtime.js";
import { loadWalletExplicitLock } from "./state/explicit-lock.js";
import type { WalletSecretProvider } from "./state/provider.js";
import { loadUnlockSession } from "./state/session.js";
import {
  extractWalletRootIdHintFromWalletStateEnvelope,
  loadRawWalletStateEnvelope,
  type RawWalletStateEnvelope,
} from "./state/storage.js";

export type WalletRootResolutionSource =
  | "wallet-state"
  | "unlock-session"
  | "explicit-lock"
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
  loadUnlockSession?: typeof loadUnlockSession;
  loadWalletExplicitLock?: typeof loadWalletExplicitLock;
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

  const session = await (options.loadUnlockSession ?? loadUnlockSession)(
    options.paths.walletUnlockSessionPath,
    {
      provider: options.provider,
    },
  ).catch(() => null);

  if (session !== null) {
    return {
      walletRootId: session.walletRootId,
      source: "unlock-session",
    };
  }

  const explicitLock = await (options.loadWalletExplicitLock ?? loadWalletExplicitLock)(
    options.paths.walletExplicitLockPath,
  ).catch(() => null);

  if (explicitLock?.walletRootId) {
    return {
      walletRootId: explicitLock.walletRootId,
      source: "explicit-lock",
    };
  }

  return {
    walletRootId: UNINITIALIZED_WALLET_ROOT_ID,
    source: "default-uninitialized",
  };
}
