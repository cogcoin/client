import { argon2id } from "hash-wasm";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import type { Argon2EnvelopeParams, EncryptedEnvelopeV1 } from "../types.js";
import type { WalletSecretProvider, WalletSecretReference } from "./provider.js";

const DEFAULT_ARGON2_MEMORY_KIB = 65_536;
const DEFAULT_ARGON2_ITERATIONS = 3;
const DEFAULT_ARGON2_PARALLELISM = 1;
const DERIVED_KEY_LENGTH = 32;
const GCM_NONCE_BYTES = 12;
const ARGON2_SALT_BYTES = 16;
const BIGINT_JSON_TAG = "$cogcoinBigInt";

export interface DeriveKeyOptions {
  memoryKib?: number;
  iterations?: number;
  parallelism?: number;
  salt?: Uint8Array;
}

export interface DerivedKeyMaterial {
  readonly key: Buffer;
  readonly params: Argon2EnvelopeParams;
}

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

async function deriveArgon2Key(
  message: Uint8Array,
  nonce: Uint8Array,
  memoryKib: number,
  iterations: number,
  parallelism: number,
): Promise<Buffer> {
  const derivedKey = await argon2id({
    password: message,
    salt: nonce,
    memorySize: memoryKib,
    iterations,
    parallelism,
    hashLength: DERIVED_KEY_LENGTH,
    outputType: "binary",
  });

  return Buffer.from(derivedKey);
}

export async function deriveKeyFromPassphrase(
  passphrase: Uint8Array | string,
  options: DeriveKeyOptions = {},
): Promise<DerivedKeyMaterial> {
  const salt = Buffer.from(options.salt ?? randomBytes(ARGON2_SALT_BYTES));
  const passphraseBytes = typeof passphrase === "string"
    ? Buffer.from(passphrase, "utf8")
    : Buffer.from(passphrase);
  const memoryKib = options.memoryKib ?? DEFAULT_ARGON2_MEMORY_KIB;
  const iterations = options.iterations ?? DEFAULT_ARGON2_ITERATIONS;
  const parallelism = options.parallelism ?? DEFAULT_ARGON2_PARALLELISM;
  const key = await deriveArgon2Key(passphraseBytes, salt, memoryKib, iterations, parallelism);

  return {
    key,
    params: {
      name: "argon2id",
      memoryKib,
      iterations,
      parallelism,
      salt: salt.toString("base64"),
    },
  };
}

export async function rederiveKeyFromEnvelope(
  passphrase: Uint8Array | string,
  envelope: EncryptedEnvelopeV1,
): Promise<Buffer> {
  if (envelope.argon2id == null) {
    throw new Error("wallet_envelope_not_passphrase_wrapped");
  }

  const passphraseBytes = typeof passphrase === "string"
    ? Buffer.from(passphrase, "utf8")
    : Buffer.from(passphrase);
  const salt = Buffer.from(envelope.argon2id.salt, "base64");

  return deriveArgon2Key(
    passphraseBytes,
    salt,
    envelope.argon2id.memoryKib,
    envelope.argon2id.iterations,
    envelope.argon2id.parallelism,
  );
}

export function encryptBytesWithKey(
  plaintext: Uint8Array,
  key: Uint8Array,
  metadata: {
    format: string;
    wrappedBy: string;
    argon2id?: Argon2EnvelopeParams | null;
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
    argon2id: metadata.argon2id ?? null,
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

export async function encryptJsonWithPassphrase<T>(
  value: T,
  passphrase: Uint8Array | string,
  metadata: {
    format: string;
    wrappedBy?: string;
  },
): Promise<EncryptedEnvelopeV1> {
  const derived = await deriveKeyFromPassphrase(passphrase);

  return encryptBytesWithKey(
    Buffer.from(JSON.stringify(value, jsonReplacer)),
    derived.key,
    {
      format: metadata.format,
      wrappedBy: metadata.wrappedBy ?? "passphrase",
      argon2id: derived.params,
    },
  );
}

export async function encryptJsonWithSecretProvider<T>(
  value: T,
  provider: WalletSecretProvider,
  secretReference: WalletSecretReference,
  metadata: {
    format: string;
    wrappedBy?: string;
  },
): Promise<EncryptedEnvelopeV1> {
  const key = await provider.loadSecret(secretReference.keyId);

  return encryptBytesWithKey(
    Buffer.from(JSON.stringify(value, jsonReplacer)),
    key,
    {
      format: metadata.format,
      wrappedBy: metadata.wrappedBy ?? "secret-provider",
      secretProvider: secretReference,
    },
  );
}

export async function decryptJsonWithPassphrase<T>(
  envelope: EncryptedEnvelopeV1,
  passphrase: Uint8Array | string,
): Promise<T> {
  const key = await rederiveKeyFromEnvelope(passphrase, envelope);
  const plaintext = decryptBytesWithKey(envelope, key);
  return JSON.parse(plaintext.toString("utf8"), jsonReviver) as T;
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
