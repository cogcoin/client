import { readFile } from "node:fs/promises";

import { writeJsonFileAtomic } from "./fs/atomic.js";
import { normalizePortableWalletArchivePayload } from "./coin-control.js";
import {
  decryptJsonWithPassphrase,
  encryptJsonWithPassphrase,
} from "./state/crypto.js";
import type {
  EncryptedEnvelopeV1,
  PortableWalletArchivePayloadV1,
} from "./types.js";

export const PORTABLE_WALLET_ARCHIVE_FORMAT = "cogcoin-portable-wallet-archive";

function assertPortableWalletArchivePayload(
  payload: PortableWalletArchivePayloadV1,
): PortableWalletArchivePayloadV1 {
  const normalized = normalizePortableWalletArchivePayload(payload);
  if (
    normalized.schemaVersion !== 4
    || normalized.walletRootId.trim() === ""
    || normalized.mnemonic.phrase.trim() === ""
    || normalized.expected.accountPath.trim() === ""
    || normalized.expected.publicExternalDescriptor.trim() === ""
    || (normalized.expected.walletAddress ?? "").trim() === ""
    || (normalized.expected.walletScriptPubKeyHex ?? "").trim() === ""
  ) {
    throw new Error("wallet_archive_payload_invalid");
  }

  return normalized;
}

export async function writePortableWalletArchive(
  path: string,
  payload: PortableWalletArchivePayloadV1,
  passphrase: Uint8Array | string,
): Promise<void> {
  const envelope = await encryptJsonWithPassphrase(
    assertPortableWalletArchivePayload(payload),
    passphrase,
    {
      format: PORTABLE_WALLET_ARCHIVE_FORMAT,
    },
  );

  await writeJsonFileAtomic(path, envelope, { mode: 0o600 });
}

export async function readPortableWalletArchive(
  path: string,
  passphrase: Uint8Array | string,
): Promise<PortableWalletArchivePayloadV1> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("wallet_import_archive_not_found");
    }
    throw error;
  }
  const envelope = JSON.parse(raw) as EncryptedEnvelopeV1;

  if (envelope.format !== PORTABLE_WALLET_ARCHIVE_FORMAT || envelope.version !== 1) {
    throw new Error("wallet_archive_format_invalid");
  }

  return assertPortableWalletArchivePayload(
    await decryptJsonWithPassphrase<PortableWalletArchivePayloadV1>(envelope, passphrase),
  );
}
