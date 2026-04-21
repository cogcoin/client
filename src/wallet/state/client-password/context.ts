import { join } from "node:path";

import type {
  ClientPasswordResolvedContext,
  ClientPasswordStorageOptions,
} from "./types.js";

function sanitizeSecretKeyId(keyId: string): string {
  return keyId.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export function resolveLocalSecretFilePath(directoryPath: string, keyId: string): string {
  return join(directoryPath, `${sanitizeSecretKeyId(keyId)}.secret`);
}

export function resolveClientPasswordStatePath(directoryPath: string): string {
  return join(directoryPath, "client-password.json");
}

export function resolveClientPasswordRotationJournalPath(directoryPath: string): string {
  return join(directoryPath, "client-password-rotation.json");
}

export function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function createRuntimeError(code: string, cause?: unknown): Error {
  return cause === undefined ? new Error(code) : new Error(code, { cause });
}

export function resolveClientPasswordContext(
  options: ClientPasswordStorageOptions,
): ClientPasswordResolvedContext {
  return {
    ...options,
    legacyMacKeychainReader: options.legacyMacKeychainReader ?? null,
    passwordStatePath: resolveClientPasswordStatePath(options.directoryPath),
    rotationJournalPath: resolveClientPasswordRotationJournalPath(options.directoryPath),
  };
}

export function createLegacyKeychainServiceName(): string {
  return "org.cogcoin.wallet";
}
