import { readFile, rm } from "node:fs/promises";

import { writeJsonFileAtomic } from "../fs/atomic.js";
import type { WalletExplicitLockStateV1 } from "../types.js";

export async function loadWalletExplicitLock(
  lockPath: string,
): Promise<WalletExplicitLockStateV1 | null> {
  try {
    return JSON.parse(await readFile(lockPath, "utf8")) as WalletExplicitLockStateV1;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function saveWalletExplicitLock(
  lockPath: string,
  state: WalletExplicitLockStateV1,
): Promise<void> {
  await writeJsonFileAtomic(lockPath, state, { mode: 0o600 });
}

export async function clearWalletExplicitLock(lockPath: string): Promise<void> {
  await rm(lockPath, { force: true });
}
