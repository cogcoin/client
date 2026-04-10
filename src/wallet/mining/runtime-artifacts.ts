import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { writeRuntimeStatusFile } from "../fs/status-file.js";
import { normalizeMiningFamilyStatus, normalizeMiningPublishState } from "./state.js";
import type { MiningEventRecord, MiningRuntimeStatusV1 } from "./types.js";

const MAX_EVENT_LOG_BYTES = 10 * 1024 * 1024;
const MAX_EVENT_LOG_ROTATIONS = 4;

export function resolveRotatedMiningEventsPath(eventsPath: string): string {
  return `${eventsPath}.1`;
}

function resolveIndexedRotatedMiningEventsPath(eventsPath: string, index: number): string {
  return `${eventsPath}.${index}`;
}

export async function loadMiningRuntimeStatus(
  statusPath: string,
): Promise<MiningRuntimeStatusV1 | null> {
  try {
    const raw = await readFile(statusPath, "utf8");
    const parsed = JSON.parse(raw) as MiningRuntimeStatusV1 & {
      currentPublishState?: string | null;
      miningState?: string | null;
    };
    return {
      ...parsed,
      miningState: normalizeMiningFamilyStatus(parsed.miningState),
      currentPublishState: normalizeMiningPublishState(parsed.currentPublishState),
      indexerReorgDepth: parsed.indexerReorgDepth ?? null,
      sameDomainCompetitorSuppressed: parsed.sameDomainCompetitorSuppressed ?? null,
      dedupedCompetitorDomainCount: parsed.dedupedCompetitorDomainCount ?? null,
      competitivenessGateIndeterminate: parsed.competitivenessGateIndeterminate ?? null,
      mempoolSequenceCacheStatus: parsed.mempoolSequenceCacheStatus ?? null,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function saveMiningRuntimeStatus(
  statusPath: string,
  snapshot: MiningRuntimeStatusV1,
): Promise<void> {
  await writeRuntimeStatusFile(statusPath, snapshot);
}

async function rotateMiningEventsIfNeeded(eventsPath: string, nextEntryBytes: number): Promise<void> {
  try {
    const current = await stat(eventsPath);

    if ((current.size + nextEntryBytes) <= MAX_EVENT_LOG_BYTES) {
      return;
    }

    for (let index = MAX_EVENT_LOG_ROTATIONS; index >= 1; index -= 1) {
      const sourcePath = index === 1
        ? eventsPath
        : resolveIndexedRotatedMiningEventsPath(eventsPath, index - 1);
      const destinationPath = resolveIndexedRotatedMiningEventsPath(eventsPath, index);

      if (index === MAX_EVENT_LOG_ROTATIONS) {
        await rm(destinationPath, { force: true }).catch(() => undefined);
      }

      try {
        await rename(sourcePath, destinationPath);
      } catch (error) {
        if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }

        throw error;
      }
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }
}

export async function appendMiningEvent(
  eventsPath: string,
  event: MiningEventRecord,
): Promise<void> {
  const serialized = `${JSON.stringify(event)}\n`;
  await mkdir(dirname(eventsPath), { recursive: true });
  await rotateMiningEventsIfNeeded(eventsPath, Buffer.byteLength(serialized));
  const handle = await open(eventsPath, "a", 0o600);

  try {
    await handle.writeFile(serialized, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseMiningEventLines(raw: string): MiningEventRecord[] {
  const hasTrailingNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  const completeLines = hasTrailingNewline ? lines.slice(0, -1) : lines.slice(0, -1);
  const events: MiningEventRecord[] = [];

  for (const line of completeLines) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      continue;
    }

    try {
      events.push(JSON.parse(trimmed) as MiningEventRecord);
    } catch {
      continue;
    }
  }

  return events;
}

async function readEventFile(path: string): Promise<MiningEventRecord[]> {
  try {
    const raw = await readFile(path, "utf8");
    return parseMiningEventLines(raw);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export async function readMiningEvents(options: {
  eventsPath: string;
  limit?: number | null;
  all?: boolean;
}): Promise<MiningEventRecord[]> {
  const paths: string[] = [];

  for (let index = MAX_EVENT_LOG_ROTATIONS; index >= 1; index -= 1) {
    paths.push(resolveIndexedRotatedMiningEventsPath(options.eventsPath, index));
  }

  paths.push(options.eventsPath);

  const chunks = await Promise.all(paths.map((path) => readEventFile(path)));
  const events = chunks.flat();

  if (options.all) {
    return events;
  }

  const limit = options.limit ?? 50;
  return events.slice(Math.max(0, events.length - limit));
}

export async function getLastMiningEventTimestamp(eventsPath: string): Promise<number | null> {
  const events = await readMiningEvents({
    eventsPath,
    limit: 1,
  });
  return events.length === 0 ? null : events[0]!.timestampUnixMs;
}

export async function followMiningEvents(options: {
  eventsPath: string;
  intervalMs?: number;
  signal?: AbortSignal;
  onEvent: (event: MiningEventRecord) => void;
}): Promise<void> {
  const seen = new Set<string>();

  const recordEvents = async (): Promise<void> => {
    const events = await readMiningEvents({
      eventsPath: options.eventsPath,
      all: true,
    });

    for (const event of events) {
      const digest = createHash("sha256").update(JSON.stringify(event)).digest("hex");
      if (seen.has(digest)) {
        continue;
      }

      seen.add(digest);
      options.onEvent(event);
    }
  };

  await recordEvents();

  while (!options.signal?.aborted) {
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, options.intervalMs ?? 250);
      options.signal?.addEventListener("abort", () => {
        clearTimeout(timeout);
        resolve(undefined);
      }, { once: true });
    });

    if (options.signal?.aborted) {
      return;
    }

    await recordEvents();
  }
}
