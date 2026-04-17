import { rm } from "node:fs/promises";
import { join } from "node:path";

export const MANAGED_CORE_WALLET_UNLOCK_TIMEOUT_SECONDS = 10;
const LEGACY_UNLOCK_SESSION_FILENAME = "wallet-unlock-session.enc";
const LEGACY_EXPLICIT_LOCK_FILENAME = "wallet-explicit-lock.json";

export interface ManagedCoreWalletUnlockingRpc {
  walletPassphrase(walletName: string, passphrase: string, timeoutSeconds: number): Promise<null>;
  walletLock(walletName: string): Promise<null>;
}

export async function withUnlockedManagedCoreWallet<T>(options: {
  rpc: ManagedCoreWalletUnlockingRpc;
  walletName: string;
  internalPassphrase: string;
  timeoutSeconds?: number;
  run: () => Promise<T>;
}): Promise<T> {
  await options.rpc.walletPassphrase(
    options.walletName,
    options.internalPassphrase,
    options.timeoutSeconds ?? MANAGED_CORE_WALLET_UNLOCK_TIMEOUT_SECONDS,
  );

  try {
    return await options.run();
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
