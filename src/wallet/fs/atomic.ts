import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface AtomicWriteOptions {
  mode?: number;
  encoding?: BufferEncoding;
}

export interface AtomicWriteDependencies {
  platform?: NodeJS.Platform;
  rename?: typeof rename;
  rm?: typeof rm;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const WINDOWS_REPLACE_RETRY_DELAY_MS = 25;
const WINDOWS_REPLACE_RETRY_TIMEOUT_MS = 1_000;

async function fsyncDirectory(directoryPath: string): Promise<void> {
  try {
    const directoryHandle = await open(directoryPath, "r");

    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === "EINVAL" || code === "EPERM" || code === "EISDIR" || code === "ENOTSUP") {
        return;
      }
    }

    throw error;
  }
}

function isRetryableWindowsReplaceError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function replaceFileAtomicWithRetryForTesting(
  tempPath: string,
  filePath: string,
  dependencies: AtomicWriteDependencies = {},
): Promise<void> {
  const renameImpl = dependencies.rename ?? rename;

  if ((dependencies.platform ?? process.platform) !== "win32") {
    await renameImpl(tempPath, filePath);
    return;
  }

  const nowImpl = dependencies.now ?? Date.now;
  const sleepImpl = dependencies.sleep ?? sleep;
  const deadline = nowImpl() + WINDOWS_REPLACE_RETRY_TIMEOUT_MS;

  while (true) {
    try {
      await renameImpl(tempPath, filePath);
      return;
    } catch (error) {
      if (!isRetryableWindowsReplaceError(error) || nowImpl() >= deadline) {
        throw error;
      }

      await sleepImpl(WINDOWS_REPLACE_RETRY_DELAY_MS);
    }
  }
}

export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
  dependencies: AtomicWriteDependencies = {},
): Promise<void> {
  const directoryPath = dirname(filePath);
  const tempPath = join(directoryPath, `${basename(filePath)}.tmp-${randomUUID()}`);

  await mkdir(directoryPath, { recursive: true });

  const handle = await open(tempPath, "wx", options.mode ?? 0o600);

  try {
    if (typeof data === "string") {
      await handle.writeFile(data, { encoding: options.encoding ?? "utf8" });
    } else {
      await handle.writeFile(data);
    }

    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await replaceFileAtomicWithRetryForTesting(tempPath, filePath, dependencies);
  } catch (error) {
    await (dependencies.rm ?? rm)(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await fsyncDirectory(directoryPath);
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  options: AtomicWriteOptions = {},
  dependencies: AtomicWriteDependencies = {},
): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, options, dependencies);
}
