import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import type { EncryptedEnvelopeV1 } from "../types.js";
import type { WalletSecretProvider, WalletSecretReference } from "./provider.js";

const GCM_NONCE_BYTES = 12;
const BIGINT_JSON_TAG = "$cogcoinBigInt";

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return {
      [BIGINT_JSON_TAG]: value.toString(),
    };
  }

  return value;
}

function jsonReviver(_key: string, value: unknown): unknown {
  if (
    value !== null
    && typeof value === "object"
    && BIGINT_JSON_TAG in value
    && typeof (value as Record<string, unknown>)[BIGINT_JSON_TAG] === "string"
  ) {
    return BigInt((value as Record<string, string>)[BIGINT_JSON_TAG]);
  }

  return value;
}

export function encryptBytesWithKey(
  plaintext: Uint8Array,
  key: Uint8Array,
  metadata: {
    format: string;
    wrappedBy: string;
    walletRootIdHint?: string | null;
    secretProvider?: WalletSecretReference | null;
  },
): EncryptedEnvelopeV1 {
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    format: metadata.format,
    version: 1,
    cipher: "aes-256-gcm",
    wrappedBy: metadata.wrappedBy,
    walletRootIdHint: metadata.walletRootIdHint ?? null,
    secretProvider: metadata.secretProvider ?? null,
    nonce: nonce.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptBytesWithKey(
  envelope: EncryptedEnvelopeV1,
  key: Uint8Array,
): Buffer {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key),
    Buffer.from(envelope.nonce, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
}

export async function encryptJsonWithSecretProvider<T>(
  value: T,
  provider: WalletSecretProvider,
  secretReference: WalletSecretReference,
  metadata: {
    format: string;
    wrappedBy?: string;
    walletRootIdHint?: string | null;
  },
): Promise<EncryptedEnvelopeV1> {
  const key = await provider.loadSecret(secretReference.keyId);

  return encryptBytesWithKey(
    Buffer.from(JSON.stringify(value, jsonReplacer)),
    key,
    {
      format: metadata.format,
      wrappedBy: metadata.wrappedBy ?? "secret-provider",
      walletRootIdHint: metadata.walletRootIdHint ?? null,
      secretProvider: secretReference,
    },
  );
}

export async function decryptJsonWithSecretProvider<T>(
  envelope: EncryptedEnvelopeV1,
  provider: WalletSecretProvider,
): Promise<T> {
  if (envelope.secretProvider == null) {
    throw new Error("wallet_envelope_missing_secret_provider");
  }

  const key = await provider.loadSecret(envelope.secretProvider.keyId);
  const plaintext = decryptBytesWithKey(envelope, key);
  return JSON.parse(plaintext.toString("utf8"), jsonReviver) as T;
}
