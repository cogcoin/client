import { resolveLocalSecretFilePath } from "./context.js";
import { readLocalSecretFile, loadClientPasswordStateOrNull } from "./files.js";
import { collectReferencedSecretIds } from "./references.js";
import type {
  ClientPasswordReadiness,
  ClientPasswordResolvedContext,
} from "./types.js";

export async function legacyMacKeychainHasSecret(
  context: ClientPasswordResolvedContext,
  keyId: string,
): Promise<boolean> {
  if (context.platform !== "darwin" || context.legacyMacKeychainReader == null) {
    return false;
  }

  try {
    await context.legacyMacKeychainReader.loadSecret(keyId);
    return true;
  } catch {
    return false;
  }
}

async function inspectReadinessForKey(
  context: ClientPasswordResolvedContext,
  keyId: string,
): Promise<{
  local: Awaited<ReturnType<typeof readLocalSecretFile>>;
  keychain: boolean;
}> {
  const local = await readLocalSecretFile(resolveLocalSecretFilePath(context.directoryPath, keyId));
  const keychain = await legacyMacKeychainHasSecret(context, keyId);
  return { local, keychain };
}

export async function inspectClientPasswordReadinessResolved(
  context: ClientPasswordResolvedContext,
): Promise<ClientPasswordReadiness> {
  const passwordState = await loadClientPasswordStateOrNull(context.passwordStatePath);
  const keyIds = await collectReferencedSecretIds(context.stateRoot);

  if (keyIds.length === 0) {
    return passwordState === null ? "setup-required" : "ready";
  }

  for (const keyId of keyIds) {
    const sourceState = await inspectReadinessForKey(context, keyId);

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

export function describeReadinessError(readiness: ClientPasswordReadiness): string {
  return readiness === "migration-required"
    ? "wallet_client_password_migration_required"
    : "wallet_client_password_setup_required";
}
