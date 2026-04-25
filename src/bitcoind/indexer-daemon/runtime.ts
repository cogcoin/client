import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import type net from "node:net";

import type { GenesisParameters } from "@cogcoin/indexer/types";

import { DEFAULT_SNAPSHOT_METADATA } from "../bootstrap.js";
import { createBootstrapProgress } from "../progress/formatting.js";
import { resolveManagedServicePaths } from "../service-paths.js";
import { UNINITIALIZED_WALLET_ROOT_ID } from "../service-paths.js";
import type { ManagedIndexerDaemonStatus } from "../types.js";
import {
  pauseBackgroundFollow,
  recordBackgroundFollowFailure,
  resumeBackgroundFollow,
  withTimeout,
} from "./background-follow.js";
import { createIndexerDaemonServer } from "./server.js";
import {
  buildIndexerDaemonStatus,
  deriveIndexerDaemonLeaseState,
  observeIndexerAppliedTip,
  readCoreTipStatus,
  refreshIndexerDaemonStatus,
  writeIndexerDaemonStatus,
} from "./status.js";
import {
  closeSnapshotLease,
  createSnapshotHandle,
  loadSnapshotMaterial,
  pruneExpiredSnapshotLeases,
  readSnapshotLease,
  storeSnapshotLease,
} from "./snapshot-leases.js";
import type { IndexerDaemonRuntimeState, IndexerSnapshotHandle, IndexerSnapshotPayload } from "./types.js";

const SNAPSHOT_TTL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 1_000;
const FORCE_RESUME_ERROR_ENV = "COGCOIN_TEST_INDEXER_DAEMON_FORCE_RESUME_ERROR";
const BACKGROUND_FOLLOW_RESUME_TIMEOUT_MS = 30_000;
const BACKGROUND_FOLLOW_RESUME_TIMEOUT_ERROR = "indexer_daemon_background_follow_resume_timeout";

export interface ManagedIndexerDaemonRuntime {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  getStatus(): ManagedIndexerDaemonStatus;
}

export function createIndexerDaemonRuntime(options: {
  dataDir: string;
  databasePath: string;
  walletRootId?: string;
  paths?: ReturnType<typeof resolveManagedServicePaths>;
  binaryVersion: string;
  genesisParameters: GenesisParameters;
  daemonInstanceId?: string;
  startedAtUnixMs?: number;
  snapshotTtlMs?: number;
  heartbeatIntervalMs?: number;
  backgroundFollowResumeTimeoutMs?: number;
  backgroundFollowResumeTimeoutError?: string;
  forceResumeErrorEnv?: string;
}): ManagedIndexerDaemonRuntime {
  const walletRootId = options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;
  const paths = options.paths ?? resolveManagedServicePaths(options.dataDir, walletRootId);
  const snapshotTtlMs = options.snapshotTtlMs ?? SNAPSHOT_TTL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const backgroundFollowResumeTimeoutMs = options.backgroundFollowResumeTimeoutMs ?? BACKGROUND_FOLLOW_RESUME_TIMEOUT_MS;
  const backgroundFollowResumeTimeoutError = options.backgroundFollowResumeTimeoutError
    ?? BACKGROUND_FOLLOW_RESUME_TIMEOUT_ERROR;
  const forceResumeErrorEnv = options.forceResumeErrorEnv ?? FORCE_RESUME_ERROR_ENV;
  const startedAtUnixMs = options.startedAtUnixMs ?? Date.now();
  const state: IndexerDaemonRuntimeState = {
    daemonInstanceId: options.daemonInstanceId ?? randomUUID(),
    binaryVersion: options.binaryVersion,
    startedAtUnixMs,
    walletRootId,
    snapshots: new Map(),
    state: "starting",
    heartbeatAtUnixMs: startedAtUnixMs,
    updatedAtUnixMs: startedAtUnixMs,
    rpcReachable: false,
    coreBestHeight: null,
    coreBestHash: null,
    appliedTipHeight: null,
    appliedTipHash: null,
    snapshotSeqCounter: 0,
    snapshotSeq: null,
    lastSnapshotKey: undefined,
    lastAppliedAtUnixMs: null,
    lastError: null,
    hasSuccessfulCoreTipRefresh: false,
    backgroundStore: null,
    backgroundClient: null,
    backgroundResumePromise: null,
    backgroundFollowError: null,
    backgroundFollowActive: false,
    bootstrapPhase: "paused",
    bootstrapProgress: createBootstrapProgress("paused", DEFAULT_SNAPSHOT_METADATA),
    cogcoinSyncHeight: null,
    cogcoinSyncTargetHeight: null,
  };

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let server: net.Server | null = null;
  let shutdownPromise: Promise<void> | null = null;

  const writeStatus = async (): Promise<ManagedIndexerDaemonStatus> => writeIndexerDaemonStatus(paths, state);

  const openSnapshot = async (): Promise<IndexerSnapshotHandle> => {
    const [snapshotMaterial, coreStatus] = await Promise.all([
      loadSnapshotMaterial(options.databasePath, snapshotTtlMs),
      readCoreTipStatus(paths),
    ]);
    const now = Date.now();
    state.heartbeatAtUnixMs = now;
    state.updatedAtUnixMs = now;
    state.rpcReachable = coreStatus.rpcReachable;
    state.coreBestHeight = coreStatus.coreBestHeight;
    state.coreBestHash = coreStatus.coreBestHash;
    observeIndexerAppliedTip(state, snapshotMaterial.tip, now);
    const leaseState = deriveIndexerDaemonLeaseState({
      coreStatus,
      appliedTip: snapshotMaterial.tip,
      hasSuccessfulCoreTipRefresh: state.hasSuccessfulCoreTipRefresh,
    });
    state.hasSuccessfulCoreTipRefresh = leaseState.hasSuccessfulCoreTipRefresh;
    state.state = leaseState.state;
    state.lastError = leaseState.lastError;
    const snapshot = storeSnapshotLease({
      state,
      material: snapshotMaterial,
      nowUnixMs: now,
    });
    const status = await writeStatus();
    return createSnapshotHandle({
      snapshot,
      status,
      binaryVersion: state.binaryVersion,
    });
  };

  const readSnapshot = async (token?: string): Promise<IndexerSnapshotPayload> => {
    const result = readSnapshotLease({
      state,
      token,
    });

    if (result.changed) {
      await writeStatus();
    }

    if (result.error !== null || result.payload === null) {
      throw new Error(result.error ?? "indexer_daemon_snapshot_invalid");
    }

    return result.payload;
  };

  const closeSnapshot = async (token?: string): Promise<void> => {
    if (closeSnapshotLease(state, token)) {
      await writeStatus();
    }
  };

  const resumeFollow = async (): Promise<void> => {
    try {
      await withTimeout(
        resumeBackgroundFollow({
          dataDir: options.dataDir,
          databasePath: options.databasePath,
          walletRootId,
          paths,
          state,
          genesisParameters: options.genesisParameters,
          forceResumeErrorEnv,
          writeStatus,
        }),
        backgroundFollowResumeTimeoutMs,
        backgroundFollowResumeTimeoutError,
      );
    } catch (error) {
      if (
        error instanceof Error
        && error.message === backgroundFollowResumeTimeoutError
      ) {
        await recordBackgroundFollowFailure({
          state,
          message: error.message,
          writeStatus,
        }).catch(() => undefined);
      }
      throw error;
    }
  };

  const tick = () => {
    void refreshIndexerDaemonStatus({
      databasePath: options.databasePath,
      paths,
      state,
    }).catch(() => undefined);

    const now = Date.now();
    if (pruneExpiredSnapshotLeases(state, now)) {
      void writeStatus();
    }
  };

  return {
    getStatus() {
      return buildIndexerDaemonStatus(state);
    },
    async start(): Promise<void> {
      if (server !== null) {
        return;
      }

      await mkdir(paths.indexerServiceRoot, { recursive: true });
      await rm(paths.indexerDaemonSocketPath, { force: true }).catch(() => undefined);

      server = createIndexerDaemonServer({
        getStatus: () => buildIndexerDaemonStatus(state),
        openSnapshot,
        readSnapshot,
        closeSnapshot,
        resumeBackgroundFollow: resumeFollow,
      });

      heartbeat = setInterval(tick, heartbeatIntervalMs);
      heartbeat.unref();

      await new Promise<void>((resolve, reject) => {
        server?.once("error", reject);
        server?.listen(paths.indexerDaemonSocketPath, async () => {
          server?.off("error", reject);
          await writeStatus();
          await refreshIndexerDaemonStatus({
            databasePath: options.databasePath,
            paths,
            state,
          }).catch(() => undefined);
          resolve();
        });
      });
    },
    async shutdown(): Promise<void> {
      if (shutdownPromise !== null) {
        return shutdownPromise;
      }

      shutdownPromise = (async () => {
        if (heartbeat !== null) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        await pauseBackgroundFollow({ state }).catch(() => undefined);
        state.state = "stopping";
        state.heartbeatAtUnixMs = Date.now();
        state.updatedAtUnixMs = state.heartbeatAtUnixMs;
        await writeStatus().catch(() => undefined);
        if (server !== null) {
          await new Promise<void>((resolve) => {
            server?.close(() => resolve());
          });
          server = null;
        }
        await rm(paths.indexerDaemonSocketPath, { force: true }).catch(() => undefined);
      })();

      return shutdownPromise;
    },
  };
}
