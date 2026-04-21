import { resolveLocalSecretFilePath } from "./context.js";
import { createWrappedSecretEnvelope } from "./crypto.js";
import { readLocalSecretFile, writeWrappedSecretEnvelope } from "./files.js";
import { collectReferencedSecretIds } from "./references.js";
import type { ClientPasswordResolvedContext } from "./types.js";
import { legacyMacKeychainHasSecret } from "./readiness.js";

export async function migrateReferencedSecrets(options: ClientPasswordResolvedContext & {
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
      await writeWrappedSecretEnvelope(
        localPath,
        createWrappedSecretEnvelope(localState.secret, options.derivedKey),
      );
      migrated = true;
      continue;
    }

    if (await legacyMacKeychainHasSecret(options, keyId)) {
      try {
        const secret = await options.legacyMacKeychainReader!.loadSecret(keyId);
        await writeWrappedSecretEnvelope(
          localPath,
          createWrappedSecretEnvelope(secret, options.derivedKey),
        );
        migrated = true;
      } catch {
        // Best-effort legacy migration only.
      }
    }
  }

  return migrated;
}
