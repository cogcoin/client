import { readdir, readFile } from "node:fs/promises";

import { writeJsonFileAtomic } from "../../fs/atomic.js";
import {
  isMissingFileError,
} from "./context.js";
import type {
  ClientPasswordRotationJournalV1,
  ClientPasswordStateV1,
  LocalSecretFile,
  WrappedSecretEnvelopeV1,
} from "./types.js";
import {
  CLIENT_PASSWORD_ROTATION_JOURNAL_FORMAT,
  CLIENT_PASSWORD_STATE_FORMAT,
  LOCAL_SECRET_ENVELOPE_FORMAT,
} from "./types.js";

function isClientPasswordStateV1(value: unknown): value is ClientPasswordStateV1 {
  return value !== null
    && typeof value === "object"
    && (value as { format?: unknown }).format === CLIENT_PASSWORD_STATE_FORMAT
    && (value as { version?: unknown }).version === 1
    && typeof (value as { passwordHint?: unknown }).passwordHint === "string"
    && (value as { kdf?: { name?: unknown } }).kdf?.name === "argon2id"
    && typeof (value as { verifier?: { nonce?: unknown } }).verifier?.nonce === "string"
    && typeof (value as { verifier?: { tag?: unknown } }).verifier?.tag === "string"
    && typeof (value as { verifier?: { ciphertext?: unknown } }).verifier?.ciphertext === "string";
}

function isWrappedSecretEnvelope(value: unknown): value is WrappedSecretEnvelopeV1 {
  return value !== null
    && typeof value === "object"
    && (value as { format?: unknown }).format === LOCAL_SECRET_ENVELOPE_FORMAT
    && (value as { version?: unknown }).version === 1
    && (value as { cipher?: unknown }).cipher === "aes-256-gcm"
    && (value as { wrappedBy?: unknown }).wrappedBy === "client-password"
    && typeof (value as { nonce?: unknown }).nonce === "string"
    && typeof (value as { tag?: unknown }).tag === "string"
    && typeof (value as { ciphertext?: unknown }).ciphertext === "string";
}

function isClientPasswordRotationJournalV1(value: unknown): value is ClientPasswordRotationJournalV1 {
  return value !== null
    && typeof value === "object"
    && (value as { format?: unknown }).format === CLIENT_PASSWORD_ROTATION_JOURNAL_FORMAT
    && (value as { version?: unknown }).version === 1
    && isClientPasswordStateV1((value as { nextState?: unknown }).nextState)
    && Array.isArray((value as { secrets?: unknown }).secrets)
    && ((value as { secrets: unknown[] }).secrets).every((entry) => (
      entry !== null
      && typeof entry === "object"
      && typeof (entry as { keyId?: unknown }).keyId === "string"
      && (entry as { keyId?: string }).keyId!.trim().length > 0
      && isWrappedSecretEnvelope((entry as { envelope?: unknown }).envelope)
    ));
}

export async function readLocalSecretFile(path: string): Promise<LocalSecretFile> {
  try {
    const raw = await readFile(path, "utf8");
    const trimmed = raw.trim();

    try {
      const parsed = JSON.parse(trimmed) as unknown;

      if (isWrappedSecretEnvelope(parsed)) {
        return {
          state: "wrapped",
          envelope: parsed,
        };
      }
    } catch {
      // Legacy local secrets were raw base64 bytes.
    }

    return {
      state: "raw",
      secret: new Uint8Array(Buffer.from(trimmed, "base64")),
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { state: "missing" };
    }

    throw error;
  }
}

export async function loadClientPasswordStateOrNull(path: string): Promise<ClientPasswordStateV1 | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;

    if (!isClientPasswordStateV1(parsed)) {
      return null;
    }

    return parsed;
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    return null;
  }
}

export async function loadClientPasswordRotationJournalOrNull(
  path: string,
): Promise<ClientPasswordRotationJournalV1 | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;

    if (!isClientPasswordRotationJournalV1(parsed)) {
      return null;
    }

    return parsed;
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    return null;
  }
}

export async function writeClientPasswordState(
  path: string,
  state: ClientPasswordStateV1,
): Promise<void> {
  await writeJsonFileAtomic(path, state, { mode: 0o600 });
}

export async function writeClientPasswordRotationJournal(
  path: string,
  journal: ClientPasswordRotationJournalV1,
): Promise<void> {
  await writeJsonFileAtomic(path, journal, { mode: 0o600 });
}

export async function writeWrappedSecretEnvelope(
  path: string,
  envelope: WrappedSecretEnvelopeV1,
): Promise<void> {
  await writeJsonFileAtomic(path, envelope, { mode: 0o600 });
}

export function listLocalSecretFilesForTesting(options: {
  directoryPath: string;
}): Promise<string[]> {
  return readdir(options.directoryPath).catch(() => []);
}
