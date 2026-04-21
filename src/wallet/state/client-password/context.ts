import { join } from "node:path";

import type { WalletRuntimePaths } from "../../runtime.js";
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

export function resolveClientPasswordStorageOptionsForWalletPaths(
  paths: Pick<WalletRuntimePaths, "stateRoot" | "runtimeRoot">,
  platform: NodeJS.Platform = process.platform,
): ClientPasswordStorageOptions {
  return {
    platform,
    stateRoot: paths.stateRoot,
    runtimeRoot: paths.runtimeRoot,
    directoryPath: join(paths.stateRoot, "secrets"),
    runtimeErrorCode: platform === "win32"
      ? "wallet_secret_provider_windows_runtime_error"
      : platform === "darwin"
        ? "wallet_secret_provider_macos_runtime_error"
        : "wallet_secret_provider_linux_runtime_error",
    legacyMacKeychainReader: null,
  };
}

export function createLegacyKeychainServiceName(): string {
  return "org.cogcoin.wallet";
}
