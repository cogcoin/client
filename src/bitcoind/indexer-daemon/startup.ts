import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";

import { writeRuntimeStatusFile } from "../../wallet/fs/status-file.js";
import { readJsonFileIfPresent } from "../managed-runtime/status.js";
import { SQLITE_NATIVE_MODULE_UNAVAILABLE } from "./native-dependencies.js";
import type { ManagedIndexerDaemonStatus } from "../types.js";
import {
  INDEXER_DAEMON_SCHEMA_VERSION,
  INDEXER_DAEMON_SERVICE_API_VERSION,
} from "../types.js";
import type { ManagedServicePaths } from "../service-paths.js";

const STARTUP_LOG_TAIL_BYTES = 4_096;

type ChildProcessLike = {
  pid?: number;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
};

export class IndexerDaemonStartupError extends Error {
  readonly logPath: string;
  readonly logTail: string | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(message: string, options: {
    logPath: string;
    logTail?: string | null;
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    cause?: unknown;
  }) {
    super(message, { cause: options.cause });
    this.name = "IndexerDaemonStartupError";
    this.logPath = options.logPath;
    this.logTail = options.logTail ?? null;
    this.exitCode = options.exitCode ?? null;
    this.signal = options.signal ?? null;
  }
}

export function getIndexerDaemonStartupLogPath(error: unknown): string | null {
  return error instanceof IndexerDaemonStartupError ? error.logPath : null;
}

export function getIndexerDaemonStartupLogTail(error: unknown): string | null {
  return error instanceof IndexerDaemonStartupError ? error.logTail : null;
}

export async function openIndexerDaemonStartupLog(paths: ManagedServicePaths): Promise<{
  fd: number;
  logPath: string;
  close(): Promise<void>;
}> {
  await mkdir(paths.indexerServiceRoot, { recursive: true });
  const handle = await open(paths.indexerDaemonLogPath, "w", 0o600);
  await handle.writeFile([
    `Cogcoin indexer daemon startup log`,
    `pid=${process.pid}`,
    `node=${process.version}`,
    `time=${new Date().toISOString()}`,
    "",
  ].join("\n"));

  return {
    fd: handle.fd,
    logPath: paths.indexerDaemonLogPath,
    async close() {
      await handle.close();
    },
  };
}

export async function readIndexerDaemonStartupLogTail(
  logPath: string,
  maxBytes = STARTUP_LOG_TAIL_BYTES,
): Promise<string | null> {
  try {
    const bytes = await readFile(logPath);
    const tail = bytes.subarray(Math.max(0, bytes.byteLength - maxBytes));
    const text = tail.toString("utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export function classifyIndexerDaemonStartupFailure(logTail: string | null): string {
  return logTail?.includes(SQLITE_NATIVE_MODULE_UNAVAILABLE) === true
    ? SQLITE_NATIVE_MODULE_UNAVAILABLE
    : "indexer_daemon_start_failed";
}

export async function waitForIndexerDaemonStartup(options: {
  child: ChildProcessLike;
  logPath: string;
  waitForReady(): Promise<void>;
  readLogTail?: (logPath: string) => Promise<string | null>;
}): Promise<void> {
  const readLogTail = options.readLogTail ?? readIndexerDaemonStartupLogTail;
  const ready = options.waitForReady();

  const childFailure = new Promise<never>((_, reject) => {
    const onError = async (error: Error) => {
      const logTail = await readLogTail(options.logPath);
      reject(new IndexerDaemonStartupError(classifyIndexerDaemonStartupFailure(logTail), {
        logPath: options.logPath,
        logTail,
        cause: error,
      }));
    };
    const onExit = async (code: number | null, signal: NodeJS.Signals | null) => {
      const logTail = await readLogTail(options.logPath);
      reject(new IndexerDaemonStartupError(classifyIndexerDaemonStartupFailure(logTail), {
        logPath: options.logPath,
        logTail,
        exitCode: code,
        signal,
      }));
    };

    options.child.once("error", onError);
    options.child.once("exit", onExit);

    ready.then(
      () => {
        options.child.off("error", onError);
        options.child.off("exit", onExit);
      },
      () => {
        options.child.off("error", onError);
        options.child.off("exit", onExit);
      },
    );
  });

  try {
    await Promise.race([
      ready,
      childFailure,
    ]);
  } catch (error) {
    if (error instanceof IndexerDaemonStartupError) {
      throw error;
    }

    const logTail = await readLogTail(options.logPath);
    throw new IndexerDaemonStartupError(error instanceof Error ? error.message : "indexer_daemon_start_timeout", {
      logPath: options.logPath,
      logTail,
      cause: error,
    });
  }
}

export async function recordIndexerDaemonStartupFailure(options: {
  paths: ManagedServicePaths;
  walletRootId: string;
  binaryVersion: string;
  lastError: string;
  processId?: number | null;
}): Promise<void> {
  await rm(options.paths.indexerDaemonSocketPath, { force: true }).catch(() => undefined);
  await mkdir(options.paths.indexerServiceRoot, { recursive: true });
  const existing = await readJsonFileIfPresent<ManagedIndexerDaemonStatus>(
    options.paths.indexerDaemonStatusPath,
  ).catch(() => null);
  if (
    existing?.processId === (options.processId ?? null)
    && (
      existing.state === "schema-mismatch"
      || (existing.state === "failed" && existing.lastError !== null)
    )
  ) {
    return;
  }

  const now = Date.now();
  const status: ManagedIndexerDaemonStatus = {
    serviceApiVersion: INDEXER_DAEMON_SERVICE_API_VERSION,
    binaryVersion: options.binaryVersion,
    buildId: null,
    updatedAtUnixMs: now,
    walletRootId: options.walletRootId,
    daemonInstanceId: randomUUID(),
    schemaVersion: INDEXER_DAEMON_SCHEMA_VERSION,
    state: "failed",
    processId: options.processId ?? null,
    startedAtUnixMs: now,
    heartbeatAtUnixMs: now,
    ipcReady: false,
    rpcReachable: false,
    coreBestHeight: null,
    coreBestHash: null,
    appliedTipHeight: null,
    appliedTipHash: null,
    snapshotSeq: null,
    backlogBlocks: null,
    reorgDepth: null,
    lastAppliedAtUnixMs: null,
    activeSnapshotCount: 0,
    lastError: options.lastError,
    backgroundFollowActive: false,
    bootstrapPhase: "error",
    bootstrapProgress: null,
    cogcoinSyncHeight: null,
    cogcoinSyncTargetHeight: null,
  };
  await writeRuntimeStatusFile(options.paths.indexerDaemonStatusPath, status);
}
