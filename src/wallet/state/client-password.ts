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
export { createAgentBootstrapState } from "./client-password/bootstrap.js";
export {
  describeClientPasswordLockedMessage,
  describeClientPasswordMigrationMessage,
  describeClientPasswordSetupMessage,
} from "./client-password/messages.js";
export { listLocalSecretFilesForTesting } from "./client-password/files.js";

import { resolveClientPasswordContext } from "./client-password/context.js";
import { cleanupLegacyClientPasswordArtifactsResolved } from "./client-password/legacy-cleanup.js";
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
  ClientPasswordResolvedContext,
  ClientPasswordSessionStatus,
  ClientPasswordSetupAction,
  ClientPasswordStorageOptions,
} from "./client-password/types.js";

async function resolveCleanClientPasswordContext(
  options: ClientPasswordStorageOptions,
): Promise<ClientPasswordResolvedContext> {
  const context = resolveClientPasswordContext(options);
  await cleanupLegacyClientPasswordArtifactsResolved(context);
  return context;
}

export async function inspectClientPasswordReadiness(
  options: ClientPasswordStorageOptions,
): Promise<ClientPasswordReadiness> {
  const context = await resolveCleanClientPasswordContext(options);
  await finalizePendingClientPasswordRotationIfNeeded(context);
  return await inspectClientPasswordReadinessResolved(context);
}

export async function readClientPasswordSessionStatus(
  options: ClientPasswordStorageOptions,
): Promise<ClientPasswordSessionStatus> {
  return await readClientPasswordSessionStatusResolved(await resolveCleanClientPasswordContext(options));
}

export async function lockClientPasswordSession(
  options: ClientPasswordStorageOptions,
): Promise<ClientPasswordSessionStatus> {
  return await lockClientPasswordSessionResolved(await resolveCleanClientPasswordContext(options));
}

export async function ensureClientPasswordConfigured(options: ClientPasswordStorageOptions & {
  prompt: ClientPasswordPrompt;
}): Promise<{ action: ClientPasswordSetupAction; session: ClientPasswordSessionStatus }> {
  const context = await resolveCleanClientPasswordContext(options);
  return await ensureClientPasswordConfiguredResolved({
    context,
    prompt: options.prompt,
  });
}

export async function loadClientProtectedSecret(options: ClientPasswordStorageOptions & {
  keyId: string;
  prompt?: ClientPasswordPrompt;
}): Promise<Uint8Array> {
  const context = await resolveCleanClientPasswordContext(options);
  return await loadClientProtectedSecretResolved({
    ...context,
    keyId: options.keyId,
    prompt: options.prompt,
  });
}

export async function storeClientProtectedSecret(options: ClientPasswordStorageOptions & {
  keyId: string;
  secret: Uint8Array;
  prompt?: ClientPasswordPrompt;
}): Promise<void> {
  const context = await resolveCleanClientPasswordContext(options);
  await storeClientProtectedSecretResolved({
    ...context,
    keyId: options.keyId,
    secret: options.secret,
    prompt: options.prompt,
  });
}

export async function deleteClientProtectedSecret(options: ClientPasswordStorageOptions & {
  keyId: string;
}): Promise<void> {
  const context = await resolveCleanClientPasswordContext(options);
  await deleteClientProtectedSecretResolved({
    ...context,
    keyId: options.keyId,
  });
}

export async function unlockClientPasswordSession(options: ClientPasswordStorageOptions & {
  prompt: ClientPasswordPrompt;
}): Promise<ClientPasswordSessionStatus> {
  const context = await resolveCleanClientPasswordContext(options);
  await finalizePendingClientPasswordRotationIfNeeded(context);
  return await unlockClientPasswordSessionResolved({
    context,
    prompt: options.prompt,
  });
}

export async function changeClientPassword(options: ClientPasswordStorageOptions & {
  prompt: ClientPasswordPrompt;
}): Promise<ClientPasswordSessionStatus> {
  const context = await resolveCleanClientPasswordContext(options);
  return await changeClientPasswordResolved({
    context,
    prompt: options.prompt,
  });
}
