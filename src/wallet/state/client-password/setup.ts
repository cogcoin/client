import { mkdir } from "node:fs/promises";

import {
  createClientPasswordState,
  zeroizeBuffer,
} from "./crypto.js";
import { writeClientPasswordState } from "./files.js";
import { migrateReferencedSecrets } from "./migration.js";
import { promptForNewPassword } from "./prompts.js";
import { inspectClientPasswordReadinessResolved } from "./readiness.js";
import { resolveClientPasswordPromptSessionPolicy } from "./session-policy.js";
import { finalizePendingClientPasswordRotationIfNeeded } from "./rotation.js";
import { startClientPasswordSessionResolved } from "./session.js";
import type {
  ClientPasswordPrompt,
  ClientPasswordResolvedContext,
  ClientPasswordSessionStatus,
  ClientPasswordSetupAction,
} from "./types.js";
import { readClientPasswordSessionStatusResolved } from "./session.js";

export async function ensureClientPasswordConfiguredResolved(options: {
  context: ClientPasswordResolvedContext;
  prompt: ClientPasswordPrompt;
}): Promise<{ action: ClientPasswordSetupAction; session: ClientPasswordSessionStatus }> {
  await finalizePendingClientPasswordRotationIfNeeded(options.context);
  const readiness = await inspectClientPasswordReadinessResolved(options.context);

  if (readiness === "ready") {
    return {
      action: "already-configured",
      session: await readClientPasswordSessionStatusResolved(options.context),
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

    await mkdir(options.context.directoryPath, { recursive: true, mode: 0o700 });
    await writeClientPasswordState(options.context.passwordStatePath, created.state);

    const migrated = await migrateReferencedSecrets({
      ...options.context,
      derivedKey,
    });

    const session = await startClientPasswordSessionResolved({
      ...options.context,
      derivedKey,
      sessionPolicy: resolveClientPasswordPromptSessionPolicy(options.prompt),
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
