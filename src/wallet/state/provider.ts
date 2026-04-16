import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { access, constants, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { resolveWalletRuntimePathsForTesting } from "../runtime.js";
import { writeFileAtomic } from "../fs/atomic.js";

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE_NAME = "org.cogcoin.wallet";
const LINUX_SECRET_TOOL_ATTRIBUTE_APPLICATION = "application";
const LINUX_SECRET_TOOL_ATTRIBUTE_KIND = "secret-kind";
const LINUX_SECRET_TOOL_ATTRIBUTE_KEY_ID = "key-id";
const LINUX_SECRET_TOOL_SECRET_KIND = "wallet-secret";

export interface LinuxSecretToolResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface LinuxSecretToolInvocationOptions {
  stdin?: string;
}

export type LinuxSecretToolRunner = (
  args: readonly string[],
  options?: LinuxSecretToolInvocationOptions,
) => Promise<LinuxSecretToolResult>;

export interface DefaultWalletSecretProviderFactoryOptions {
  platform?: NodeJS.Platform;
  linuxSecretToolRunner?: LinuxSecretToolRunner;
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

function createLinuxSecretToolAttributes(keyId: string): string[] {
  return [
    LINUX_SECRET_TOOL_ATTRIBUTE_APPLICATION,
    KEYCHAIN_SERVICE_NAME,
    LINUX_SECRET_TOOL_ATTRIBUTE_KIND,
    LINUX_SECRET_TOOL_SECRET_KIND,
    LINUX_SECRET_TOOL_ATTRIBUTE_KEY_ID,
    keyId,
  ];
}

function createLinuxSecretToolError(message: string, cause?: unknown): Error {
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

function createWalletSecretProviderError(message: string, cause?: unknown): Error {
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

function isWalletSecretProviderMessage(error: unknown, message: string): boolean {
  return error instanceof Error && error.message === message;
}

function sanitizeSecretKeyId(keyId: string): string {
  return keyId.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function resolveSecretDirectoryPath(options: DefaultWalletSecretProviderFactoryOptions): string {
  return join(options.stateRoot ?? resolveWalletRuntimePathsForTesting().stateRoot, "secrets");
}

function isLinuxSecretServiceUnavailableMessage(stderr: string): boolean {
  const normalized = stderr.trim().toLowerCase();

  if (normalized.length === 0) {
    return false;
  }

  return normalized.includes("secret service")
    || normalized.includes("org.freedesktop.secrets")
    || normalized.includes("dbus")
    || normalized.includes("d-bus")
    || normalized.includes("cannot autolaunch")
    || normalized.includes("no such secret collection")
    || normalized.includes("collection is locked")
    || normalized.includes("prompt dismissed")
    || normalized.includes("not available");
}

function isLinuxSecretToolMissingSecretMessage(stderr: string): boolean {
  const normalized = stderr.trim().toLowerCase();

  if (normalized.length === 0) {
    return true;
  }

  return normalized.includes("no matching")
    || normalized.includes("not found")
    || normalized.includes("does not exist")
    || normalized.includes("no such item")
    || normalized.includes("no secret");
}

async function runLinuxSecretTool(
  args: readonly string[],
  options: LinuxSecretToolInvocationOptions = {},
): Promise<LinuxSecretToolResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn("secret-tool", [...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.once("error", reject);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("close", (exitCode, signal) => {
      resolve({
        stdout,
        stderr,
        exitCode,
        signal,
      });
    });

    child.stdin.on("error", (error) => {
      if ("code" in error && (error as NodeJS.ErrnoException).code === "EPIPE") {
        return;
      }
      reject(error);
    });

    child.stdin.end(options.stdin ?? undefined, "utf8");
  });
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

class LinuxSecretToolWalletSecretProvider implements WalletSecretProvider {
  readonly kind = "linux-secret-service";
  readonly #runner: LinuxSecretToolRunner;

  constructor(runner: LinuxSecretToolRunner = runLinuxSecretTool) {
    this.#runner = runner;
  }

  async #invoke(options: {
    args: readonly string[];
    keyId: string;
    operation: "load" | "store" | "delete";
    stdin?: string;
    ignoreMissing?: boolean;
  }): Promise<LinuxSecretToolResult> {
    try {
      const result = await this.#runner(options.args, {
        stdin: options.stdin,
      });

      if (result.exitCode === 0) {
        return result;
      }

      if (isLinuxSecretServiceUnavailableMessage(result.stderr)) {
        throw createLinuxSecretToolError("wallet_secret_provider_linux_secret_service_unavailable");
      }

      if (
        (options.operation === "load" || options.ignoreMissing)
        && isLinuxSecretToolMissingSecretMessage(result.stderr)
      ) {
        throw createLinuxSecretToolError(`wallet_secret_missing_${options.keyId}`);
      }

      throw createLinuxSecretToolError("wallet_secret_provider_linux_runtime_error");
    } catch (error) {
      if (
        error instanceof Error
        && (
          error.message === "wallet_secret_provider_linux_secret_tool_missing"
          || error.message === "wallet_secret_provider_linux_secret_service_unavailable"
          || error.message === "wallet_secret_provider_linux_runtime_error"
          || error.message === `wallet_secret_missing_${options.keyId}`
        )
      ) {
        throw error;
      }

      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        throw createLinuxSecretToolError("wallet_secret_provider_linux_secret_tool_missing", error);
      }

      throw createLinuxSecretToolError("wallet_secret_provider_linux_runtime_error", error);
    }
  }

  async loadSecret(keyId: string): Promise<Uint8Array> {
    const result = await this.#invoke({
      args: ["lookup", ...createLinuxSecretToolAttributes(keyId)],
      keyId,
      operation: "load",
    });
    return base64ToBytes(result.stdout.trim());
  }

  async storeSecret(keyId: string, secret: Uint8Array): Promise<void> {
    await this.#invoke({
      args: [
        "store",
        "--label",
        `Cogcoin wallet secret (${keyId})`,
        ...createLinuxSecretToolAttributes(keyId),
      ],
      keyId,
      operation: "store",
      stdin: bytesToBase64(secret),
    });
  }

  async deleteSecret(keyId: string): Promise<void> {
    try {
      await this.#invoke({
        args: ["clear", ...createLinuxSecretToolAttributes(keyId)],
        keyId,
        operation: "delete",
        ignoreMissing: true,
      });
    } catch (error) {
      if (error instanceof Error && error.message === `wallet_secret_missing_${keyId}`) {
        return;
      }
      throw error;
    }
  }
}

class LocalFileWalletSecretProvider implements WalletSecretProvider {
  readonly kind: string;
  readonly #directoryPath: string;
  readonly #runtimeErrorCode: string;
  readonly #legacyUnsupportedErrorCode: string | null;
  readonly #legacyFileExtension: string | null;

  constructor(options: {
    directoryPath: string;
    kind: string;
    legacyFileExtension?: string;
    legacyUnsupportedErrorCode?: string;
    runtimeErrorCode: string;
  }) {
    this.kind = options.kind;
    this.#directoryPath = options.directoryPath;
    this.#runtimeErrorCode = options.runtimeErrorCode;
    this.#legacyUnsupportedErrorCode = options.legacyUnsupportedErrorCode ?? null;
    this.#legacyFileExtension = options.legacyFileExtension ?? null;
  }

  #resolveSecretPath(keyId: string): string {
    return join(this.#directoryPath, `${sanitizeSecretKeyId(keyId)}.secret`);
  }

  #resolveLegacySecretPath(keyId: string): string | null {
    return this.#legacyFileExtension === null
      ? null
      : join(this.#directoryPath, `${sanitizeSecretKeyId(keyId)}${this.#legacyFileExtension}`);
  }

  async #throwMissingSecretError(keyId: string): Promise<never> {
    const legacyPath = this.#resolveLegacySecretPath(keyId);

    if (legacyPath !== null && this.#legacyUnsupportedErrorCode !== null) {
      try {
        await access(legacyPath, constants.F_OK);
        throw new Error(this.#legacyUnsupportedErrorCode);
      } catch (error) {
        if (error instanceof Error && error.message === this.#legacyUnsupportedErrorCode) {
          throw error;
        }

        if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`wallet_secret_missing_${keyId}`);
        }

        throw createWalletSecretProviderError(this.#runtimeErrorCode, error);
      }
    }

    throw new Error(`wallet_secret_missing_${keyId}`);
  }

  async hasSecret(keyId: string): Promise<boolean> {
    try {
      await access(this.#resolveSecretPath(keyId), constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async loadSecret(keyId: string): Promise<Uint8Array> {
    try {
      const encoded = await readFile(this.#resolveSecretPath(keyId), "utf8");
      return base64ToBytes(encoded.trim());
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.#throwMissingSecretError(keyId);
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
    const secretPaths = [this.#resolveSecretPath(keyId)];
    const legacyPath = this.#resolveLegacySecretPath(keyId);

    if (legacyPath !== null) {
      secretPaths.push(legacyPath);
    }

    await Promise.allSettled(secretPaths.map(async (secretPath) => {
      await rm(secretPath, { force: true }).catch(() => undefined);
    }));
  }
}

class LinuxFallbackWalletSecretProvider implements WalletSecretProvider {
  readonly kind = "linux-secret-service-fallback";
  readonly #secretService: LinuxSecretToolWalletSecretProvider;
  readonly #fileProvider: LocalFileWalletSecretProvider;

  constructor(options: {
    secretService: LinuxSecretToolWalletSecretProvider;
    fileProvider: LocalFileWalletSecretProvider;
  }) {
    this.#secretService = options.secretService;
    this.#fileProvider = options.fileProvider;
  }

  async #loadFromFileOrRethrow(keyId: string, error: Error): Promise<Uint8Array> {
    try {
      return await this.#fileProvider.loadSecret(keyId);
    } catch (fileError) {
      if (
        isWalletSecretProviderMessage(fileError, `wallet_secret_missing_${keyId}`)
        && (
          error.message === "wallet_secret_provider_linux_secret_tool_missing"
          || error.message === "wallet_secret_provider_linux_secret_service_unavailable"
        )
      ) {
        throw error;
      }

      throw fileError;
    }
  }

  async loadSecret(keyId: string): Promise<Uint8Array> {
    try {
      return await this.#secretService.loadSecret(keyId);
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }

      if (
        error.message === "wallet_secret_provider_linux_secret_tool_missing"
        || error.message === "wallet_secret_provider_linux_secret_service_unavailable"
        || error.message === `wallet_secret_missing_${keyId}`
      ) {
        return await this.#loadFromFileOrRethrow(keyId, error);
      }

      if (
        error.message === "wallet_secret_provider_linux_runtime_error"
        && await this.#fileProvider.hasSecret(keyId)
      ) {
        return await this.#fileProvider.loadSecret(keyId);
      }

      throw error;
    }
  }

  async storeSecret(keyId: string, secret: Uint8Array): Promise<void> {
    try {
      await this.#secretService.storeSecret(keyId, secret);
    } catch (error) {
      if (
        isWalletSecretProviderMessage(error, "wallet_secret_provider_linux_secret_tool_missing")
        || isWalletSecretProviderMessage(error, "wallet_secret_provider_linux_secret_service_unavailable")
      ) {
        await this.#fileProvider.storeSecret(keyId, secret);
        return;
      }

      throw error;
    }
  }

  async deleteSecret(keyId: string): Promise<void> {
    await Promise.allSettled([
      this.#secretService.deleteSecret(keyId),
      this.#fileProvider.deleteSecret(keyId),
    ]);
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
      legacyFileExtension: ".dpapi",
      legacyUnsupportedErrorCode: "wallet_secret_provider_windows_legacy_dpapi_unsupported",
      runtimeErrorCode: "wallet_secret_provider_windows_runtime_error",
    });
  }

  if (platform === "linux") {
    return new LinuxFallbackWalletSecretProvider({
      secretService: new LinuxSecretToolWalletSecretProvider(options.linuxSecretToolRunner),
      fileProvider: new LocalFileWalletSecretProvider({
        directoryPath: resolveSecretDirectoryPath(options),
        kind: "linux-local-file",
        runtimeErrorCode: "wallet_secret_provider_linux_runtime_error",
      }),
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
