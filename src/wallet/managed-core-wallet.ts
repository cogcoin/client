import { rm } from "node:fs/promises";
import { join } from "node:path";

export const MANAGED_CORE_WALLET_UNLOCK_TIMEOUT_SECONDS = 10;
const LEGACY_UNLOCK_SESSION_FILENAME = "wallet-unlock-session.enc";
const LEGACY_EXPLICIT_LOCK_FILENAME = "wallet-explicit-lock.json";
const MANAGED_CORE_WALLET_PROCESS_PSBT_LOCKED_ERROR_PREFIX = "bitcoind_rpc_walletprocesspsbt_-13_";
const MANAGED_CORE_WALLET_PROCESS_PSBT_LOCKED_ERROR_SUFFIX = "Please enter the wallet passphrase with walletpassphrase first.";

export interface ManagedCoreWalletUnlockingRpc {
  walletPassphrase(walletName: string, passphrase: string, timeoutSeconds: number): Promise<null>;
  walletLock(walletName: string): Promise<null>;
}

function isManagedCoreWalletProcessPsbtLockedError(error: unknown): error is Error {
  return error instanceof Error
    && error.message.startsWith(MANAGED_CORE_WALLET_PROCESS_PSBT_LOCKED_ERROR_PREFIX)
    && error.message.endsWith(MANAGED_CORE_WALLET_PROCESS_PSBT_LOCKED_ERROR_SUFFIX);
}

export async function withUnlockedManagedCoreWallet<T>(options: {
  rpc: ManagedCoreWalletUnlockingRpc;
  walletName: string;
  internalPassphrase: string;
  timeoutSeconds?: number;
  recoverLockedWalletOnce?: boolean;
  onLockedWalletRecoveryOutcome?: (outcome: "recovered" | "still-locked") => void;
  run: () => Promise<T>;
}): Promise<T> {
  await options.rpc.walletPassphrase(
    options.walletName,
    options.internalPassphrase,
    options.timeoutSeconds ?? MANAGED_CORE_WALLET_UNLOCK_TIMEOUT_SECONDS,
  );

  try {
    try {
      return await options.run();
    } catch (error) {
      if (!options.recoverLockedWalletOnce || !isManagedCoreWalletProcessPsbtLockedError(error)) {
        throw error;
      }

      await options.rpc.walletPassphrase(
        options.walletName,
        options.internalPassphrase,
        options.timeoutSeconds ?? MANAGED_CORE_WALLET_UNLOCK_TIMEOUT_SECONDS,
      );

      try {
        const result = await options.run();
        options.onLockedWalletRecoveryOutcome?.("recovered");
        return result;
      } catch (retryError) {
        if (isManagedCoreWalletProcessPsbtLockedError(retryError)) {
          options.onLockedWalletRecoveryOutcome?.("still-locked");
        }

        throw retryError;
      }
    }
  } finally {
    await options.rpc.walletLock(options.walletName).catch(() => undefined);
  }
}

export async function clearLegacyWalletLockArtifacts(walletRuntimeRoot: string): Promise<void> {
  await Promise.all([
    rm(join(walletRuntimeRoot, LEGACY_UNLOCK_SESSION_FILENAME), { force: true }).catch(() => undefined),
    rm(join(walletRuntimeRoot, LEGACY_EXPLICIT_LOCK_FILENAME), { force: true }).catch(() => undefined),
  ]);
}
