import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { writeRuntimeStatusFile } from "../fs/status-file.js";
import { resolveCorePublishStateNote } from "./publishability.js";
import { normalizeMiningLifecycleStatus, normalizeMiningPublishState } from "./state.js";
import type { MiningEventRecord, MiningRuntimeStatusV1 } from "./types.js";

const MAX_EVENT_LOG_BYTES = 10 * 1024 * 1024;
const MAX_EVENT_LOG_ROTATIONS = 4;
const miningStatusWriteQueues = new Map<string, Promise<void>>();

export interface MiningRuntimeTipStatusRefresh {
  indexerDaemonState?: MiningRuntimeStatusV1["indexerDaemonState"];
  indexerDaemonInstanceId?: string | null;
  indexerSnapshotSeq?: string | null;
  indexerSnapshotOpenedAtUnixMs?: number | null;
  indexerTruthSource?: MiningRuntimeStatusV1["indexerTruthSource"];
  indexerHeartbeatAtUnixMs?: number | null;
  coreBestHeight?: number | null;
  coreBestHash?: string | null;
  indexerTipHeight?: number | null;
  indexerTipHash?: string | null;
  indexerStatusTipHeight?: number | null;
  indexerStatusTipHash?: string | null;
  indexerObservedAtUnixMs?: number | null;
  indexerReorgDepth?: number | null;
  indexerTipAligned?: boolean | null;
  corePublishState?: MiningRuntimeStatusV1["corePublishState"];
  targetBlockHeight?: number | null;
  referencedBlockHashDisplay?: string | null;
  attemptTargetBlockHeight?: number | null;
  attemptReferencedBlockHashDisplay?: string | null;
  attemptIndexerSnapshotSeq?: string | null;
}

export function resolveRotatedMiningEventsPath(eventsPath: string): string {
  return `${eventsPath}.1`;
}

function resolveIndexedRotatedMiningEventsPath(eventsPath: string, index: number): string {
  return `${eventsPath}.${index}`;
}

function normalizeLegacyMiningProviderState(
  raw: unknown,
): MiningRuntimeStatusV1["providerState"] {
  switch (raw) {
    case "ready":
    case "backoff":
    case "unavailable":
    case "rate-limited":
    case "auth-error":
    case "not-found":
      return raw;
    case "hook-error":
    case "n/a":
      return "unavailable";
    default:
      return null;
  }
}

export async function loadMiningRuntimeStatus(
  statusPath: string,
): Promise<MiningRuntimeStatusV1 | null> {
  try {
    const raw = await readFile(statusPath, "utf8");
    const parsed = JSON.parse(raw) as MiningRuntimeStatusV1 & {
      currentPublishState?: string | null;
      miningState?: string | null;
      livePublishInMempool?: boolean | null;
      liveMiningFamilyInMempool?: boolean | null;
    };
    const livePublishInMempool = parsed.livePublishInMempool ?? parsed.liveMiningFamilyInMempool ?? null;
    return {
      ...parsed,
      foregroundPid: parsed.foregroundPid ?? null,
      foregroundRunId: parsed.foregroundRunId ?? null,
      foregroundHeartbeatAtUnixMs: parsed.foregroundHeartbeatAtUnixMs ?? null,
      miningState: normalizeMiningLifecycleStatus(parsed.miningState),
      providerState: normalizeLegacyMiningProviderState(parsed.providerState),
      currentPublishState: normalizeMiningPublishState(parsed.currentPublishState),
      livePublishInMempool,
      readinessBlocker: parsed.readinessBlocker ?? null,
      indexerStatusTipHeight: parsed.indexerStatusTipHeight ?? null,
      indexerStatusTipHash: parsed.indexerStatusTipHash ?? null,
      indexerObservedAtUnixMs: parsed.indexerObservedAtUnixMs ?? null,
      indexerReorgDepth: parsed.indexerReorgDepth ?? null,
      attemptTargetBlockHeight: parsed.attemptTargetBlockHeight ?? parsed.targetBlockHeight ?? null,
      attemptReferencedBlockHashDisplay: parsed.attemptReferencedBlockHashDisplay ?? parsed.referencedBlockHashDisplay ?? null,
      attemptIndexerSnapshotSeq: parsed.attemptIndexerSnapshotSeq ?? parsed.indexerSnapshotSeq ?? null,
      livePublishTargetBlockHeight: parsed.livePublishTargetBlockHeight
        ?? (livePublishInMempool === true ? parsed.targetBlockHeight ?? null : null),
      livePublishReferencedBlockHashDisplay: parsed.livePublishReferencedBlockHashDisplay
        ?? (livePublishInMempool === true ? parsed.referencedBlockHashDisplay ?? null : null),
      livePublishTxid: parsed.livePublishTxid ?? (livePublishInMempool === true ? parsed.currentTxid ?? null : null),
      livePublishDecision: parsed.livePublishDecision
        ?? (livePublishInMempool === true ? parsed.currentPublishDecision ?? null : null),
      livePublishStaleToCoreTip: parsed.livePublishStaleToCoreTip ?? null,
      cycleStartedAtUnixMs: parsed.cycleStartedAtUnixMs ?? null,
      phaseEnteredAtUnixMs: parsed.phaseEnteredAtUnixMs ?? null,
      sameDomainCompetitorSuppressed: parsed.sameDomainCompetitorSuppressed ?? null,
      dedupedCompetitorDomainCount: parsed.dedupedCompetitorDomainCount ?? null,
      competitivenessGateIndeterminate: parsed.competitivenessGateIndeterminate ?? null,
      competitivenessGateReason: parsed.competitivenessGateReason ?? null,
      competitivenessGateDiagnostics: parsed.competitivenessGateDiagnostics ?? null,
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
  await runSerializedMiningStatusWrite(statusPath, async () => {
    await writeMiningRuntimeStatusSnapshot(statusPath, snapshot);
  });
}

async function runSerializedMiningStatusWrite<T>(
  statusPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = miningStatusWriteQueues.get(statusPath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  let cleanup: Promise<void>;
  cleanup = current.then(
    () => undefined,
    () => undefined,
  ).then(() => {
    if (miningStatusWriteQueues.get(statusPath) === cleanup) {
      miningStatusWriteQueues.delete(statusPath);
    }
  });

  miningStatusWriteQueues.set(statusPath, cleanup);
  return await current;
}

async function writeMiningRuntimeStatusSnapshot(
  statusPath: string,
  snapshot: MiningRuntimeStatusV1,
): Promise<void> {
  await writeRuntimeStatusFile(statusPath, {
    ...snapshot,
    providerState: normalizeLegacyMiningProviderState(snapshot.providerState),
  });
}

export async function saveForegroundMiningHeartbeatStatus(options: {
  statusPath: string;
  foregroundPid: number;
  foregroundRunId: string;
  heartbeatAtUnixMs: number;
  tipStatus?: MiningRuntimeTipStatusRefresh | null;
}): Promise<MiningRuntimeStatusV1 | null> {
  return await runSerializedMiningStatusWrite(options.statusPath, async () => {
    const snapshot = await loadMiningRuntimeStatus(options.statusPath);

    if (
      snapshot === null
      || snapshot.runMode !== "foreground"
      || snapshot.foregroundRunId !== options.foregroundRunId
    ) {
      return snapshot;
    }

    const currentHeartbeatAtUnixMs = snapshot.foregroundHeartbeatAtUnixMs ?? null;
    if (currentHeartbeatAtUnixMs !== null && currentHeartbeatAtUnixMs > options.heartbeatAtUnixMs) {
      return snapshot;
    }

    const tipStatus = options.tipStatus ?? {};
    const waitingBitcoinNetwork = snapshot.currentPhase === "waiting-bitcoin-network"
      && snapshot.readinessBlocker === "bitcoin-core";
    const publishabilityRecovered = waitingBitcoinNetwork && tipStatus.corePublishState === "healthy";
    const publishabilityNote = waitingBitcoinNetwork && tipStatus.corePublishState !== undefined
      ? resolveCorePublishStateNote(tipStatus.corePublishState)
      : null;
    const waitingBitcoinNetworkPatch: Partial<MiningRuntimeStatusV1> = publishabilityRecovered
      ? {
        currentPhase: "idle",
        readinessBlocker: null,
        note: null,
      }
      : publishabilityNote !== null
        ? {
          currentPhase: "waiting-bitcoin-network",
          readinessBlocker: "bitcoin-core",
          note: publishabilityNote,
        }
        : {};

    const nextSnapshot: MiningRuntimeStatusV1 = {
      ...snapshot,
      ...tipStatus,
      ...waitingBitcoinNetworkPatch,
      foregroundPid: options.foregroundPid,
      foregroundRunId: options.foregroundRunId,
      foregroundHeartbeatAtUnixMs: options.heartbeatAtUnixMs,
    };
    await writeMiningRuntimeStatusSnapshot(options.statusPath, nextSnapshot);
    return nextSnapshot;
  });
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
