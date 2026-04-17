import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { resolveWalletRuntimePathsForTesting } from "../runtime.js";
import { writeFileAtomic } from "../fs/atomic.js";

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE_NAME = "org.cogcoin.wallet";

export interface DefaultWalletSecretProviderFactoryOptions {
  platform?: NodeJS.Platform;
  stateRoot?: string;
}

export interface WalletSecretReference {
  kind: string;
  keyId: string;
}

export interface WalletSecretProvider {
  readonly kind: string;
  loadSecret(keyId: string): Promise<Uint8Array>;
  storeSecret(keyId: string, secret: Uint8Array): Promise<void>;
  deleteSecret(keyId: string): Promise<void>;
}

export function createWalletSecretReference(
  walletRootId: string,
): WalletSecretReference {
  return {
    kind: "wallet-state-key",
    keyId: `wallet-state:${walletRootId}`,
  };
}

export function createWalletPendingInitSecretReference(
  stateRoot: string,
): WalletSecretReference {
  return {
    kind: "wallet-init-pending-key",
    keyId: `wallet-init-pending:${createHash("sha256").update(stateRoot).digest("hex")}`,
  };
}

function bytesToBase64(secret: Uint8Array): string {
  return Buffer.from(secret).toString("base64");
}

function base64ToBytes(secret: string): Uint8Array {
  return new Uint8Array(Buffer.from(secret, "base64"));
}

function createWalletSecretProviderError(message: string, cause?: unknown): Error {
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

function sanitizeSecretKeyId(keyId: string): string {
  return keyId.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function resolveSecretDirectoryPath(options: DefaultWalletSecretProviderFactoryOptions): string {
  return join(options.stateRoot ?? resolveWalletRuntimePathsForTesting().stateRoot, "secrets");
}

export class MemoryWalletSecretProvider implements WalletSecretProvider {
  readonly kind = "memory-test";
  readonly #values = new Map<string, Uint8Array>();

  async loadSecret(keyId: string): Promise<Uint8Array> {
    const secret = this.#values.get(keyId);

    if (secret === undefined) {
      throw new Error(`wallet_secret_missing_${keyId}`);
    }

    return new Uint8Array(secret);
  }

  async storeSecret(keyId: string, secret: Uint8Array): Promise<void> {
    this.#values.set(keyId, new Uint8Array(secret));
  }

  async deleteSecret(keyId: string): Promise<void> {
    this.#values.delete(keyId);
  }
}

class MacOsKeychainWalletSecretProvider implements WalletSecretProvider {
  readonly kind = "macos-keychain";

  async loadSecret(keyId: string): Promise<Uint8Array> {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-a",
        keyId,
        "-s",
        KEYCHAIN_SERVICE_NAME,
        "-w",
      ]);
      return base64ToBytes(stdout.trim());
    } catch (error) {
      throw new Error(`wallet_secret_missing_${keyId}`, { cause: error });
    }
  }

  async storeSecret(keyId: string, secret: Uint8Array): Promise<void> {
    await execFileAsync("security", [
      "add-generic-password",
      "-a",
      keyId,
      "-s",
      KEYCHAIN_SERVICE_NAME,
      "-w",
      bytesToBase64(secret),
      "-U",
    ]);
  }

  async deleteSecret(keyId: string): Promise<void> {
    await execFileAsync("security", [
      "delete-generic-password",
      "-a",
      keyId,
      "-s",
      KEYCHAIN_SERVICE_NAME,
    ]).catch(() => undefined);
  }
}

class LocalFileWalletSecretProvider implements WalletSecretProvider {
  readonly kind: string;
  readonly #directoryPath: string;
  readonly #runtimeErrorCode: string;

  constructor(options: {
    directoryPath: string;
    kind: string;
    runtimeErrorCode: string;
  }) {
    this.kind = options.kind;
    this.#directoryPath = options.directoryPath;
    this.#runtimeErrorCode = options.runtimeErrorCode;
  }

  #resolveSecretPath(keyId: string): string {
    return join(this.#directoryPath, `${sanitizeSecretKeyId(keyId)}.secret`);
  }

  async loadSecret(keyId: string): Promise<Uint8Array> {
    try {
      const encoded = await readFile(this.#resolveSecretPath(keyId), "utf8");
      return base64ToBytes(encoded.trim());
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`wallet_secret_missing_${keyId}`);
      }

      throw createWalletSecretProviderError(this.#runtimeErrorCode, error);
    }
  }

  async storeSecret(keyId: string, secret: Uint8Array): Promise<void> {
    try {
      await mkdir(this.#directoryPath, { recursive: true, mode: 0o700 });
      await writeFileAtomic(this.#resolveSecretPath(keyId), `${bytesToBase64(secret)}\n`, { mode: 0o600 });
    } catch (error) {
      throw createWalletSecretProviderError(this.#runtimeErrorCode, error);
    }
  }

  async deleteSecret(keyId: string): Promise<void> {
    await rm(this.#resolveSecretPath(keyId), { force: true }).catch(() => undefined);
  }
}

function createWalletSecretProviderForPlatform(
  platform: NodeJS.Platform,
  options: DefaultWalletSecretProviderFactoryOptions = {},
): WalletSecretProvider {
  if (platform === "darwin") {
    return new MacOsKeychainWalletSecretProvider();
  }

  if (platform === "win32") {
    return new LocalFileWalletSecretProvider({
      directoryPath: resolveSecretDirectoryPath(options),
      kind: "windows-local-file",
      runtimeErrorCode: "wallet_secret_provider_windows_runtime_error",
    });
  }

  if (platform === "linux") {
    return new LocalFileWalletSecretProvider({
      directoryPath: resolveSecretDirectoryPath(options),
      kind: "linux-local-file",
      runtimeErrorCode: "wallet_secret_provider_linux_runtime_error",
    });
  }

  throw new Error(`wallet_secret_provider_unsupported_${platform}`);
}

export function createDefaultWalletSecretProvider(): WalletSecretProvider {
  return createWalletSecretProviderForPlatform(process.platform);
}

export function createDefaultWalletSecretProviderForTesting(
  options: DefaultWalletSecretProviderFactoryOptions = {},
): WalletSecretProvider {
  return createWalletSecretProviderForPlatform(options.platform ?? process.platform, options);
}

export function createLazyDefaultWalletSecretProvider(): WalletSecretProvider {
  let resolved: WalletSecretProvider | null = null;

  const getResolved = (): WalletSecretProvider => {
    resolved ??= createDefaultWalletSecretProvider();
    return resolved;
  };

  return {
    get kind(): string {
      return resolved?.kind ?? "lazy-default";
    },
    async loadSecret(keyId: string): Promise<Uint8Array> {
      return getResolved().loadSecret(keyId);
    },
    async storeSecret(keyId: string, secret: Uint8Array): Promise<void> {
      await getResolved().storeSecret(keyId, secret);
    },
    async deleteSecret(keyId: string): Promise<void> {
      await getResolved().deleteSecret(keyId);
    },
  };
}

export function createMemoryWalletSecretProviderForTesting(): WalletSecretProvider {
  return new MemoryWalletSecretProvider();
}

export function createWalletRootId(): string {
  return `wallet-${randomUUID().replaceAll("-", "")}`;
}
