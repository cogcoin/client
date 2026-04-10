import { randomUUID } from "node:crypto";
import { mkdir, open, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface AtomicWriteOptions {
  mode?: number;
  encoding?: BufferEncoding;
}

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

export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
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

  await rename(tempPath, filePath);
  await fsyncDirectory(directoryPath);
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}
