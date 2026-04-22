import { randomBytes } from "node:crypto";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";

import type { ManagedCoreWalletReplicaStatus } from "./types.js";
import type { ManagedWalletReplicaRpc } from "./managed-bitcoind-service-types.js";

export function getManagedBitcoindWalletReplicaName(walletRootId: string): string {
  return `cogcoin-${walletRootId}`.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 63);
}

export function createMissingManagedWalletReplicaStatus(
  walletRootId: string,
  message: string,
): ManagedCoreWalletReplicaStatus {
  return {
    walletRootId,
    walletName: getManagedBitcoindWalletReplicaName(walletRootId),
    loaded: false,
    descriptors: false,
    privateKeysEnabled: false,
    created: false,
    proofStatus: "missing",
    descriptorChecksum: null,
    fundingAddress0: null,
    fundingScriptPubKeyHex0: null,
    message,
  };
}

function isMissingWalletError(message: string): boolean {
  return message.includes("bitcoind_rpc_loadwallet_-18_")
    || message.includes("Path does not exist")
    || message.includes("not found");
}

export async function loadManagedWalletReplicaIfPresent(
  rpc: ManagedWalletReplicaRpc,
  walletRootId: string,
  dataDir: string,
): Promise<ManagedCoreWalletReplicaStatus> {
  const walletName = getManagedBitcoindWalletReplicaName(walletRootId);
  const loadedWallets = await rpc.listWallets();
  let loaded = loadedWallets.includes(walletName);

  if (!loaded) {
    try {
      await rpc.loadWallet(walletName, false);
      loaded = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (!isMissingWalletError(message)) {
        return {
          walletRootId,
          walletName,
          loaded: false,
          descriptors: false,
          privateKeysEnabled: false,
          created: false,
          proofStatus: "mismatch",
          descriptorChecksum: null,
          fundingAddress0: null,
          fundingScriptPubKeyHex0: null,
          message,
        };
      }

      const walletDir = join(dataDir, "wallets", walletName);
      const walletDirExists = await access(walletDir, constants.F_OK).then(() => true).catch(() => false);

      return createMissingManagedWalletReplicaStatus(
        walletRootId,
        walletDirExists
          ? "Managed Core wallet replica exists on disk but is not loaded."
          : "Managed Core wallet replica is missing.",
      );
    }
  }

  const info = await rpc.getWalletInfo(walletName);

  if (!info.descriptors || !info.private_keys_enabled) {
    return {
      walletRootId,
      walletName,
      loaded: true,
      descriptors: info.descriptors,
      privateKeysEnabled: info.private_keys_enabled,
      created: false,
      proofStatus: "mismatch",
      descriptorChecksum: null,
      fundingAddress0: null,
      fundingScriptPubKeyHex0: null,
      message: "Managed Core wallet replica is not an encrypted descriptor wallet with private keys enabled.",
    };
  }

  try {
    await rpc.walletLock(walletName);
  } catch {
    // A freshly created encrypted wallet may already be locked.
  }

  return {
    walletRootId,
    walletName,
    loaded: true,
    descriptors: info.descriptors,
    privateKeysEnabled: info.private_keys_enabled,
    created: false,
    proofStatus: "not-proven",
    descriptorChecksum: null,
    fundingAddress0: null,
    fundingScriptPubKeyHex0: null,
    message: null,
  };
}

export async function createManagedWalletReplica(
  rpc: ManagedWalletReplicaRpc,
  walletRootId: string,
  options: {
    managedWalletPassphrase?: string;
  } = {},
): Promise<ManagedCoreWalletReplicaStatus> {
  const walletName = getManagedBitcoindWalletReplicaName(walletRootId);
  const loadedWallets = await rpc.listWallets();
  let created = false;

  if (!loadedWallets.includes(walletName)) {
    try {
      await rpc.loadWallet(walletName, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (!isMissingWalletError(message)) {
        throw error;
      }

      await rpc.createWallet(walletName, {
        blank: true,
        descriptors: true,
        disablePrivateKeys: false,
        loadOnStartup: false,
        passphrase: options.managedWalletPassphrase ?? randomBytes(32).toString("hex"),
      });
      created = true;
    }
  }

  const info = await rpc.getWalletInfo(walletName);

  if (!info.descriptors || !info.private_keys_enabled) {
    throw new Error("managed_bitcoind_wallet_replica_invalid");
  }

  try {
    await rpc.walletLock(walletName);
  } catch {
    // A freshly created encrypted wallet may already be locked.
  }

  return {
    walletRootId,
    walletName,
    loaded: true,
    descriptors: info.descriptors,
    privateKeysEnabled: info.private_keys_enabled,
    created,
    proofStatus: "not-proven",
    descriptorChecksum: null,
    fundingAddress0: null,
    fundingScriptPubKeyHex0: null,
    message: null,
  };
}
