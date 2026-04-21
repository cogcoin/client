import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { isMissingFileError } from "./context.js";

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

export async function collectReferencedSecretIds(stateRoot: string): Promise<string[]> {
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
