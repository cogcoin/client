import { acquireFileLock, FileLockBusyError } from "../wallet/fs/lock.js";

export const DEFAULT_MANAGED_BITCOIND_STARTUP_TIMEOUT_MS = 60_000;
export const DEFAULT_MANAGED_BITCOIND_SHUTDOWN_TIMEOUT_MS = 15_000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function isManagedBitcoindProcessAlive(pid: number | null): Promise<boolean> {
  if (pid === null) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }

    return true;
  }
}

export async function waitForManagedBitcoindProcessExit(
  pid: number,
  timeoutMs: number,
  errorCode: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!await isManagedBitcoindProcessAlive(pid)) {
      return;
    }

    await sleep(250);
  }

  throw new Error(errorCode);
}

export async function acquireManagedBitcoindFileLockWithRetry(
  lockPath: string,
  metadata: Parameters<typeof acquireFileLock>[1],
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof acquireFileLock>>> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      return await acquireFileLock(lockPath, metadata);
    } catch (error) {
      if (!(error instanceof FileLockBusyError) || Date.now() >= deadline) {
        throw error;
      }

      await sleep(250);
    }
  }
}

export { FileLockBusyError };
