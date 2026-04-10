import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
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

class WindowsDpapiWalletSecretProvider implements WalletSecretProvider {
  readonly kind = "windows-dpapi";
  readonly #directoryPath: string;

  constructor(directoryPath: string) {
    this.#directoryPath = directoryPath;
  }

  #resolveSecretPath(keyId: string): string {
    const fileId = keyId.replace(/[^a-zA-Z0-9._-]+/g, "-");
    return join(this.#directoryPath, `${fileId}.dpapi`);
  }

  async loadSecret(keyId: string): Promise<Uint8Array> {
    const secretPath = this.#resolveSecretPath(keyId);
    const encoded = await readFile(secretPath, "utf8");
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$data=[Convert]::FromBase64String($args[0]);$value=[System.Security.Cryptography.ProtectedData]::Unprotect($data,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($value));",
      encoded.trim(),
    ]);
    return base64ToBytes(stdout.trim());
  }

  async storeSecret(keyId: string, secret: Uint8Array): Promise<void> {
    const secretPath = this.#resolveSecretPath(keyId);
    await mkdir(dirname(secretPath), { recursive: true });
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$data=[Convert]::FromBase64String($args[0]);$value=[System.Security.Cryptography.ProtectedData]::Protect($data,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($value));",
      bytesToBase64(secret),
    ]);
    await writeFileAtomic(secretPath, `${stdout.trim()}\n`, { mode: 0o600 });
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
    return new WindowsDpapiWalletSecretProvider(
      join(resolveWalletRuntimePathsForTesting().stateRoot, "secrets"),
    );
  }

  if (platform === "linux") {
    return new LinuxSecretToolWalletSecretProvider(options.linuxSecretToolRunner);
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
