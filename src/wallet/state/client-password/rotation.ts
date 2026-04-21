import { mkdir, rm } from "node:fs/promises";

import { resolveLocalSecretFilePath } from "./context.js";
import {
  createClientPasswordState,
  createWrappedSecretEnvelope,
  decryptWrappedSecretEnvelope,
  zeroizeBuffer,
} from "./crypto.js";
import {
  loadClientPasswordRotationJournalOrNull,
  readLocalSecretFile,
  writeClientPasswordRotationJournal,
  writeClientPasswordState,
  writeWrappedSecretEnvelope,
} from "./files.js";
import { collectReferencedSecretIds } from "./references.js";
import {
  promptForNewPassword,
  promptForVerifiedClientPassword,
} from "./prompts.js";
import {
  resolveClientPasswordPromptSessionPolicy,
  resolvePostChangeClientPasswordUnlockUntilUnixMs,
} from "./session-policy.js";
import {
  readClientPasswordSessionStatusResolved,
  startClientPasswordSessionWithExpiryResolved,
} from "./session.js";
import type {
  ClientPasswordPrompt,
  ClientPasswordResolvedContext,
  ClientPasswordRotationJournalV1,
  ClientPasswordSessionStatus,
} from "./types.js";

export async function finalizePendingClientPasswordRotationIfNeeded(
  context: ClientPasswordResolvedContext,
): Promise<void> {
  const journal = await loadClientPasswordRotationJournalOrNull(context.rotationJournalPath);

  if (journal === null) {
    return;
  }

  await mkdir(context.directoryPath, { recursive: true, mode: 0o700 });

  for (const secretEntry of journal.secrets) {
    await writeWrappedSecretEnvelope(
      resolveLocalSecretFilePath(context.directoryPath, secretEntry.keyId),
      secretEntry.envelope,
    );
  }

  await writeClientPasswordState(context.passwordStatePath, journal.nextState);
  await rm(context.rotationJournalPath, { force: true });
}

async function prepareClientPasswordRotation(options: ClientPasswordResolvedContext & {
  currentDerivedKey: Uint8Array;
  newPasswordBytes: Uint8Array;
  newPasswordHint: string;
}): Promise<{
  journal: ClientPasswordRotationJournalV1;
  newDerivedKey: Buffer;
}> {
  const next = await createClientPasswordState({
    passwordBytes: options.newPasswordBytes,
    passwordHint: options.newPasswordHint,
  });
  const keyIds = await collectReferencedSecretIds(options.stateRoot);
  const secrets: ClientPasswordRotationJournalV1["secrets"] = [];

  try {
    for (const keyId of keyIds) {
      const localState = await readLocalSecretFile(resolveLocalSecretFilePath(options.directoryPath, keyId));

      if (localState.state === "missing") {
        throw new Error(`wallet_secret_missing_${keyId}`);
      }

      if (localState.state === "raw") {
        throw new Error("wallet_client_password_migration_required");
      }

      const secret = decryptWrappedSecretEnvelope(localState.envelope, options.currentDerivedKey);

      try {
        secrets.push({
          keyId,
          envelope: createWrappedSecretEnvelope(secret, next.derivedKey),
        });
      } finally {
        zeroizeBuffer(secret);
      }
    }

    return {
      journal: {
        format: "cogcoin-client-password-rotation",
        version: 1,
        nextState: next.state,
        secrets,
      },
      newDerivedKey: next.derivedKey,
    };
  } catch (error) {
    zeroizeBuffer(next.derivedKey);
    throw error;
  }
}

export async function changeClientPasswordResolved(options: {
  context: ClientPasswordResolvedContext;
  prompt: ClientPasswordPrompt;
}): Promise<ClientPasswordSessionStatus> {
  await finalizePendingClientPasswordRotationIfNeeded(options.context);
  const previousSession = await readClientPasswordSessionStatusResolved(options.context);
  const currentDerivedKey = await promptForVerifiedClientPassword({
    context: options.context,
    prompt: options.prompt,
    promptMessage: "Current client password: ",
    ttyErrorCode: "wallet_client_password_change_requires_tty",
  });
  const nextPassword = await promptForNewPassword(options.prompt);
  let newDerivedKey: Buffer | null = null;

  try {
    const prepared = await prepareClientPasswordRotation({
      ...options.context,
      currentDerivedKey,
      newPasswordBytes: nextPassword.passwordBytes,
      newPasswordHint: nextPassword.passwordHint,
    });
    newDerivedKey = prepared.newDerivedKey;

    await mkdir(options.context.directoryPath, { recursive: true, mode: 0o700 });
    await writeClientPasswordRotationJournal(
      options.context.rotationJournalPath,
      prepared.journal,
    );
    await finalizePendingClientPasswordRotationIfNeeded(options.context);

    const session = await startClientPasswordSessionWithExpiryResolved({
      ...options.context,
      derivedKey: newDerivedKey,
      unlockUntilUnixMs: resolvePostChangeClientPasswordUnlockUntilUnixMs(
        previousSession,
        resolveClientPasswordPromptSessionPolicy(options.prompt),
      ),
    });
    newDerivedKey = null;
    return session;
  } finally {
    zeroizeBuffer(currentDerivedKey);
    zeroizeBuffer(nextPassword.passwordBytes);
    zeroizeBuffer(newDerivedKey);
  }
}
