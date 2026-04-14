import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

export interface FileLockMetadata {
  processId: number | null;
  acquiredAtUnixMs: number;
  purpose: string | null;
  walletRootId: string | null;
  [key: string]: unknown;
}

export interface FileLockHandle {
  readonly path: string;
  readonly metadata: FileLockMetadata;
  release(): Promise<void>;
}

export class FileLockBusyError extends Error {
  readonly lockPath: string;
  readonly existingMetadata: FileLockMetadata | null;

  constructor(lockPath: string, existingMetadata: FileLockMetadata | null) {
    super(`file_lock_busy_${lockPath}`);
    this.name = "FileLockBusyError";
    this.lockPath = lockPath;
    this.existingMetadata = existingMetadata;
  }
}

export async function readLockMetadata(
  lockPath: string,
): Promise<FileLockMetadata | null> {
  try {
    const raw = await readFile(lockPath, "utf8");
    return JSON.parse(raw) as FileLockMetadata;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function clearLockIfOwnedByCurrentProcess(
  lockPath: string,
): Promise<boolean> {
  const metadata = await readLockMetadata(lockPath);

  if (metadata === null || metadata.processId !== (process.pid ?? null)) {
    return false;
  }

  await rm(lockPath, { force: true });
  return true;
}

export async function acquireFileLock(
  lockPath: string,
  metadata: Partial<FileLockMetadata> = {},
): Promise<FileLockHandle> {
  await mkdir(dirname(lockPath), { recursive: true });

  const fullMetadata: FileLockMetadata = {
    processId: process.pid ?? null,
    acquiredAtUnixMs: Date.now(),
    purpose: metadata.purpose ?? null,
    walletRootId: metadata.walletRootId ?? null,
    ...metadata,
  };

  let handle;

  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new FileLockBusyError(lockPath, await readLockMetadata(lockPath));
    }

    throw error;
  }

  try {
    await handle.writeFile(`${JSON.stringify(fullMetadata, null, 2)}\n`);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
    throw error;
  }

  await handle.close();

  return {
    path: lockPath,
    metadata: fullMetadata,
    async release(): Promise<void> {
      await rm(lockPath, { force: true });
    },
  };
}
