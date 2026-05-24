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
import { assertIndexerDaemonNativeDependencies } from "./native-dependencies.js";
import { createIndexerDaemonServer } from "./server.js";
import {
  buildIndexerDaemonStatus,
  deriveIndexerDaemonLeaseState,
  observeIndexerAppliedTip,
  readAppliedTipStatus,
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
const BACKGROUND_FOLLOW_RESUME_TIMEOUT_MS = 120_000;
const BACKGROUND_FOLLOW_RESUME_TIMEOUT_ERROR = "indexer_daemon_background_follow_resume_timeout";

export interface ManagedIndexerDaemonRuntime {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  getStatus(): ManagedIndexerDaemonStatus;
}

interface IndexerDaemonRuntimeDependencies {
  assertIndexerDaemonNativeDependencies: typeof assertIndexerDaemonNativeDependencies;
  loadSnapshotMaterial: typeof loadSnapshotMaterial;
  readAppliedTipStatus: typeof readAppliedTipStatus;
  readCoreTipStatus: typeof readCoreTipStatus;
  refreshIndexerDaemonStatus: typeof refreshIndexerDaemonStatus;
  writeIndexerDaemonStatus: typeof writeIndexerDaemonStatus;
  now: () => number;
}

const DEFAULT_INDEXER_DAEMON_RUNTIME_DEPENDENCIES: IndexerDaemonRuntimeDependencies = {
  assertIndexerDaemonNativeDependencies,
  loadSnapshotMaterial,
  readAppliedTipStatus,
  readCoreTipStatus,
  refreshIndexerDaemonStatus,
  writeIndexerDaemonStatus,
  now: Date.now,
};

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
  dependencies?: Partial<IndexerDaemonRuntimeDependencies>;
}): ManagedIndexerDaemonRuntime {
  const dependencies = {
    ...DEFAULT_INDEXER_DAEMON_RUNTIME_DEPENDENCIES,
    ...options.dependencies,
  };
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
  let statusMutationQueue: Promise<void> = Promise.resolve();
  let heartbeatRefreshScheduled = false;
  let heartbeatRefreshRequested = false;

  const writeStatus = async (): Promise<ManagedIndexerDaemonStatus> => dependencies.writeIndexerDaemonStatus(paths, state);

  const enqueueStatusMutation = <T>(mutation: () => Promise<T>): Promise<T> => {
    const run = statusMutationQueue.then(mutation, mutation);
    statusMutationQueue = run.then(() => undefined, () => undefined);
    return run;
  };

  const refreshStatusAndPruneLeases = async (): Promise<void> => {
    await dependencies.refreshIndexerDaemonStatus({
      databasePath: options.databasePath,
      paths,
      state,
    }, {
      readAppliedTipStatus: dependencies.readAppliedTipStatus,
      readCoreTipStatus: dependencies.readCoreTipStatus,
      writeIndexerDaemonStatus: dependencies.writeIndexerDaemonStatus,
      now: dependencies.now,
    });

    const now = dependencies.now();
    if (pruneExpiredSnapshotLeases(state, now)) {
      await writeStatus();
    }
  };

  const requestHeartbeatRefresh = () => {
    heartbeatRefreshRequested = true;

    if (heartbeatRefreshScheduled) {
      return;
    }

    heartbeatRefreshScheduled = true;
    void (async () => {
      while (heartbeatRefreshRequested) {
        heartbeatRefreshRequested = false;
        await enqueueStatusMutation(refreshStatusAndPruneLeases);
      }
    })().catch(() => undefined).finally(() => {
      heartbeatRefreshScheduled = false;
      if (heartbeatRefreshRequested) {
        requestHeartbeatRefresh();
      }
    });
  };

  const openSnapshot = async (): Promise<IndexerSnapshotHandle> => {
    const snapshotMaterial = await dependencies.loadSnapshotMaterial(options.databasePath, snapshotTtlMs);

    return await enqueueStatusMutation(async () => {
      const coreStatus = await dependencies.readCoreTipStatus(paths);
      const now = dependencies.now();
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
    });
  };

  const readSnapshot = async (token?: string): Promise<IndexerSnapshotPayload> => {
    return await enqueueStatusMutation(async () => {
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
    });
  };

  const closeSnapshot = async (token?: string): Promise<void> => {
    await enqueueStatusMutation(async () => {
      if (closeSnapshotLease(state, token)) {
        await writeStatus();
      }
    });
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
          writeStatus: async () => enqueueStatusMutation(writeStatus),
        }),
        backgroundFollowResumeTimeoutMs,
        backgroundFollowResumeTimeoutError,
      );
    } catch (error) {
      if (
        error instanceof Error
        && error.message === backgroundFollowResumeTimeoutError
      ) {
        await enqueueStatusMutation(() => recordBackgroundFollowFailure({
          state,
          message: error.message,
          writeStatus,
        })).catch(() => undefined);
      }
      throw error;
    }
  };

  const tick = () => {
    requestHeartbeatRefresh();
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
      try {
        await dependencies.assertIndexerDaemonNativeDependencies();
      } catch (error) {
        const now = dependencies.now();
        state.state = "failed";
        state.lastError = error instanceof Error ? error.message : String(error);
        state.heartbeatAtUnixMs = now;
        state.updatedAtUnixMs = now;
        state.bootstrapPhase = "error";
        state.bootstrapProgress = {
          ...createBootstrapProgress("error", DEFAULT_SNAPSHOT_METADATA),
          message: state.lastError,
          lastError: state.lastError,
          updatedAt: now,
        };
        await writeStatus().catch(() => undefined);
        throw error;
      }
      await rm(paths.indexerDaemonSocketPath, { force: true }).catch(() => undefined);

      server = createIndexerDaemonServer({
        getStatus: () => buildIndexerDaemonStatus(state),
        openSnapshot,
        readSnapshot,
        closeSnapshot,
        resumeBackgroundFollow: resumeFollow,
      });

      await new Promise<void>((resolve, reject) => {
        server?.once("error", reject);
        server?.listen(paths.indexerDaemonSocketPath, async () => {
          server?.off("error", reject);
          await enqueueStatusMutation(async () => {
            await writeStatus();
            await refreshStatusAndPruneLeases();
          }).catch(() => undefined);
          heartbeat = setInterval(tick, heartbeatIntervalMs);
          heartbeat.unref();
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
        await enqueueStatusMutation(async () => {
          await pauseBackgroundFollow({ state }).catch(() => undefined);
          state.state = "stopping";
          state.heartbeatAtUnixMs = dependencies.now();
          state.updatedAtUnixMs = state.heartbeatAtUnixMs;
          await writeStatus();
        }).catch(() => undefined);
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
