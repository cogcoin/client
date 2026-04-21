import { mkdir, rm } from "node:fs/promises";

import { createRuntimeError, resolveLocalSecretFilePath } from "./context.js";
import {
  loadClientPasswordStateOrNull,
  readLocalSecretFile,
  writeWrappedSecretEnvelope,
} from "./files.js";
import { legacyMacKeychainHasSecret } from "./readiness.js";
import { finalizePendingClientPasswordRotationIfNeeded } from "./rotation.js";
import {
  decryptClientProtectedSecretWithSessionResolved,
  encryptClientProtectedSecretWithSessionResolved,
  unlockClientPasswordSessionResolved,
} from "./session.js";
import type {
  ClientPasswordPrompt,
  ClientPasswordResolvedContext,
} from "./types.js";

async function decryptWrappedSecretWithSessionResolved(options: ClientPasswordResolvedContext & {
  envelope: {
    format: "cogcoin-local-wallet-secret";
    version: 1;
    cipher: "aes-256-gcm";
    wrappedBy: "client-password";
    nonce: string;
    tag: string;
    ciphertext: string;
  };
  prompt?: ClientPasswordPrompt;
}): Promise<Uint8Array> {
  let secret = decryptClientProtectedSecretWithSessionResolved(options, options.envelope);

  if (secret === null && options.prompt != null && options.prompt.isInteractive) {
    await unlockClientPasswordSessionResolved({
      context: options,
      prompt: options.prompt,
    });
    secret = decryptClientProtectedSecretWithSessionResolved(options, options.envelope);
  }

  if (secret === null) {
    throw new Error("wallet_client_password_locked");
  }

  return secret;
}

async function encryptWrappedSecretWithSessionResolved(options: ClientPasswordResolvedContext & {
  secret: Uint8Array;
  prompt?: ClientPasswordPrompt;
}): Promise<{
  format: "cogcoin-local-wallet-secret";
  version: 1;
  cipher: "aes-256-gcm";
  wrappedBy: "client-password";
  nonce: string;
  tag: string;
  ciphertext: string;
}> {
  let envelope = encryptClientProtectedSecretWithSessionResolved(options, options.secret);

  if (envelope === null && options.prompt != null && options.prompt.isInteractive) {
    await unlockClientPasswordSessionResolved({
      context: options,
      prompt: options.prompt,
    });
    envelope = encryptClientProtectedSecretWithSessionResolved(options, options.secret);
  }

  if (envelope === null) {
    throw new Error("wallet_client_password_locked");
  }

  return envelope;
}

export async function loadClientProtectedSecretResolved(options: ClientPasswordResolvedContext & {
  keyId: string;
  prompt?: ClientPasswordPrompt;
}): Promise<Uint8Array> {
  try {
    await finalizePendingClientPasswordRotationIfNeeded(options);
    const passwordState = await loadClientPasswordStateOrNull(options.passwordStatePath);
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

    return await decryptWrappedSecretWithSessionResolved({
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

export async function storeClientProtectedSecretResolved(options: ClientPasswordResolvedContext & {
  keyId: string;
  secret: Uint8Array;
  prompt?: ClientPasswordPrompt;
}): Promise<void> {
  try {
    await finalizePendingClientPasswordRotationIfNeeded(options);
    const passwordState = await loadClientPasswordStateOrNull(options.passwordStatePath);

    if (passwordState === null) {
      throw new Error("wallet_client_password_setup_required");
    }

    await mkdir(options.directoryPath, { recursive: true, mode: 0o700 });
    const envelope = await encryptWrappedSecretWithSessionResolved(options);
    await writeWrappedSecretEnvelope(resolveLocalSecretFilePath(options.directoryPath, options.keyId), envelope);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.startsWith("wallet_client_password_")) {
      throw error;
    }

    throw createRuntimeError(options.runtimeErrorCode, error);
  }
}

export async function deleteClientProtectedSecretResolved(options: ClientPasswordResolvedContext & {
  keyId: string;
}): Promise<void> {
  await rm(resolveLocalSecretFilePath(options.directoryPath, options.keyId), { force: true }).catch(() => undefined);
}
