import { writeJsonFileAtomic } from "./atomic.js";

export async function writeRuntimeStatusFile(
  statusPath: string,
  snapshot: unknown,
): Promise<void> {
  await writeJsonFileAtomic(statusPath, snapshot, { mode: 0o600 });
}
