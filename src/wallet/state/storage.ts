import { readFile } from "node:fs/promises";

import { writeJsonFileAtomic } from "../fs/atomic.js";
import type { EncryptedEnvelopeV1, WalletStateV1 } from "../types.js";
import {
  decryptJsonWithPassphrase,
  decryptJsonWithSecretProvider,
  encryptJsonWithPassphrase,
  encryptJsonWithSecretProvider,
} from "./crypto.js";
import type { WalletSecretProvider, WalletSecretReference } from "./provider.js";

export interface WalletStateStoragePaths {
  primaryPath: string;
  backupPath: string;
}

export interface LoadedWalletState {
  source: "primary" | "backup";
  state: WalletStateV1;
}

export interface RawWalletStateEnvelope {
  source: "primary" | "backup";
  envelope: EncryptedEnvelopeV1;
}

export type WalletStateSaveAccess =
  | Uint8Array
  | string
  | {
    provider: WalletSecretProvider;
    secretReference: WalletSecretReference;
  };

export type WalletStateLoadAccess =
  | Uint8Array
  | string
  | {
    provider: WalletSecretProvider;
  };

async function readEnvelope(path: string): Promise<EncryptedEnvelopeV1> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as EncryptedEnvelopeV1;
}

export async function loadRawWalletStateEnvelope(
  paths: WalletStateStoragePaths,
): Promise<RawWalletStateEnvelope | null> {
  try {
    return {
      source: "primary",
      envelope: await readEnvelope(paths.primaryPath),
    };
  } catch (primaryError) {
    try {
      return {
        source: "backup",
        envelope: await readEnvelope(paths.backupPath),
      };
    } catch {
      if (
        primaryError instanceof SyntaxError
        || !(primaryError instanceof Error)
        || !("code" in primaryError)
        || (primaryError as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw primaryError;
      }

      return null;
    }
  }
}

export function extractWalletRootIdHintFromWalletStateEnvelope(
  envelope: EncryptedEnvelopeV1 | null,
): string | null {
  const hint = envelope?.walletRootIdHint?.trim() ?? "";

  if (hint.length > 0) {
    return hint;
  }

  const keyId = envelope?.secretProvider?.keyId ?? null;
  const prefix = "wallet-state:";

  if (keyId === null || !keyId.startsWith(prefix)) {
    return null;
  }

  return keyId.slice(prefix.length);
}

export async function saveWalletState(
  paths: WalletStateStoragePaths,
  state: WalletStateV1,
  access: WalletStateSaveAccess,
): Promise<void> {
  let previousPrimary: EncryptedEnvelopeV1 | null = null;

  try {
    previousPrimary = await readEnvelope(paths.primaryPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      previousPrimary = null;
    } else if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
      throw error;
    }
  }

  const envelope = typeof access === "string" || access instanceof Uint8Array
    ? await encryptJsonWithPassphrase(state, access, {
      format: "cogcoin-local-wallet-state",
      walletRootIdHint: state.walletRootId,
    })
    : await encryptJsonWithSecretProvider(
      state,
      access.provider,
      access.secretReference,
      {
        format: "cogcoin-local-wallet-state",
        walletRootIdHint: state.walletRootId,
      },
    );

  await writeJsonFileAtomic(paths.primaryPath, envelope, { mode: 0o600 });

  if (previousPrimary !== null) {
    await writeJsonFileAtomic(paths.backupPath, previousPrimary, { mode: 0o600 });
  }
}

export async function loadWalletState(
  paths: WalletStateStoragePaths,
  access: WalletStateLoadAccess,
): Promise<LoadedWalletState> {
  try {
    return {
      source: "primary",
      state: typeof access === "string" || access instanceof Uint8Array
        ? await decryptJsonWithPassphrase<WalletStateV1>(await readEnvelope(paths.primaryPath), access)
        : await decryptJsonWithSecretProvider<WalletStateV1>(await readEnvelope(paths.primaryPath), access.provider),
    };
  } catch (primaryError) {
    try {
      return {
        source: "backup",
        state: typeof access === "string" || access instanceof Uint8Array
          ? await decryptJsonWithPassphrase<WalletStateV1>(await readEnvelope(paths.backupPath), access)
          : await decryptJsonWithSecretProvider<WalletStateV1>(await readEnvelope(paths.backupPath), access.provider),
      };
    } catch {
      throw primaryError;
    }
  }
}
