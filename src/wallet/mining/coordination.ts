import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { writeRuntimeStatusFile } from "../fs/status-file.js";
import type { WalletRuntimePaths } from "../runtime.js";
import { loadMiningRuntimeStatus } from "./runtime-artifacts.js";

const MINING_PREEMPTION_POLL_INTERVAL_MS = 100;
const DEFAULT_MINING_PREEMPTION_TIMEOUT_MS = 15_000;

interface MiningPreemptionRequestRecord {
  schemaVersion: 1;
  requestId: string;
  requestedAtUnixMs: number;
  reason: string;
}

interface MiningGenerationActivityRecord {
  schemaVersion: 1;
  generationActive: boolean;
  generationOwnerPid: number | null;
  runId: string | null;
  generationStartedAtUnixMs: number | null;
  generationEndedAtUnixMs: number | null;
  acknowledgedRequestId: string | null;
  updatedAtUnixMs: number;
}

export interface MiningPreemptionHandle {
  readonly requestId: string;
  release(): Promise<void>;
}

function resolveMiningPreemptionRequestPath(paths: WalletRuntimePaths): string {
  return join(paths.miningRoot, "generation-request.json");
}

function resolveMiningGenerationActivityPath(paths: WalletRuntimePaths): string {
  return join(paths.miningRoot, "generation-activity.json");
}

async function loadJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function readMiningPreemptionRequest(
  paths: WalletRuntimePaths,
): Promise<MiningPreemptionRequestRecord | null> {
  return loadJsonFile<MiningPreemptionRequestRecord>(resolveMiningPreemptionRequestPath(paths));
}

export async function readMiningGenerationActivity(
  paths: WalletRuntimePaths,
): Promise<MiningGenerationActivityRecord | null> {
  return loadJsonFile<MiningGenerationActivityRecord>(resolveMiningGenerationActivityPath(paths));
}

async function writeMiningGenerationActivity(
  paths: WalletRuntimePaths,
  snapshot: MiningGenerationActivityRecord,
): Promise<void> {
  const activityPath = resolveMiningGenerationActivityPath(paths);
  await mkdir(dirname(activityPath), { recursive: true });
  await writeRuntimeStatusFile(activityPath, snapshot);
}

async function clearMiningPreemptionRequest(paths: WalletRuntimePaths, requestId: string): Promise<void> {
  const requestPath = resolveMiningPreemptionRequestPath(paths);
  const existing = await readMiningPreemptionRequest(paths);

  if (existing?.requestId !== requestId) {
    return;
  }

  await rm(requestPath, { force: true }).catch(() => undefined);
}

export async function markMiningGenerationActive(options: {
  paths: WalletRuntimePaths;
  runId: string | null;
  pid: number | null;
}): Promise<void> {
  const request = await readMiningPreemptionRequest(options.paths);

  await writeMiningGenerationActivity(options.paths, {
    schemaVersion: 1,
    generationActive: true,
    generationOwnerPid: options.pid,
    runId: options.runId,
    generationStartedAtUnixMs: Date.now(),
    generationEndedAtUnixMs: null,
    acknowledgedRequestId: request?.requestId ?? null,
    updatedAtUnixMs: Date.now(),
  });
}

export async function markMiningGenerationInactive(options: {
  paths: WalletRuntimePaths;
  runId: string | null;
  pid: number | null;
}): Promise<void> {
  const request = await readMiningPreemptionRequest(options.paths);
  const existing = await readMiningGenerationActivity(options.paths);

  await writeMiningGenerationActivity(options.paths, {
    schemaVersion: 1,
    generationActive: false,
    generationOwnerPid: options.pid,
    runId: options.runId,
    generationStartedAtUnixMs: existing?.generationStartedAtUnixMs ?? null,
    generationEndedAtUnixMs: Date.now(),
    acknowledgedRequestId: request?.requestId ?? existing?.acknowledgedRequestId ?? null,
    updatedAtUnixMs: Date.now(),
  });
}

export async function isMiningGenerationAbortRequested(paths: WalletRuntimePaths): Promise<boolean> {
  return (await readMiningPreemptionRequest(paths)) !== null;
}

export async function requestMiningGenerationPreemption(options: {
  paths: WalletRuntimePaths;
  reason: string;
  timeoutMs?: number;
}): Promise<MiningPreemptionHandle> {
  const request: MiningPreemptionRequestRecord = {
    schemaVersion: 1,
    requestId: randomBytes(16).toString("hex"),
    requestedAtUnixMs: Date.now(),
    reason: options.reason,
  };
  const requestPath = resolveMiningPreemptionRequestPath(options.paths);
  await mkdir(dirname(requestPath), { recursive: true });
  await writeRuntimeStatusFile(requestPath, request);

  const timeoutMs = options.timeoutMs ?? DEFAULT_MINING_PREEMPTION_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const [activity, runtime] = await Promise.all([
      readMiningGenerationActivity(options.paths),
      loadMiningRuntimeStatus(options.paths.miningStatusPath).catch(() => null),
    ]);
    const generationActive = activity?.generationActive === true
      || runtime?.currentPhase === "generating"
      || runtime?.currentPhase === "scoring";
    const acknowledged = activity?.acknowledgedRequestId === request.requestId;

    if (!generationActive || acknowledged) {
      if (
        !generationActive
        && activity !== null
        && activity.acknowledgedRequestId !== request.requestId
      ) {
        await writeMiningGenerationActivity(options.paths, {
          ...activity,
          acknowledgedRequestId: request.requestId,
          updatedAtUnixMs: Date.now(),
        });
      }

      return {
        requestId: request.requestId,
        async release(): Promise<void> {
          await clearMiningPreemptionRequest(options.paths, request.requestId);
        },
      };
    }

    await sleep(MINING_PREEMPTION_POLL_INTERVAL_MS);
  }

  throw new Error("mining_preemption_timeout");
}
