import { readFile, rm } from "node:fs/promises";

import { writeJsonFileAtomic } from "../fs/atomic.js";
import type { EncryptedEnvelopeV1, UnlockSessionStateV1 } from "../types.js";
import {
  decryptJsonWithPassphrase,
  decryptJsonWithSecretProvider,
  encryptJsonWithPassphrase,
  encryptJsonWithSecretProvider,
} from "./crypto.js";
import type { WalletSecretProvider, WalletSecretReference } from "./provider.js";

export type UnlockSessionSaveAccess =
  | Uint8Array
  | string
  | {
    provider: WalletSecretProvider;
    secretReference: WalletSecretReference;
  };

export type UnlockSessionLoadAccess =
  | Uint8Array
  | string
  | {
    provider: WalletSecretProvider;
  };

export async function saveUnlockSession(
  sessionPath: string,
  session: UnlockSessionStateV1,
  access: UnlockSessionSaveAccess,
): Promise<void> {
  const envelope = typeof access === "string" || access instanceof Uint8Array
    ? await encryptJsonWithPassphrase(session, access, {
      format: "cogcoin-wallet-unlock-session",
    })
    : await encryptJsonWithSecretProvider(
      session,
      access.provider,
      access.secretReference,
      {
        format: "cogcoin-wallet-unlock-session",
      },
    );

  await writeJsonFileAtomic(sessionPath, envelope, { mode: 0o600 });
}

export async function loadUnlockSession(
  sessionPath: string,
  access: UnlockSessionLoadAccess,
): Promise<UnlockSessionStateV1> {
  const raw = await readFile(sessionPath, "utf8");
  const envelope = JSON.parse(raw) as EncryptedEnvelopeV1;
  return typeof access === "string" || access instanceof Uint8Array
    ? decryptJsonWithPassphrase<UnlockSessionStateV1>(envelope, access)
    : decryptJsonWithSecretProvider<UnlockSessionStateV1>(envelope, access.provider);
}

export async function clearUnlockSession(sessionPath: string): Promise<void> {
  await rm(sessionPath, { force: true });
}
