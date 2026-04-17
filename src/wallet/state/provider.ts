import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { resolveWalletRuntimePathsForTesting } from "../runtime.js";
import {
  createLegacyKeychainServiceName,
  deleteClientProtectedSecret,
  ensureClientPasswordConfigured as ensureClientPasswordConfiguredWithLocalFile,
  inspectClientPasswordReadiness,
  loadClientProtectedSecret,
  lockClientPasswordSession,
  readClientPasswordSessionStatus,
  storeClientProtectedSecret,
  changeClientPassword as changeClientPasswordWithLocalFile,
  type ClientPasswordPrompt,
  type ClientPasswordReadiness,
  type ClientPasswordSessionStatus,
  type ClientPasswordSetupAction,
  unlockClientPasswordSession as unlockClientPasswordSessionWithLocalFile,
} from "./client-password.js";

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE_NAME = createLegacyKeychainServiceName();

export interface DefaultWalletSecretProviderFactoryOptions {
  platform?: NodeJS.Platform;
  stateRoot?: string;
  runtimeRoot?: string;
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
  withPrompter?(prompter: ClientPasswordPrompt): WalletSecretProvider;
  inspectClientPasswordReadiness?(): Promise<ClientPasswordReadiness>;
  ensureClientPasswordConfigured?(prompter: ClientPasswordPrompt): Promise<ClientPasswordSetupAction>;
  changeClientPassword?(prompter: ClientPasswordPrompt): Promise<ClientPasswordSessionStatus>;
  unlockClientPasswordSession?(prompter: ClientPasswordPrompt): Promise<ClientPasswordSessionStatus>;
  lockClientPasswordSession?(): Promise<ClientPasswordSessionStatus>;
  readClientPasswordSessionStatus?(): Promise<ClientPasswordSessionStatus>;
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

function resolveSecretDirectoryPath(options: DefaultWalletSecretProviderFactoryOptions): string {
  return join(options.stateRoot ?? resolveWalletRuntimePathsForTesting().stateRoot, "secrets");
}

function resolveRuntimeRootPath(options: DefaultWalletSecretProviderFactoryOptions): string {
  if (options.runtimeRoot != null) {
    return options.runtimeRoot;
  }

  if (options.stateRoot != null) {
    return join(options.stateRoot, ".client-runtime");
  }

  return options.runtimeRoot ?? resolveWalletRuntimePathsForTesting().runtimeRoot;
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

  withPrompter(_prompter: ClientPasswordPrompt): WalletSecretProvider {
    return this;
  }

  async inspectClientPasswordReadiness(): Promise<ClientPasswordReadiness> {
    return "ready";
  }

  async ensureClientPasswordConfigured(_prompter: ClientPasswordPrompt): Promise<ClientPasswordSetupAction> {
    return "already-configured";
  }

  async unlockClientPasswordSession(_prompter: ClientPasswordPrompt): Promise<ClientPasswordSessionStatus> {
    return {
      unlocked: true,
      unlockUntilUnixMs: null,
    };
  }

  async changeClientPassword(_prompter: ClientPasswordPrompt): Promise<ClientPasswordSessionStatus> {
    return {
      unlocked: true,
      unlockUntilUnixMs: null,
    };
  }

  async lockClientPasswordSession(): Promise<ClientPasswordSessionStatus> {
    return {
      unlocked: false,
      unlockUntilUnixMs: null,
    };
  }

  async readClientPasswordSessionStatus(): Promise<ClientPasswordSessionStatus> {
    return {
      unlocked: true,
      unlockUntilUnixMs: null,
    };
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
  readonly #stateRoot: string;
  readonly #directoryPath: string;
  readonly #platform: NodeJS.Platform;
  readonly #runtimeRoot: string;
  readonly #runtimeErrorCode: string;
  readonly #legacyMacKeychainReader: MacOsKeychainWalletSecretProvider | null;
  readonly #prompter: ClientPasswordPrompt | null;

  constructor(options: {
    stateRoot: string;
    directoryPath: string;
    kind: string;
    platform: NodeJS.Platform;
    runtimeRoot: string;
    runtimeErrorCode: string;
    legacyMacKeychainReader?: MacOsKeychainWalletSecretProvider | null;
    prompter?: ClientPasswordPrompt | null;
  }) {
    this.kind = options.kind;
    this.#stateRoot = options.stateRoot;
    this.#directoryPath = options.directoryPath;
    this.#platform = options.platform;
    this.#runtimeRoot = options.runtimeRoot;
    this.#runtimeErrorCode = options.runtimeErrorCode;
    this.#legacyMacKeychainReader = options.legacyMacKeychainReader ?? null;
    this.#prompter = options.prompter ?? null;
  }

  async loadSecret(keyId: string): Promise<Uint8Array> {
    return await loadClientProtectedSecret({
      platform: this.#platform,
      stateRoot: this.#stateRoot,
      runtimeRoot: this.#runtimeRoot,
      directoryPath: this.#directoryPath,
      runtimeErrorCode: this.#runtimeErrorCode,
      legacyMacKeychainReader: this.#legacyMacKeychainReader,
      keyId,
      prompt: this.#prompter ?? undefined,
    });
  }

  async storeSecret(keyId: string, secret: Uint8Array): Promise<void> {
    await storeClientProtectedSecret({
      platform: this.#platform,
      stateRoot: this.#stateRoot,
      runtimeRoot: this.#runtimeRoot,
      directoryPath: this.#directoryPath,
      runtimeErrorCode: this.#runtimeErrorCode,
      legacyMacKeychainReader: this.#legacyMacKeychainReader,
      keyId,
      secret,
      prompt: this.#prompter ?? undefined,
    });
  }

  async deleteSecret(keyId: string): Promise<void> {
    await deleteClientProtectedSecret({
      platform: this.#platform,
      stateRoot: this.#stateRoot,
      runtimeRoot: this.#runtimeRoot,
      directoryPath: this.#directoryPath,
      runtimeErrorCode: this.#runtimeErrorCode,
      keyId,
    });
  }

  withPrompter(prompter: ClientPasswordPrompt): WalletSecretProvider {
    return new LocalFileWalletSecretProvider({
      stateRoot: this.#stateRoot,
      directoryPath: this.#directoryPath,
      kind: this.kind,
      platform: this.#platform,
      runtimeRoot: this.#runtimeRoot,
      runtimeErrorCode: this.#runtimeErrorCode,
      legacyMacKeychainReader: this.#legacyMacKeychainReader,
      prompter,
    });
  }

  async inspectClientPasswordReadiness(): Promise<ClientPasswordReadiness> {
    return await inspectClientPasswordReadiness({
      platform: this.#platform,
      stateRoot: this.#stateRoot,
      runtimeRoot: this.#runtimeRoot,
      directoryPath: this.#directoryPath,
      runtimeErrorCode: this.#runtimeErrorCode,
      legacyMacKeychainReader: this.#legacyMacKeychainReader,
    });
  }

  async ensureClientPasswordConfigured(prompter: ClientPasswordPrompt): Promise<ClientPasswordSetupAction> {
    const result = await ensureClientPasswordConfiguredWithLocalFile({
      platform: this.#platform,
      stateRoot: this.#stateRoot,
      runtimeRoot: this.#runtimeRoot,
      directoryPath: this.#directoryPath,
      runtimeErrorCode: this.#runtimeErrorCode,
      legacyMacKeychainReader: this.#legacyMacKeychainReader,
      prompt: prompter,
    });
    return result.action;
  }

  async unlockClientPasswordSession(prompter: ClientPasswordPrompt): Promise<ClientPasswordSessionStatus> {
    return await unlockClientPasswordSessionWithLocalFile({
      platform: this.#platform,
      stateRoot: this.#stateRoot,
      runtimeRoot: this.#runtimeRoot,
      directoryPath: this.#directoryPath,
      runtimeErrorCode: this.#runtimeErrorCode,
      legacyMacKeychainReader: this.#legacyMacKeychainReader,
      prompt: prompter,
    });
  }

  async changeClientPassword(prompter: ClientPasswordPrompt): Promise<ClientPasswordSessionStatus> {
    return await changeClientPasswordWithLocalFile({
      platform: this.#platform,
      stateRoot: this.#stateRoot,
      runtimeRoot: this.#runtimeRoot,
      directoryPath: this.#directoryPath,
      runtimeErrorCode: this.#runtimeErrorCode,
      legacyMacKeychainReader: this.#legacyMacKeychainReader,
      prompt: prompter,
    });
  }

  async lockClientPasswordSession(): Promise<ClientPasswordSessionStatus> {
    return await lockClientPasswordSession({
      platform: this.#platform,
      stateRoot: this.#stateRoot,
      runtimeRoot: this.#runtimeRoot,
      directoryPath: this.#directoryPath,
      runtimeErrorCode: this.#runtimeErrorCode,
      legacyMacKeychainReader: this.#legacyMacKeychainReader,
    });
  }

  async readClientPasswordSessionStatus(): Promise<ClientPasswordSessionStatus> {
    return await readClientPasswordSessionStatus({
      platform: this.#platform,
      stateRoot: this.#stateRoot,
      runtimeRoot: this.#runtimeRoot,
      directoryPath: this.#directoryPath,
      runtimeErrorCode: this.#runtimeErrorCode,
      legacyMacKeychainReader: this.#legacyMacKeychainReader,
    });
  }
}

function createWalletSecretProviderForPlatform(
  platform: NodeJS.Platform,
  options: DefaultWalletSecretProviderFactoryOptions = {},
): WalletSecretProvider {
  if (platform === "win32") {
    return new LocalFileWalletSecretProvider({
      stateRoot: options.stateRoot ?? resolveWalletRuntimePathsForTesting().stateRoot,
      directoryPath: resolveSecretDirectoryPath(options),
      kind: "windows-local-file",
      platform,
      runtimeRoot: resolveRuntimeRootPath(options),
      runtimeErrorCode: "wallet_secret_provider_windows_runtime_error",
    });
  }

  if (platform === "linux") {
    return new LocalFileWalletSecretProvider({
      stateRoot: options.stateRoot ?? resolveWalletRuntimePathsForTesting().stateRoot,
      directoryPath: resolveSecretDirectoryPath(options),
      kind: "linux-local-file",
      platform,
      runtimeRoot: resolveRuntimeRootPath(options),
      runtimeErrorCode: "wallet_secret_provider_linux_runtime_error",
    });
  }

  if (platform === "darwin") {
    return new LocalFileWalletSecretProvider({
      stateRoot: options.stateRoot ?? resolveWalletRuntimePathsForTesting().stateRoot,
      directoryPath: resolveSecretDirectoryPath(options),
      kind: "macos-local-file",
      platform,
      runtimeRoot: resolveRuntimeRootPath(options),
      runtimeErrorCode: "wallet_secret_provider_macos_runtime_error",
      legacyMacKeychainReader: new MacOsKeychainWalletSecretProvider(),
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
    withPrompter(prompter: ClientPasswordPrompt): WalletSecretProvider {
      return getResolved().withPrompter?.(prompter) ?? getResolved();
    },
    async inspectClientPasswordReadiness(): Promise<ClientPasswordReadiness> {
      return await getResolved().inspectClientPasswordReadiness?.() ?? "ready";
    },
    async ensureClientPasswordConfigured(prompter: ClientPasswordPrompt): Promise<ClientPasswordSetupAction> {
      return await getResolved().ensureClientPasswordConfigured?.(prompter) ?? "already-configured";
    },
    async unlockClientPasswordSession(prompter: ClientPasswordPrompt): Promise<ClientPasswordSessionStatus> {
      return await getResolved().unlockClientPasswordSession?.(prompter) ?? {
        unlocked: true,
        unlockUntilUnixMs: null,
      };
    },
    async changeClientPassword(prompter: ClientPasswordPrompt): Promise<ClientPasswordSessionStatus> {
      return await getResolved().changeClientPassword?.(prompter) ?? {
        unlocked: true,
        unlockUntilUnixMs: null,
      };
    },
    async lockClientPasswordSession(): Promise<ClientPasswordSessionStatus> {
      return await getResolved().lockClientPasswordSession?.() ?? {
        unlocked: false,
        unlockUntilUnixMs: null,
      };
    },
    async readClientPasswordSessionStatus(): Promise<ClientPasswordSessionStatus> {
      return await getResolved().readClientPasswordSessionStatus?.() ?? {
        unlocked: true,
        unlockUntilUnixMs: null,
      };
    },
  };
}

export function createMemoryWalletSecretProviderForTesting(): WalletSecretProvider {
  return new MemoryWalletSecretProvider();
}

export function withInteractiveWalletSecretProvider(
  provider: WalletSecretProvider,
  prompter: ClientPasswordPrompt,
): WalletSecretProvider {
  return provider.withPrompter?.(prompter) ?? provider;
}

export async function ensureClientPasswordConfigured(
  provider: WalletSecretProvider,
  prompter: ClientPasswordPrompt,
): Promise<ClientPasswordSetupAction> {
  return await provider.ensureClientPasswordConfigured?.(prompter) ?? "already-configured";
}

export async function inspectClientPasswordSetupReadiness(
  provider: WalletSecretProvider,
): Promise<ClientPasswordReadiness> {
  return await provider.inspectClientPasswordReadiness?.() ?? "ready";
}

export async function unlockClientPassword(
  provider: WalletSecretProvider,
  prompter: ClientPasswordPrompt,
): Promise<ClientPasswordSessionStatus> {
  return await provider.unlockClientPasswordSession?.(prompter) ?? {
    unlocked: true,
    unlockUntilUnixMs: null,
  };
}

export async function changeClientPassword(
  provider: WalletSecretProvider,
  prompter: ClientPasswordPrompt,
): Promise<ClientPasswordSessionStatus> {
  return await provider.changeClientPassword?.(prompter) ?? {
    unlocked: true,
    unlockUntilUnixMs: null,
  };
}

export async function lockClientPassword(
  provider: WalletSecretProvider,
): Promise<ClientPasswordSessionStatus> {
  return await provider.lockClientPasswordSession?.() ?? {
    unlocked: false,
    unlockUntilUnixMs: null,
  };
}

export async function readClientPasswordStatus(
  provider: WalletSecretProvider,
): Promise<ClientPasswordSessionStatus> {
  return await provider.readClientPasswordSessionStatus?.() ?? {
    unlocked: true,
    unlockUntilUnixMs: null,
  };
}

export function createWalletRootId(): string {
  return `wallet-${randomUUID().replaceAll("-", "")}`;
}
