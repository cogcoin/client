import { readFile, rm } from "node:fs/promises";

import { writeJsonFileAtomic } from "../fs/atomic.js";
import type { EncryptedEnvelopeV1, WalletPendingInitializationStateV1 } from "../types.js";
import {
  decryptJsonWithSecretProvider,
  encryptJsonWithSecretProvider,
} from "./crypto.js";
import type { WalletSecretProvider, WalletSecretReference } from "./provider.js";

export interface WalletPendingInitializationStoragePaths {
  primaryPath: string;
  backupPath: string;
}

export interface LoadedWalletPendingInitializationState {
  source: "primary" | "backup";
  state: WalletPendingInitializationStateV1;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readEnvelope(path: string): Promise<EncryptedEnvelopeV1> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as EncryptedEnvelopeV1;
}

async function loadFromPath(
  path: string,
  source: "primary" | "backup",
  provider: WalletSecretProvider,
): Promise<LoadedWalletPendingInitializationState> {
  return {
    source,
    state: await decryptJsonWithSecretProvider<WalletPendingInitializationStateV1>(
      await readEnvelope(path),
      provider,
    ),
  };
}

export async function saveWalletPendingInitializationState(
  paths: WalletPendingInitializationStoragePaths,
  state: WalletPendingInitializationStateV1,
  access: {
    provider: WalletSecretProvider;
    secretReference: WalletSecretReference;
  },
): Promise<void> {
  const envelope = await encryptJsonWithSecretProvider(
    state,
    access.provider,
    access.secretReference,
    {
      format: "cogcoin-wallet-init-pending-state",
    },
  );

  await writeJsonFileAtomic(paths.primaryPath, envelope, { mode: 0o600 });
  await writeJsonFileAtomic(paths.backupPath, envelope, { mode: 0o600 });
}

export async function loadWalletPendingInitializationState(
  paths: WalletPendingInitializationStoragePaths,
  access: {
    provider: WalletSecretProvider;
  },
): Promise<LoadedWalletPendingInitializationState> {
  try {
    return await loadFromPath(paths.primaryPath, "primary", access.provider);
  } catch (primaryError) {
    try {
      return await loadFromPath(paths.backupPath, "backup", access.provider);
    } catch (backupError) {
      if (isMissingFileError(primaryError)) {
        throw backupError;
      }

      throw primaryError;
    }
  }
}

export async function loadWalletPendingInitializationStateOrNull(
  paths: WalletPendingInitializationStoragePaths,
  access: {
    provider: WalletSecretProvider;
  },
): Promise<LoadedWalletPendingInitializationState | null> {
  try {
    return await loadWalletPendingInitializationState(paths, access);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

export async function clearWalletPendingInitializationState(
  paths: WalletPendingInitializationStoragePaths,
  access?: {
    provider?: WalletSecretProvider;
    secretReference?: WalletSecretReference;
  },
): Promise<void> {
  await rm(paths.primaryPath, { force: true }).catch(() => undefined);
  await rm(paths.backupPath, { force: true }).catch(() => undefined);

  if (access?.provider != null && access.secretReference != null) {
    await access.provider.deleteSecret(access.secretReference.keyId).catch(() => undefined);
  }
}
