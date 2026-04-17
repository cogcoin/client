import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

import { argon2idAsync } from "@noble/hashes/argon2.js";

import { writeFileAtomic, writeJsonFileAtomic } from "../fs/atomic.js";
import { decryptBytesWithKey, encryptBytesWithKey } from "./crypto.js";

const CLIENT_PASSWORD_STATE_FORMAT = "cogcoin-client-password";
const CLIENT_PASSWORD_VERIFIER_FORMAT = "cogcoin-client-password-verifier";
const LOCAL_SECRET_ENVELOPE_FORMAT = "cogcoin-local-wallet-secret";
const CLIENT_PASSWORD_VERIFIER_TEXT = "cogcoin-client-password-verifier-v1";
const CLIENT_PASSWORD_MANUAL_UNLOCK_SECONDS = 60;
export const CLIENT_PASSWORD_SETUP_AUTO_UNLOCK_SECONDS = 86_400;
const CLIENT_PASSWORD_DERIVED_KEY_BYTES = 32;
const CLIENT_PASSWORD_KDF = {
  memoryKib: 65_536,
  iterations: 3,
  parallelism: 1,
};

export type ClientPasswordReadiness =
  | "ready"
  | "setup-required"
  | "migration-required";

export type ClientPasswordSetupAction =
  | "created"
  | "migrated"
  | "already-configured";

export interface ClientPasswordPrompt {
  readonly isInteractive: boolean;
  writeLine(message: string): void;
  prompt(message: string): Promise<string>;
  promptHidden?(message: string): Promise<string>;
}

export interface ClientPasswordSessionStatus {
  unlocked: boolean;
  unlockUntilUnixMs: number | null;
}

export interface ClientPasswordStorageOptions {
  platform: NodeJS.Platform;
  stateRoot: string;
  runtimeRoot: string;
  directoryPath: string;
  runtimeErrorCode: string;
  legacyMacKeychainReader?: {
    loadSecret(keyId: string): Promise<Uint8Array>;
  } | null;
}

interface ClientPasswordStateV1 {
  format: typeof CLIENT_PASSWORD_STATE_FORMAT;
  version: 1;
  passwordHint: string;
  kdf: {
    name: "argon2id";
    memoryKib: number;
    iterations: number;
    parallelism: number;
    salt: string;
  };
  verifier: {
    cipher: "aes-256-gcm";
    nonce: string;
    tag: string;
    ciphertext: string;
  };
}

interface AgentRequest {
  command: "status" | "lock" | "refresh" | "encrypt" | "decrypt";
  secretBase64?: string;
  unlockUntilUnixMs?: number;
  envelope?: {
    nonce: string;
    tag: string;
    ciphertext: string;
  };
}

interface AgentResponse {
  ok: boolean;
  unlockUntilUnixMs?: number | null;
  secretBase64?: string;
  envelope?: {
    nonce: string;
    tag: string;
    ciphertext: string;
  };
  error?: string;
}

type LocalSecretFile =
  | { state: "missing" }
  | { state: "raw"; secret: Uint8Array }
  | { state: "wrapped"; envelope: { nonce: string; tag: string; ciphertext: string } };

function sanitizeSecretKeyId(keyId: string): string {
  return keyId.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export function resolveLocalSecretFilePath(directoryPath: string, keyId: string): string {
  return join(directoryPath, `${sanitizeSecretKeyId(keyId)}.secret`);
}

function resolveClientPasswordStatePath(directoryPath: string): string {
  return join(directoryPath, "client-password.json");
}

function resolveAgentEndpoint(platform: NodeJS.Platform, stateRoot: string): string {
  const hash = createHash("sha256").update(stateRoot).digest("hex").slice(0, 24);

  if (platform === "win32") {
    return `\\\\.\\pipe\\cogcoin-client-password-${hash}`;
  }

  return join(tmpdir(), `cogcoin-client-password-${hash}.sock`);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function createRuntimeError(code: string, cause?: unknown): Error {
  return cause === undefined ? new Error(code) : new Error(code, { cause });
}

function isWrappedSecretEnvelope(value: unknown): value is {
  format: string;
  version: 1;
  wrappedBy: string;
  nonce: string;
  tag: string;
  ciphertext: string;
} {
  return value !== null
    && typeof value === "object"
    && (value as { format?: unknown }).format === LOCAL_SECRET_ENVELOPE_FORMAT
    && (value as { version?: unknown }).version === 1
    && (value as { wrappedBy?: unknown }).wrappedBy === "client-password"
    && typeof (value as { nonce?: unknown }).nonce === "string"
    && typeof (value as { tag?: unknown }).tag === "string"
    && typeof (value as { ciphertext?: unknown }).ciphertext === "string";
}

async function readLocalSecretFile(path: string): Promise<LocalSecretFile> {
  try {
    const raw = await readFile(path, "utf8");
    const trimmed = raw.trim();

    try {
      const parsed = JSON.parse(trimmed) as unknown;

      if (isWrappedSecretEnvelope(parsed)) {
        return {
          state: "wrapped",
          envelope: {
            nonce: parsed.nonce,
            tag: parsed.tag,
            ciphertext: parsed.ciphertext,
          },
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

async function loadClientPasswordStateOrNull(path: string): Promise<ClientPasswordStateV1 | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as ClientPasswordStateV1;

    if (
      parsed.format !== CLIENT_PASSWORD_STATE_FORMAT
      || parsed.version !== 1
      || parsed.kdf?.name !== "argon2id"
      || typeof parsed.passwordHint !== "string"
    ) {
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

async function derivePasswordKey(passwordBytes: Uint8Array, saltBytes: Uint8Array): Promise<Buffer> {
  return Buffer.from(await argon2idAsync(passwordBytes, saltBytes, {
    m: CLIENT_PASSWORD_KDF.memoryKib,
    t: CLIENT_PASSWORD_KDF.iterations,
    p: CLIENT_PASSWORD_KDF.parallelism,
    dkLen: CLIENT_PASSWORD_DERIVED_KEY_BYTES,
  }));
}

function zeroizeBuffer(buffer: Uint8Array | null | undefined): void {
  if (buffer != null) {
    buffer.fill(0);
  }
}

async function createClientPasswordState(options: {
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

async function verifyPassword(options: {
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

async function collectWalletStateRoots(stateRoot: string): Promise<string[]> {
  const roots = [stateRoot];
  const seedsRoot = join(stateRoot, "seeds");

  try {
    const entries = await readdir(seedsRoot, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        roots.push(join(seedsRoot, entry.name));
      }
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  return roots;
}

async function readReferencedSecretIdsFromWalletStateRoot(walletStateRoot: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const candidatePaths = [
    join(walletStateRoot, "wallet-state.enc"),
    join(walletStateRoot, "wallet-state.enc.bak"),
    join(walletStateRoot, "wallet-init-pending.enc"),
    join(walletStateRoot, "wallet-init-pending.enc.bak"),
  ];

  for (const candidatePath of candidatePaths) {
    try {
      const parsed = JSON.parse(await readFile(candidatePath, "utf8")) as {
        secretProvider?: { keyId?: string | null } | null;
      };
      const keyId = parsed.secretProvider?.keyId?.trim() ?? "";

      if (keyId.length > 0) {
        ids.add(keyId);
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        continue;
      }
    }
  }

  return ids;
}

async function collectReferencedSecretIds(stateRoot: string): Promise<string[]> {
  const ids = new Set<string>();
  const roots = await collectWalletStateRoots(stateRoot);

  for (const root of roots) {
    const rootIds = await readReferencedSecretIdsFromWalletStateRoot(root);

    for (const keyId of rootIds) {
      ids.add(keyId);
    }
  }

  return [...ids].sort((left, right) => left.localeCompare(right));
}

async function legacyMacKeychainHasSecret(
  options: ClientPasswordStorageOptions,
  keyId: string,
): Promise<boolean> {
  if (options.platform !== "darwin" || options.legacyMacKeychainReader == null) {
    return false;
  }

  try {
    await options.legacyMacKeychainReader.loadSecret(keyId);
    return true;
  } catch {
    return false;
  }
}

async function inspectReadinessForKey(
  options: ClientPasswordStorageOptions,
  keyId: string,
): Promise<{
  local: LocalSecretFile;
  keychain: boolean;
}> {
  const local = await readLocalSecretFile(resolveLocalSecretFilePath(options.directoryPath, keyId));
  const keychain = await legacyMacKeychainHasSecret(options, keyId);
  return { local, keychain };
}

export async function inspectClientPasswordReadiness(
  options: ClientPasswordStorageOptions,
): Promise<ClientPasswordReadiness> {
  const passwordState = await loadClientPasswordStateOrNull(resolveClientPasswordStatePath(options.directoryPath));
  const keyIds = await collectReferencedSecretIds(options.stateRoot);

  if (keyIds.length === 0) {
    return passwordState === null ? "setup-required" : "ready";
  }

  for (const keyId of keyIds) {
    const sourceState = await inspectReadinessForKey(options, keyId);

    if (passwordState === null) {
      if (sourceState.local.state === "raw" || sourceState.keychain) {
        return "migration-required";
      }
      continue;
    }

    if (sourceState.local.state === "raw") {
      return "migration-required";
    }

    if (sourceState.local.state === "missing" && sourceState.keychain) {
      return "migration-required";
    }
  }

  return passwordState === null ? "setup-required" : "ready";
}

function describeReadinessError(readiness: ClientPasswordReadiness): string {
  return readiness === "migration-required"
    ? "wallet_client_password_migration_required"
    : "wallet_client_password_setup_required";
}

async function openAgentConnection(endpoint: string): Promise<net.Socket> {
  return await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.on("connect", onConnect);
    socket.on("error", onError);
  });
}

async function requestAgent(
  options: ClientPasswordStorageOptions,
  request: AgentRequest,
): Promise<AgentResponse> {
  const endpoint = resolveAgentEndpoint(options.platform, options.stateRoot);
  const socket = await openAgentConnection(endpoint);

  return await new Promise<AgentResponse>((resolve, reject) => {
    let received = "";

    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      socket.off("close", onClose);
    };

    const finish = (response: AgentResponse) => {
      cleanup();
      socket.end();
      resolve(response);
    };

    const fail = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };

    const onData = (chunk: Buffer) => {
      received += chunk.toString("utf8");
      const newlineIndex = received.indexOf("\n");

      if (newlineIndex === -1) {
        return;
      }

      try {
        finish(JSON.parse(received.slice(0, newlineIndex)) as AgentResponse);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const onError = (error: Error) => {
      fail(error);
    };

    const onEnd = () => {
      if (received.length === 0) {
        fail(new Error("wallet_client_password_locked"));
      }
    };

    const onClose = () => {
      if (received.length === 0) {
        fail(new Error("wallet_client_password_locked"));
      }
    };

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("end", onEnd);
    socket.on("close", onClose);
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

async function requestAgentOrNull(
  options: ClientPasswordStorageOptions,
  request: AgentRequest,
): Promise<AgentResponse | null> {
  try {
    return await requestAgent(options, request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message === "wallet_client_password_locked") {
      return null;
    }

    const code = error instanceof Error && "code" in error
      ? String((error as NodeJS.ErrnoException).code ?? "")
      : "";

    if (code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE") {
      if (options.platform !== "win32") {
        await rm(resolveAgentEndpoint(options.platform, options.stateRoot), { force: true }).catch(() => undefined);
      }
      return null;
    }

    throw error;
  }
}

export async function readClientPasswordSessionStatus(
  options: ClientPasswordStorageOptions,
): Promise<ClientPasswordSessionStatus> {
  const response = await requestAgentOrNull(options, { command: "status" });

  if (response === null || !response.ok) {
    return {
      unlocked: false,
      unlockUntilUnixMs: null,
    };
  }

  return {
    unlocked: true,
    unlockUntilUnixMs: response.unlockUntilUnixMs ?? null,
  };
}

export async function lockClientPasswordSession(
  options: ClientPasswordStorageOptions,
): Promise<ClientPasswordSessionStatus> {
  await requestAgentOrNull(options, { command: "lock" }).catch(() => null);
  if (options.platform !== "win32") {
    await rm(resolveAgentEndpoint(options.platform, options.stateRoot), { force: true }).catch(() => undefined);
  }
  return {
    unlocked: false,
    unlockUntilUnixMs: null,
  };
}

async function waitForAgentReady(child: ReturnType<typeof spawn>): Promise<void> {
  const stdout = child.stdout;

  if (stdout == null) {
    throw new Error("wallet_client_password_agent_start_failed");
  }

  await new Promise<void>((resolve, reject) => {
    let received = "";

    const cleanup = () => {
      stdout.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };

    const onData = (chunk: Buffer) => {
      received += chunk.toString("utf8");
      const newlineIndex = received.indexOf("\n");

      if (newlineIndex === -1) {
        return;
      }

      cleanup();
      if (received.slice(0, newlineIndex).trim() === "ready") {
        resolve();
        return;
      }

      reject(new Error("wallet_client_password_agent_start_failed"));
    };

    const onExit = () => {
      cleanup();
      reject(new Error("wallet_client_password_agent_start_failed"));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    stdout.on("data", onData);
    child.on("exit", onExit);
    child.on("error", onError);
  });
}

function releaseAgentBootstrapHandles(child: ReturnType<typeof spawn>): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
}

async function startClientPasswordSession(options: ClientPasswordStorageOptions & {
  derivedKey: Buffer;
  unlockDurationSeconds: number;
}): Promise<ClientPasswordSessionStatus> {
  const unlockUntilUnixMs = Date.now() + (options.unlockDurationSeconds * 1_000);
  const endpoint = resolveAgentEndpoint(options.platform, options.stateRoot);

  await lockClientPasswordSession(options).catch(() => undefined);
  await mkdir(options.runtimeRoot, { recursive: true }).catch(() => undefined);

  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./client-password-agent.js", import.meta.url)), endpoint, String(unlockUntilUnixMs)],
    {
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
    },
  );

  try {
    child.stdin?.end(`${JSON.stringify({
      derivedKeyBase64: options.derivedKey.toString("base64"),
    })}\n`);
    await waitForAgentReady(child);
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    releaseAgentBootstrapHandles(child);
    zeroizeBuffer(options.derivedKey);
  }

  child.unref();

  return {
    unlocked: true,
    unlockUntilUnixMs,
  };
}

async function promptForHiddenValue(prompt: ClientPasswordPrompt, message: string): Promise<string> {
  const value = prompt.promptHidden != null
    ? await prompt.promptHidden(message)
    : await prompt.prompt(message);

  return value.trim();
}

async function promptForUnlockDuration(prompt: ClientPasswordPrompt): Promise<number> {
  return await promptForUnlockDurationWithDefault(prompt, CLIENT_PASSWORD_MANUAL_UNLOCK_SECONDS);
}

async function promptForUnlockDurationWithDefault(
  prompt: ClientPasswordPrompt,
  defaultSeconds: number,
): Promise<number> {
  while (true) {
    const answer = (await prompt.prompt(`Unlock duration in seconds [${defaultSeconds}]: `)).trim();

    if (answer === "") {
      return defaultSeconds;
    }

    if (/^[1-9]\d*$/.test(answer)) {
      return Number(answer);
    }

    prompt.writeLine("Enter a whole-number duration in seconds.");
  }
}

function resolveRemainingUnlockSeconds(status: ClientPasswordSessionStatus): number {
  if (status.unlockUntilUnixMs === null) {
    return CLIENT_PASSWORD_MANUAL_UNLOCK_SECONDS;
  }

  return Math.max(1, Math.ceil((status.unlockUntilUnixMs - Date.now()) / 1_000));
}

async function refreshClientPasswordSession(
  options: ClientPasswordStorageOptions & {
    unlockUntilUnixMs: number;
  },
): Promise<ClientPasswordSessionStatus | null> {
  const response = await requestAgentOrNull(options, {
    command: "refresh",
    unlockUntilUnixMs: options.unlockUntilUnixMs,
  });

  if (response === null || !response.ok) {
    return null;
  }

  return {
    unlocked: true,
    unlockUntilUnixMs: response.unlockUntilUnixMs ?? options.unlockUntilUnixMs,
  };
}

async function unlockClientPasswordSessionWithPrompt(
  options: ClientPasswordStorageOptions & {
    prompt: ClientPasswordPrompt;
  },
): Promise<ClientPasswordSessionStatus> {
  const readiness = await inspectClientPasswordReadiness(options);

  if (readiness !== "ready") {
    throw new Error(describeReadinessError(readiness));
  }

  if (!options.prompt.isInteractive) {
    throw new Error("wallet_client_password_unlock_requires_tty");
  }

  const state = await loadClientPasswordStateOrNull(resolveClientPasswordStatePath(options.directoryPath));

  if (state === null) {
    throw new Error("wallet_client_password_setup_required");
  }

  let attempts = 0;

  while (true) {
    if (attempts >= 2 && state.passwordHint.trim().length > 0) {
      options.prompt.writeLine(`Hint: ${state.passwordHint}`);
    }

    const passwordText = await promptForHiddenValue(options.prompt, "Client password: ");
    const passwordBytes = Buffer.from(passwordText, "utf8");
    let derivedKey: Buffer | null = null;

    try {
      derivedKey = await verifyPassword({
        state,
        passwordBytes,
      });
    } finally {
      zeroizeBuffer(passwordBytes);
    }

    if (derivedKey === null) {
      attempts += 1;
      options.prompt.writeLine("Incorrect client password.");
      continue;
    }

    const unlockDurationSeconds = await promptForUnlockDuration(options.prompt);
    return await startClientPasswordSession({
      ...options,
      derivedKey,
      unlockDurationSeconds,
    });
  }
}

async function writeWrappedSecret(options: {
  path: string;
  secret: Uint8Array;
  derivedKey: Uint8Array;
}): Promise<void> {
  const envelope = encryptBytesWithKey(options.secret, options.derivedKey, {
    format: LOCAL_SECRET_ENVELOPE_FORMAT,
    wrappedBy: "client-password",
  });

  await writeFileAtomic(options.path, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
}

async function migrateReferencedSecrets(options: ClientPasswordStorageOptions & {
  derivedKey: Uint8Array;
}): Promise<boolean> {
  const keyIds = await collectReferencedSecretIds(options.stateRoot);
  let migrated = false;

  for (const keyId of keyIds) {
    const localPath = resolveLocalSecretFilePath(options.directoryPath, keyId);
    const localState = await readLocalSecretFile(localPath);

    if (localState.state === "wrapped") {
      continue;
    }

    if (localState.state === "raw") {
      await writeWrappedSecret({
        path: localPath,
        secret: localState.secret,
        derivedKey: options.derivedKey,
      });
      migrated = true;
      continue;
    }

    if (options.platform === "darwin" && options.legacyMacKeychainReader != null) {
      try {
        const secret = await options.legacyMacKeychainReader.loadSecret(keyId);
        await writeWrappedSecret({
          path: localPath,
          secret,
          derivedKey: options.derivedKey,
        });
        migrated = true;
      } catch {
        // Best-effort legacy migration only.
      }
    }
  }

  return migrated;
}

async function promptForNewPassword(prompt: ClientPasswordPrompt): Promise<{
  passwordBytes: Buffer;
  passwordHint: string;
}> {
  if (!prompt.isInteractive) {
    throw new Error("wallet_client_password_setup_requires_tty");
  }

  while (true) {
    const first = await promptForHiddenValue(prompt, "Create client password: ");
    const firstBytes = Buffer.from(first, "utf8");

    if (firstBytes.length === 0) {
      zeroizeBuffer(firstBytes);
      prompt.writeLine("Client password cannot be blank.");
      continue;
    }

    const second = await promptForHiddenValue(prompt, "Confirm client password: ");
    const secondBytes = Buffer.from(second, "utf8");

    if (!firstBytes.equals(secondBytes)) {
      zeroizeBuffer(firstBytes);
      zeroizeBuffer(secondBytes);
      prompt.writeLine("Client password entries did not match.");
      continue;
    }

    zeroizeBuffer(secondBytes);

    let passwordHint = "";

    while (passwordHint.length === 0) {
      passwordHint = (await prompt.prompt("Password hint: ")).trim();

      if (passwordHint.length === 0) {
        prompt.writeLine("Password hint cannot be blank.");
      }
    }

    return {
      passwordBytes: firstBytes,
      passwordHint,
    };
  }
}

export async function ensureClientPasswordConfigured(
  options: ClientPasswordStorageOptions & {
    prompt: ClientPasswordPrompt;
  },
): Promise<{ action: ClientPasswordSetupAction; session: ClientPasswordSessionStatus }> {
  const readiness = await inspectClientPasswordReadiness(options);

  if (readiness === "ready") {
    return {
      action: "already-configured",
      session: await readClientPasswordSessionStatus(options),
    };
  }

  const setup = await promptForNewPassword(options.prompt);
  let derivedKey: Buffer | null = null;

  try {
    const created = await createClientPasswordState({
      passwordBytes: setup.passwordBytes,
      passwordHint: setup.passwordHint,
    });
    derivedKey = created.derivedKey;

    await mkdir(options.directoryPath, { recursive: true, mode: 0o700 });
    await writeJsonFileAtomic(resolveClientPasswordStatePath(options.directoryPath), created.state, { mode: 0o600 });

    const migrated = await migrateReferencedSecrets({
      ...options,
      derivedKey,
    });

    const session = await startClientPasswordSession({
      ...options,
      derivedKey,
      unlockDurationSeconds: CLIENT_PASSWORD_SETUP_AUTO_UNLOCK_SECONDS,
    });
    derivedKey = null;

    return {
      action: migrated || readiness === "migration-required" ? "migrated" : "created",
      session,
    };
  } finally {
    zeroizeBuffer(setup.passwordBytes);
    zeroizeBuffer(derivedKey);
  }
}

async function decryptWrappedSecretWithSession(
  options: ClientPasswordStorageOptions & {
    envelope: { nonce: string; tag: string; ciphertext: string };
    prompt?: ClientPasswordPrompt;
  },
): Promise<Uint8Array> {
  let response = await requestAgentOrNull(options, {
    command: "decrypt",
    envelope: options.envelope,
  });

  if (response === null && options.prompt != null && options.prompt.isInteractive) {
    await unlockClientPasswordSessionWithPrompt({
      ...options,
      prompt: options.prompt,
    });
    response = await requestAgentOrNull(options, {
      command: "decrypt",
      envelope: options.envelope,
    });
  }

  if (response === null || !response.ok || response.secretBase64 == null) {
    throw new Error("wallet_client_password_locked");
  }

  return new Uint8Array(Buffer.from(response.secretBase64, "base64"));
}

async function encryptWrappedSecretWithSession(
  options: ClientPasswordStorageOptions & {
    secret: Uint8Array;
    prompt?: ClientPasswordPrompt;
  },
): Promise<{ nonce: string; tag: string; ciphertext: string }> {
  let response = await requestAgentOrNull(options, {
    command: "encrypt",
    secretBase64: Buffer.from(options.secret).toString("base64"),
  });

  if (response === null && options.prompt != null && options.prompt.isInteractive) {
    await unlockClientPasswordSessionWithPrompt({
      ...options,
      prompt: options.prompt,
    });
    response = await requestAgentOrNull(options, {
      command: "encrypt",
      secretBase64: Buffer.from(options.secret).toString("base64"),
    });
  }

  if (response === null || !response.ok || response.envelope == null) {
    throw new Error("wallet_client_password_locked");
  }

  return response.envelope;
}

export async function loadClientProtectedSecret(
  options: ClientPasswordStorageOptions & {
    keyId: string;
    prompt?: ClientPasswordPrompt;
  },
): Promise<Uint8Array> {
  try {
    const passwordState = await loadClientPasswordStateOrNull(resolveClientPasswordStatePath(options.directoryPath));
    const localState = await readLocalSecretFile(resolveLocalSecretFilePath(options.directoryPath, options.keyId));

    if (passwordState === null) {
      if (localState.state === "raw" || await legacyMacKeychainHasSecret(options, options.keyId)) {
        throw new Error("wallet_client_password_migration_required");
      }

      throw new Error("wallet_client_password_setup_required");
    }

    if (localState.state === "missing") {
      if (await legacyMacKeychainHasSecret(options, options.keyId)) {
        throw new Error("wallet_client_password_migration_required");
      }

      throw new Error(`wallet_secret_missing_${options.keyId}`);
    }

    if (localState.state === "raw") {
      throw new Error("wallet_client_password_migration_required");
    }

    return await decryptWrappedSecretWithSession({
      ...options,
      envelope: localState.envelope,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (
      message.startsWith("wallet_client_password_")
      || message.startsWith("wallet_secret_missing_")
    ) {
      throw error;
    }

    throw createRuntimeError(options.runtimeErrorCode, error);
  }
}

export async function storeClientProtectedSecret(
  options: ClientPasswordStorageOptions & {
    keyId: string;
    secret: Uint8Array;
    prompt?: ClientPasswordPrompt;
  },
): Promise<void> {
  try {
    const passwordState = await loadClientPasswordStateOrNull(resolveClientPasswordStatePath(options.directoryPath));

    if (passwordState === null) {
      throw new Error("wallet_client_password_setup_required");
    }

    await mkdir(options.directoryPath, { recursive: true, mode: 0o700 });
    const envelope = await encryptWrappedSecretWithSession(options);
    await writeFileAtomic(
      resolveLocalSecretFilePath(options.directoryPath, options.keyId),
      `${JSON.stringify({
        format: LOCAL_SECRET_ENVELOPE_FORMAT,
        version: 1,
        cipher: "aes-256-gcm",
        wrappedBy: "client-password",
        nonce: envelope.nonce,
        tag: envelope.tag,
        ciphertext: envelope.ciphertext,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.startsWith("wallet_client_password_")) {
      throw error;
    }

    throw createRuntimeError(options.runtimeErrorCode, error);
  }
}

export async function deleteClientProtectedSecret(
  options: ClientPasswordStorageOptions & {
    keyId: string;
  },
): Promise<void> {
  await rm(resolveLocalSecretFilePath(options.directoryPath, options.keyId), { force: true }).catch(() => undefined);
}

export async function unlockClientPasswordSession(
  options: ClientPasswordStorageOptions & {
    prompt: ClientPasswordPrompt;
  },
): Promise<ClientPasswordSessionStatus> {
  if (!options.prompt.isInteractive) {
    throw new Error("wallet_client_password_unlock_requires_tty");
  }

  const currentStatus = await readClientPasswordSessionStatus(options);

  if (currentStatus.unlocked) {
    const unlockDurationSeconds = await promptForUnlockDurationWithDefault(
      options.prompt,
      resolveRemainingUnlockSeconds(currentStatus),
    );
    const refreshed = await refreshClientPasswordSession({
      ...options,
      unlockUntilUnixMs: Date.now() + (unlockDurationSeconds * 1_000),
    });

    if (refreshed !== null) {
      return refreshed;
    }
  }

  return await unlockClientPasswordSessionWithPrompt(options);
}

export function createLegacyKeychainServiceName(): string {
  return "org.cogcoin.wallet";
}

export function createAgentBootstrapState(options: {
  unlockUntilUnixMs: number;
  derivedKeyBase64: string;
}) {
  return options;
}

export function describeClientPasswordLockedMessage(): string {
  return "Wallet state exists but the client password is locked.";
}

export function describeClientPasswordSetupMessage(): string {
  return "Wallet-local secret access is not configured yet. Run `cogcoin init` to create the client password.";
}

export function describeClientPasswordMigrationMessage(): string {
  return "Wallet-local secret migration is still required. Run `cogcoin init` to migrate this client to password-protected local secrets.";
}

export function listLocalSecretFilesForTesting(options: {
  directoryPath: string;
}): Promise<string[]> {
  return readdir(options.directoryPath).catch(() => []);
}
