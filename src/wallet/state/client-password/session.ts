import {
  createWrappedSecretEnvelope,
  decryptWrappedSecretEnvelope,
  zeroizeBuffer,
} from "./crypto.js";
import { promptForVerifiedClientPassword } from "./prompts.js";
import {
  resolveClientPasswordPromptSessionPolicy,
  resolveClientPasswordSessionUnlockUntilUnixMs,
  type ClientPasswordSessionPolicy,
} from "./session-policy.js";
import type {
  ClientPasswordPrompt,
  ClientPasswordResolvedContext,
  ClientPasswordSessionStatus,
  WrappedSecretEnvelopeV1,
} from "./types.js";

interface ActiveClientPasswordSession {
  derivedKey: Buffer;
  unlockUntilUnixMs: number | null;
  expiryTimer: NodeJS.Timeout | null;
}

const activeSessions = new Map<string, ActiveClientPasswordSession>();
let processCleanupRegistered = false;

function resolveSessionCacheKey(context: ClientPasswordResolvedContext): string {
  return `${context.platform}\n${context.stateRoot}\n${context.directoryPath}\n${context.passwordStatePath}`;
}

function clearExpiryTimer(session: ActiveClientPasswordSession): void {
  if (session.expiryTimer !== null) {
    clearTimeout(session.expiryTimer);
    session.expiryTimer = null;
  }
}

function destroySession(session: ActiveClientPasswordSession | undefined): void {
  if (session === undefined) {
    return;
  }

  clearExpiryTimer(session);
  zeroizeBuffer(session.derivedKey);
}

function clearSessionByKey(cacheKey: string): void {
  const existing = activeSessions.get(cacheKey);

  if (existing === undefined) {
    return;
  }

  activeSessions.delete(cacheKey);
  destroySession(existing);
}

function scheduleSessionExpiry(
  cacheKey: string,
  session: ActiveClientPasswordSession,
): void {
  clearExpiryTimer(session);

  if (session.unlockUntilUnixMs === null) {
    return;
  }

  const remainingMs = Math.max(0, session.unlockUntilUnixMs - Date.now());
  session.expiryTimer = setTimeout(() => {
    clearSessionByKey(cacheKey);
  }, remainingMs);
  session.expiryTimer.unref();
}

export function destroyAllClientPasswordSessionsResolved(): void {
  for (const session of activeSessions.values()) {
    destroySession(session);
  }
  activeSessions.clear();
}

function registerProcessCleanup(): void {
  if (processCleanupRegistered) {
    return;
  }

  processCleanupRegistered = true;
  process.once("exit", () => {
    destroyAllClientPasswordSessionsResolved();
  });
}

function getActiveSession(
  context: ClientPasswordResolvedContext,
): ActiveClientPasswordSession | null {
  const cacheKey = resolveSessionCacheKey(context);
  const session = activeSessions.get(cacheKey);

  if (session === undefined) {
    return null;
  }

  if (session.unlockUntilUnixMs !== null && session.unlockUntilUnixMs <= Date.now()) {
    clearSessionByKey(cacheKey);
    return null;
  }

  return session;
}

function putActiveSession(options: ClientPasswordResolvedContext & {
  derivedKey: Buffer;
  unlockUntilUnixMs: number | null;
}): ClientPasswordSessionStatus {
  registerProcessCleanup();
  const cacheKey = resolveSessionCacheKey(options);
  clearSessionByKey(cacheKey);

  if (options.unlockUntilUnixMs !== null && options.unlockUntilUnixMs <= Date.now()) {
    return {
      unlocked: false,
      unlockUntilUnixMs: null,
    };
  }

  const session: ActiveClientPasswordSession = {
    derivedKey: Buffer.from(options.derivedKey),
    unlockUntilUnixMs: options.unlockUntilUnixMs,
    expiryTimer: null,
  };
  activeSessions.set(cacheKey, session);
  scheduleSessionExpiry(cacheKey, session);

  return {
    unlocked: true,
    unlockUntilUnixMs: session.unlockUntilUnixMs,
  };
}

export async function readClientPasswordSessionStatusResolved(
  context: ClientPasswordResolvedContext,
): Promise<ClientPasswordSessionStatus> {
  const session = getActiveSession(context);

  return {
    unlocked: session !== null,
    unlockUntilUnixMs: session?.unlockUntilUnixMs ?? null,
  };
}

export async function lockClientPasswordSessionResolved(
  context: ClientPasswordResolvedContext,
): Promise<ClientPasswordSessionStatus> {
  clearSessionByKey(resolveSessionCacheKey(context));

  return {
    unlocked: false,
    unlockUntilUnixMs: null,
  };
}

export async function startClientPasswordSessionResolved(options: ClientPasswordResolvedContext & {
  derivedKey: Buffer;
  sessionPolicy: ClientPasswordSessionPolicy;
}): Promise<ClientPasswordSessionStatus> {
  return await startClientPasswordSessionWithExpiryResolved({
    ...options,
    unlockUntilUnixMs: resolveClientPasswordSessionUnlockUntilUnixMs(options.sessionPolicy),
  });
}

export async function startClientPasswordSessionWithExpiryResolved(
  options: ClientPasswordResolvedContext & {
    derivedKey: Buffer;
    unlockUntilUnixMs: number | null;
  },
): Promise<ClientPasswordSessionStatus> {
  try {
    return putActiveSession(options);
  } finally {
    zeroizeBuffer(options.derivedKey);
  }
}

async function refreshClientPasswordSessionResolved(
  context: ClientPasswordResolvedContext & {
    unlockUntilUnixMs: number | null;
  },
): Promise<ClientPasswordSessionStatus | null> {
  const session = getActiveSession(context);

  if (session === null) {
    return null;
  }

  session.unlockUntilUnixMs = context.unlockUntilUnixMs;
  scheduleSessionExpiry(resolveSessionCacheKey(context), session);
  return await readClientPasswordSessionStatusResolved(context);
}

async function unlockClientPasswordSessionWithPromptResolved(options: {
  context: ClientPasswordResolvedContext;
  prompt: ClientPasswordPrompt;
}): Promise<ClientPasswordSessionStatus> {
  const derivedKey = await promptForVerifiedClientPassword({
    context: options.context,
    prompt: options.prompt,
    promptMessage: "Client password: ",
    ttyErrorCode: "wallet_client_password_unlock_requires_tty",
  });

  return await startClientPasswordSessionResolved({
    ...options.context,
    derivedKey,
    sessionPolicy: resolveClientPasswordPromptSessionPolicy(options.prompt),
  });
}

export async function unlockClientPasswordSessionResolved(options: {
  context: ClientPasswordResolvedContext;
  prompt: ClientPasswordPrompt;
}): Promise<ClientPasswordSessionStatus> {
  const sessionPolicy = resolveClientPasswordPromptSessionPolicy(options.prompt);
  const currentStatus = await readClientPasswordSessionStatusResolved(options.context);

  if (currentStatus.unlocked) {
    const refreshed = await refreshClientPasswordSessionResolved({
      ...options.context,
      unlockUntilUnixMs: resolveClientPasswordSessionUnlockUntilUnixMs(sessionPolicy),
    });

    if (refreshed !== null) {
      return refreshed;
    }
  }

  if (!options.prompt.isInteractive) {
    throw new Error("wallet_client_password_unlock_requires_tty");
  }

  return await unlockClientPasswordSessionWithPromptResolved(options);
}

export function decryptClientProtectedSecretWithSessionResolved(
  context: ClientPasswordResolvedContext,
  envelope: WrappedSecretEnvelopeV1,
): Uint8Array | null {
  const session = getActiveSession(context);

  if (session === null) {
    return null;
  }

  return new Uint8Array(decryptWrappedSecretEnvelope(envelope, session.derivedKey));
}

export function encryptClientProtectedSecretWithSessionResolved(
  context: ClientPasswordResolvedContext,
  secret: Uint8Array,
): WrappedSecretEnvelopeV1 | null {
  const session = getActiveSession(context);

  if (session === null) {
    return null;
  }

  return createWrappedSecretEnvelope(secret, session.derivedKey);
}
