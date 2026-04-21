import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import { argon2idAsync } from "@noble/hashes/argon2.js";

import { decryptBytesWithKey, encryptBytesWithKey } from "../crypto.js";
import type {
  ClientPasswordStateV1,
  WrappedSecretEnvelopeV1,
} from "./types.js";
import {
  CLIENT_PASSWORD_STATE_FORMAT,
  CLIENT_PASSWORD_VERIFIER_FORMAT,
  CLIENT_PASSWORD_VERIFIER_TEXT,
  LOCAL_SECRET_ENVELOPE_FORMAT,
} from "./types.js";

const CLIENT_PASSWORD_DERIVED_KEY_BYTES = 32;
const CLIENT_PASSWORD_KDF = {
  memoryKib: 65_536,
  iterations: 3,
  parallelism: 1,
};

export const CLIENT_PASSWORD_DEFAULT_UNLOCK_SECONDS = 3_600;
export const CLIENT_PASSWORD_SETUP_AUTO_UNLOCK_SECONDS = 86_400;

export function zeroizeBuffer(buffer: Uint8Array | null | undefined): void {
  if (buffer != null) {
    buffer.fill(0);
  }
}

export async function derivePasswordKey(
  passwordBytes: Uint8Array,
  saltBytes: Uint8Array,
): Promise<Buffer> {
  return Buffer.from(await argon2idAsync(passwordBytes, saltBytes, {
    m: CLIENT_PASSWORD_KDF.memoryKib,
    t: CLIENT_PASSWORD_KDF.iterations,
    p: CLIENT_PASSWORD_KDF.parallelism,
    dkLen: CLIENT_PASSWORD_DERIVED_KEY_BYTES,
  }));
}

export async function createClientPasswordState(options: {
  passwordBytes: Uint8Array;
  passwordHint: string;
}): Promise<{ state: ClientPasswordStateV1; derivedKey: Buffer }> {
  const salt = randomBytes(16);
  const derivedKey = await derivePasswordKey(options.passwordBytes, salt);
  const verifier = encryptBytesWithKey(
    Buffer.from(CLIENT_PASSWORD_VERIFIER_TEXT, "utf8"),
    derivedKey,
    {
      format: CLIENT_PASSWORD_VERIFIER_FORMAT,
      wrappedBy: "client-password-verifier",
    },
  );

  return {
    state: {
      format: CLIENT_PASSWORD_STATE_FORMAT,
      version: 1,
      passwordHint: options.passwordHint,
      kdf: {
        name: "argon2id",
        memoryKib: CLIENT_PASSWORD_KDF.memoryKib,
        iterations: CLIENT_PASSWORD_KDF.iterations,
        parallelism: CLIENT_PASSWORD_KDF.parallelism,
        salt: salt.toString("base64"),
      },
      verifier: {
        cipher: "aes-256-gcm",
        nonce: verifier.nonce,
        tag: verifier.tag,
        ciphertext: verifier.ciphertext,
      },
    },
    derivedKey,
  };
}

export function createWrappedSecretEnvelope(
  secret: Uint8Array,
  derivedKey: Uint8Array,
): WrappedSecretEnvelopeV1 {
  const envelope = encryptBytesWithKey(secret, derivedKey, {
    format: LOCAL_SECRET_ENVELOPE_FORMAT,
    wrappedBy: "client-password",
  });

  return {
    format: LOCAL_SECRET_ENVELOPE_FORMAT,
    version: 1,
    cipher: "aes-256-gcm",
    wrappedBy: "client-password",
    nonce: envelope.nonce,
    tag: envelope.tag,
    ciphertext: envelope.ciphertext,
  };
}

export async function verifyPassword(options: {
  state: ClientPasswordStateV1;
  passwordBytes: Uint8Array;
}): Promise<Buffer | null> {
  const derivedKey = await derivePasswordKey(
    options.passwordBytes,
    Buffer.from(options.state.kdf.salt, "base64"),
  );

  try {
    const plaintext = decryptBytesWithKey(
      {
        format: CLIENT_PASSWORD_VERIFIER_FORMAT,
        version: 1,
        cipher: "aes-256-gcm",
        wrappedBy: "client-password-verifier",
        nonce: options.state.verifier.nonce,
        tag: options.state.verifier.tag,
        ciphertext: options.state.verifier.ciphertext,
      },
      derivedKey,
    );

    if (plaintext.toString("utf8") !== CLIENT_PASSWORD_VERIFIER_TEXT) {
      zeroizeBuffer(derivedKey);
      return null;
    }

    return derivedKey;
  } catch {
    zeroizeBuffer(derivedKey);
    return null;
  }
}

export function decryptWrappedSecretEnvelope(
  envelope: WrappedSecretEnvelopeV1,
  derivedKey: Uint8Array,
): Uint8Array {
  return decryptBytesWithKey(envelope, derivedKey);
}

export function encryptSessionSecretBase64(options: {
  key: Uint8Array;
  secretBase64: string;
}): { nonce: string; tag: string; ciphertext: string } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", options.key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(options.secretBase64, "base64")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    nonce: nonce.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptSessionSecretBase64(options: {
  key: Uint8Array;
  envelope: {
    nonce: string;
    tag: string;
    ciphertext: string;
  };
}): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    options.key,
    Buffer.from(options.envelope.nonce, "base64"),
  );
  decipher.setAuthTag(Buffer.from(options.envelope.tag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(options.envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("base64");
}
