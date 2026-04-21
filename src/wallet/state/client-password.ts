export { CLIENT_PASSWORD_SETUP_AUTO_UNLOCK_SECONDS } from "./client-password/crypto.js";
export type {
  ClientPasswordPrompt,
  ClientPasswordReadiness,
  ClientPasswordSessionStatus,
  ClientPasswordSetupAction,
  ClientPasswordStorageOptions,
} from "./client-password/types.js";
export {
  resolveLocalSecretFilePath,
  createLegacyKeychainServiceName,
} from "./client-password/context.js";
export { createAgentBootstrapState } from "./client-password/agent-protocol.js";
export {
  describeClientPasswordLockedMessage,
  describeClientPasswordMigrationMessage,
  describeClientPasswordSetupMessage,
} from "./client-password/messages.js";
export { listLocalSecretFilesForTesting } from "./client-password/files.js";

import { resolveClientPasswordContext } from "./client-password/context.js";
import { inspectClientPasswordReadinessResolved } from "./client-password/readiness.js";
import {
  lockClientPasswordSessionResolved,
  readClientPasswordSessionStatusResolved,
  unlockClientPasswordSessionResolved,
} from "./client-password/session.js";
import { ensureClientPasswordConfiguredResolved } from "./client-password/setup.js";
import {
  deleteClientProtectedSecretResolved,
  loadClientProtectedSecretResolved,
  storeClientProtectedSecretResolved,
} from "./client-password/protected-secrets.js";
import {
  changeClientPasswordResolved,
  finalizePendingClientPasswordRotationIfNeeded,
} from "./client-password/rotation.js";
import type {
  ClientPasswordPrompt,
  ClientPasswordReadiness,
  ClientPasswordSessionStatus,
  ClientPasswordSetupAction,
  ClientPasswordStorageOptions,
} from "./client-password/types.js";

export async function inspectClientPasswordReadiness(
  options: ClientPasswordStorageOptions,
): Promise<ClientPasswordReadiness> {
  const context = resolveClientPasswordContext(options);
  await finalizePendingClientPasswordRotationIfNeeded(context);
  return await inspectClientPasswordReadinessResolved(context);
}

export async function readClientPasswordSessionStatus(
  options: ClientPasswordStorageOptions,
): Promise<ClientPasswordSessionStatus> {
  return await readClientPasswordSessionStatusResolved(resolveClientPasswordContext(options));
}

export async function lockClientPasswordSession(
  options: ClientPasswordStorageOptions,
): Promise<ClientPasswordSessionStatus> {
  return await lockClientPasswordSessionResolved(resolveClientPasswordContext(options));
}

export async function ensureClientPasswordConfigured(options: ClientPasswordStorageOptions & {
  prompt: ClientPasswordPrompt;
}): Promise<{ action: ClientPasswordSetupAction; session: ClientPasswordSessionStatus }> {
  return await ensureClientPasswordConfiguredResolved({
    context: resolveClientPasswordContext(options),
    prompt: options.prompt,
  });
}

export async function loadClientProtectedSecret(options: ClientPasswordStorageOptions & {
  keyId: string;
  prompt?: ClientPasswordPrompt;
}): Promise<Uint8Array> {
  return await loadClientProtectedSecretResolved({
    ...resolveClientPasswordContext(options),
    keyId: options.keyId,
    prompt: options.prompt,
  });
}

export async function storeClientProtectedSecret(options: ClientPasswordStorageOptions & {
  keyId: string;
  secret: Uint8Array;
  prompt?: ClientPasswordPrompt;
}): Promise<void> {
  await storeClientProtectedSecretResolved({
    ...resolveClientPasswordContext(options),
    keyId: options.keyId,
    secret: options.secret,
    prompt: options.prompt,
  });
}

export async function deleteClientProtectedSecret(options: ClientPasswordStorageOptions & {
  keyId: string;
}): Promise<void> {
  await deleteClientProtectedSecretResolved({
    ...resolveClientPasswordContext(options),
    keyId: options.keyId,
  });
}

export async function unlockClientPasswordSession(options: ClientPasswordStorageOptions & {
  prompt: ClientPasswordPrompt;
}): Promise<ClientPasswordSessionStatus> {
  const context = resolveClientPasswordContext(options);
  await finalizePendingClientPasswordRotationIfNeeded(context);
  return await unlockClientPasswordSessionResolved({
    context,
    prompt: options.prompt,
  });
}

export async function changeClientPassword(options: ClientPasswordStorageOptions & {
  prompt: ClientPasswordPrompt;
}): Promise<ClientPasswordSessionStatus> {
  return await changeClientPasswordResolved({
    context: resolveClientPasswordContext(options),
    prompt: options.prompt,
  });
}
