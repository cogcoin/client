import { access, constants } from "node:fs/promises";

import { deserializeIndexerState, loadBundledGenesisParameters } from "@cogcoin/indexer";

import {
  attachOrStartIndexerDaemon,
  probeIndexerDaemon,
  readObservedIndexerDaemonStatus,
  readSnapshotWithRetry,
  type IndexerDaemonClient,
} from "../../bitcoind/indexer-daemon.js";
import { createRpcClient } from "../../bitcoind/node.js";
import { UNINITIALIZED_WALLET_ROOT_ID } from "../../bitcoind/service-paths.js";
import {
  attachOrStartManagedBitcoindService,
  probeManagedBitcoindService,
} from "../../bitcoind/service.js";
import {
  type ManagedBitcoindObservedStatus,
  type ManagedBitcoindNodeHandle,
  type ManagedIndexerDaemonObservedStatus,
  type ManagedIndexerDaemonStatus,
  type ManagedIndexerTruthSource,
} from "../../bitcoind/types.js";
import {
  loadOrAutoUnlockWalletState,
  verifyManagedCoreWalletReplica,
} from "../lifecycle.js";
import { persistNormalizedWalletDescriptorStateIfNeeded } from "../descriptor-normalization.js";
import { inspectMiningControlPlane } from "../mining/index.js";
import { normalizeMiningStateRecord } from "../mining/state.js";
import { resolveWalletRuntimePathsForTesting } from "../runtime.js";
import { loadWalletExplicitLock } from "../state/explicit-lock.js";
import { loadWalletState, type LoadedWalletState } from "../state/storage.js";
import {
  createDefaultWalletSecretProvider,
  createWalletSecretReference,
  type WalletSecretProvider,
} from "../state/provider.js";
import { createWalletReadModel } from "./project.js";
import type {
  WalletBitcoindStatus,
  WalletIndexerStatus,
  WalletLocalStateStatus,
  WalletNodeStatus,
  WalletReadContext,
  WalletServiceHealth,
  WalletSnapshotView,
} from "./types.js";
import type { WalletRuntimePaths } from "../runtime.js";

const DEFAULT_SERVICE_START_TIMEOUT_MS = 10_000;
const STALE_HEARTBEAT_THRESHOLD_MS = 15_000;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isLockedWalletAccessError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === "wallet_envelope_missing_secret_provider"
    || message.startsWith("wallet_secret_missing_")
    || message.startsWith("wallet_secret_provider_");
}

function describeLockedWalletMessage(options: {
  accessError?: unknown;
  explicitlyLocked: boolean;
  hasUnlockSessionFile: boolean;
}): string {
  if (options.explicitlyLocked) {
    return "Wallet state exists but is explicitly locked until `cogcoin unlock` is run.";
  }

  const message = options.accessError instanceof Error ? options.accessError.message : String(options.accessError ?? "");

  if (message === "wallet_envelope_missing_secret_provider") {
    return "Wallet state exists but requires the local wallet-state passphrase.";
  }

  if (message.startsWith("wallet_secret_provider_")) {
    return "Wallet state exists but the local secret provider is unavailable.";
  }

  if (message.startsWith("wallet_secret_missing_")) {
    return "Wallet state exists but its local secret-provider material is unavailable.";
  }

  return options.hasUnlockSessionFile
    ? "Wallet state exists but the unlock session is expired, invalid, or belongs to a different wallet root."
    : "Wallet state exists but is currently locked.";
}

async function normalizeLoadedWalletStateForRead(options: {
  access: Uint8Array | string | { provider: WalletSecretProvider };
  dataDir?: string;
  loaded: LoadedWalletState;
  now: number;
  paths: WalletRuntimePaths;
}): Promise<LoadedWalletState> {
  if (options.dataDir === undefined) {
    return options.loaded;
  }

  const node = await attachOrStartManagedBitcoindService({
    dataDir: options.dataDir,
    chain: "main",
    startHeight: 0,
    walletRootId: options.loaded.state.walletRootId,
  });

  try {
    const access = typeof options.access === "string" || options.access instanceof Uint8Array
      ? options.access
      : {
        provider: options.access.provider,
        secretReference: createWalletSecretReference(options.loaded.state.walletRootId),
      };
    const normalized = await persistNormalizedWalletDescriptorStateIfNeeded({
      state: options.loaded.state,
      access,
      paths: options.paths,
      nowUnixMs: options.now,
      replacePrimary: options.loaded.source === "backup",
      rpc: createRpcClient(node.rpc),
    });

    return {
      source: normalized.changed ? "primary" : options.loaded.source,
      state: normalized.state,
    };
  } finally {
    await node.stop?.().catch(() => undefined);
  }
}

async function inspectWalletLocalState(options: {
  dataDir?: string;
  passphrase?: Uint8Array | string;
  secretProvider?: WalletSecretProvider;
  now?: number;
  paths?: WalletRuntimePaths;
  walletControlLockHeld?: boolean;
} = {}): Promise<WalletLocalStateStatus> {
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const now = options.now ?? Date.now();
  const [hasPrimaryStateFile, hasBackupStateFile, hasUnlockSessionFile] = await Promise.all([
    pathExists(paths.walletStatePath),
    pathExists(paths.walletStateBackupPath),
    pathExists(paths.walletUnlockSessionPath),
  ]);

  if (!hasPrimaryStateFile && !hasBackupStateFile) {
    return {
      availability: "uninitialized",
      walletRootId: null,
      state: null,
      source: null,
      unlockUntilUnixMs: null,
      hasPrimaryStateFile,
      hasBackupStateFile,
      hasUnlockSessionFile,
      message: "Wallet state has not been initialized yet.",
    };
  }

  if (options.passphrase === undefined) {
    try {
      const provider = options.secretProvider ?? createDefaultWalletSecretProvider();
      const unlocked = await loadOrAutoUnlockWalletState({
        provider,
        nowUnixMs: now,
        paths,
        dataDir: options.dataDir,
        controlLockHeld: options.walletControlLockHeld,
      });

      if (unlocked === null) {
        const explicitLock = await loadWalletExplicitLock(paths.walletExplicitLockPath);
        const hasUnlockSessionFileNow = await pathExists(paths.walletUnlockSessionPath);

        try {
          const loaded = await loadWalletState({
            primaryPath: paths.walletStatePath,
            backupPath: paths.walletStateBackupPath,
          }, {
            provider,
          });
          await normalizeLoadedWalletStateForRead({
            loaded,
            access: { provider },
            dataDir: options.dataDir,
            now,
            paths,
          });
          return {
            availability: "locked",
            walletRootId: loaded.state.walletRootId,
            state: null,
            source: loaded.source,
            unlockUntilUnixMs: null,
            hasPrimaryStateFile,
            hasBackupStateFile,
            hasUnlockSessionFile: hasUnlockSessionFileNow,
            message: describeLockedWalletMessage({
              explicitlyLocked: explicitLock?.walletRootId === loaded.state.walletRootId,
              hasUnlockSessionFile: hasUnlockSessionFileNow,
            }),
          };
        } catch (error) {
          if (isLockedWalletAccessError(error)) {
            return {
              availability: "locked",
              walletRootId: null,
              state: null,
              source: null,
              unlockUntilUnixMs: null,
              hasPrimaryStateFile,
              hasBackupStateFile,
              hasUnlockSessionFile: hasUnlockSessionFileNow,
              message: describeLockedWalletMessage({
                accessError: error,
                explicitlyLocked: false,
                hasUnlockSessionFile: hasUnlockSessionFileNow,
              }),
            };
          }

          return {
            availability: "local-state-corrupt",
            walletRootId: null,
            state: null,
            source: null,
            unlockUntilUnixMs: null,
            hasPrimaryStateFile,
            hasBackupStateFile,
            hasUnlockSessionFile: hasUnlockSessionFileNow,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }

      return {
        availability: "ready",
        walletRootId: unlocked.state.walletRootId,
        state: {
          ...unlocked.state,
          miningState: normalizeMiningStateRecord(unlocked.state.miningState),
        },
        source: unlocked.source,
        unlockUntilUnixMs: unlocked.session.unlockUntilUnixMs,
        hasPrimaryStateFile,
        hasBackupStateFile,
        hasUnlockSessionFile: true,
        message: null,
      };
    } catch (error) {
      return {
        availability: "local-state-corrupt",
        walletRootId: null,
        state: null,
        source: null,
        unlockUntilUnixMs: null,
        hasPrimaryStateFile,
        hasBackupStateFile,
        hasUnlockSessionFile,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  try {
    const loaded = await normalizeLoadedWalletStateForRead({
      loaded: await loadWalletState({
        primaryPath: paths.walletStatePath,
        backupPath: paths.walletStateBackupPath,
      }, options.passphrase),
      access: options.passphrase,
      dataDir: options.dataDir,
      now,
      paths,
    });

    return {
      availability: "ready",
      walletRootId: loaded.state.walletRootId,
      state: {
        ...loaded.state,
        miningState: normalizeMiningStateRecord(loaded.state.miningState),
      },
      source: loaded.source,
      unlockUntilUnixMs: null,
      hasPrimaryStateFile,
      hasBackupStateFile,
      hasUnlockSessionFile,
      message: null,
    };
  } catch (error) {
    return {
      availability: "local-state-corrupt",
      walletRootId: null,
      state: null,
      source: null,
      unlockUntilUnixMs: null,
      hasPrimaryStateFile,
      hasBackupStateFile,
      hasUnlockSessionFile,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function mapIndexerStartupError(message: string): {
  health: WalletServiceHealth;
  message: string;
} {
  switch (message) {
    case "indexer_daemon_start_timeout":
      return {
        health: "starting",
        message: "Indexer daemon is still starting.",
      };
    case "indexer_daemon_service_version_mismatch":
      return {
        health: "service-version-mismatch",
        message: "The live indexer daemon is running an incompatible service API version.",
      };
    case "indexer_daemon_schema_mismatch":
      return {
        health: "schema-mismatch",
        message: "The live indexer daemon is using an incompatible sqlite schema.",
      };
    case "indexer_daemon_wallet_root_mismatch":
      return {
        health: "wallet-root-mismatch",
        message: "The live indexer daemon belongs to a different wallet root.",
      };
    case "indexer_daemon_protocol_error":
      return {
        health: "unavailable",
        message: "The live indexer daemon socket responded with an invalid or incomplete protocol exchange.",
      };
    default:
      return {
        health: "unavailable",
        message,
      };
  }
}

function mapBitcoindStartupError(message: string): WalletBitcoindStatus {
  switch (message) {
    case "managed_bitcoind_service_start_timeout":
      return {
        health: "starting",
        status: null,
        message: "Managed bitcoind service is still starting.",
      };
    case "managed_bitcoind_service_version_mismatch":
      return {
        health: "service-version-mismatch",
        status: null,
        message: "The live managed bitcoind service is running an incompatible service version.",
      };
    case "managed_bitcoind_wallet_root_mismatch":
      return {
        health: "wallet-root-mismatch",
        status: null,
        message: "The live managed bitcoind service belongs to a different wallet root.",
      };
    case "managed_bitcoind_runtime_mismatch":
      return {
        health: "runtime-mismatch",
        status: null,
        message: "The live managed bitcoind service runtime does not match this wallet's expected data directory or chain.",
      };
    case "managed_bitcoind_protocol_error":
      return {
        health: "unavailable",
        status: null,
        message: "The managed bitcoind runtime artifacts are invalid or incomplete.",
      };
    default:
      return {
        health: "unavailable",
        status: null,
        message,
      };
  }
}

function deriveBitcoindHealth(options: {
  status: ManagedBitcoindObservedStatus | null;
  nodeStatus: WalletNodeStatus | null;
  startupError: string | null;
}): WalletBitcoindStatus {
  if (options.startupError !== null) {
    const mapped = mapBitcoindStartupError(options.startupError);
    return {
      ...mapped,
      status: options.status,
    };
  }

  if (options.status === null) {
    return {
      health: "unavailable",
      status: null,
      message: "Managed bitcoind service is unavailable.",
    };
  }

  if (options.status.state === "starting") {
    return {
      health: "starting",
      status: options.status,
      message: options.status.lastError ?? "Managed bitcoind service is still starting.",
    };
  }

  if (options.status.state === "failed") {
    return {
      health: "failed",
      status: options.status,
      message: options.status.lastError ?? "Managed bitcoind service refresh failed.",
    };
  }

  const proofStatus = options.nodeStatus?.walletReplica?.proofStatus;
  if (proofStatus === "missing") {
    return {
      health: "replica-missing",
      status: options.status,
      message: options.nodeStatus?.walletReplicaMessage ?? "Managed Core wallet replica is missing.",
    };
  }

  if (proofStatus === "mismatch") {
    return {
      health: "replica-mismatch",
      status: options.status,
      message: options.nodeStatus?.walletReplicaMessage ?? "Managed Core wallet replica does not match trusted wallet state.",
    };
  }

  return {
    health: "ready",
    status: options.status,
    message: options.nodeStatus?.walletReplicaMessage ?? options.status.lastError,
  };
}

function deriveNodeHealth(status: WalletNodeStatus | null, bitcoindHealth: WalletBitcoindStatus["health"]): {
  health: WalletServiceHealth;
  message: string | null;
} {
  if (bitcoindHealth !== "ready" || status === null || !status.ready) {
    return {
      health: "unavailable",
      message: "Bitcoin service is unavailable.",
    };
  }

  if (status.nodeBestHeight !== null && status.nodeHeaderHeight !== null && status.nodeBestHeight < status.nodeHeaderHeight) {
    return {
      health: "catching-up",
      message: "Bitcoin Core is still catching up to headers.",
    };
  }

  return {
    health: "synced",
    message: null,
  };
}

function deriveIndexerHealth(options: {
  daemonStatus: ManagedIndexerDaemonStatus | null;
  observedStatus?: ManagedIndexerDaemonObservedStatus | null;
  snapshot: WalletSnapshotView | null;
  source: ManagedIndexerTruthSource;
  now: number;
  startupError: string | null;
}): WalletIndexerStatus {
  const daemonStatus = options.source === "lease"
    ? options.daemonStatus
    : options.observedStatus ?? options.daemonStatus;
  const snapshotTip = options.snapshot?.tip ?? null;
  const daemonInstanceId = options.snapshot?.daemonInstanceId ?? daemonStatus?.daemonInstanceId ?? null;
  const snapshotSeq = options.snapshot?.snapshotSeq ?? daemonStatus?.snapshotSeq ?? null;
  const openedAtUnixMs = options.snapshot?.openedAtUnixMs ?? null;
  const source = daemonStatus === null && options.snapshot === null ? "none" : options.source;

  const createResult = (
    health: WalletIndexerStatus["health"],
    message: string | null,
  ): WalletIndexerStatus => ({
    health,
    status: daemonStatus,
    message,
    snapshotTip,
    source,
    daemonInstanceId,
    snapshotSeq,
    openedAtUnixMs,
  });

  if (options.startupError !== null) {
    const mapped = mapIndexerStartupError(options.startupError);
    return createResult(mapped.health, mapped.message);
  }

  if (daemonStatus === null) {
    return createResult("unavailable", "Indexer daemon is unavailable.");
  }

  if ((options.now - daemonStatus.heartbeatAtUnixMs) > STALE_HEARTBEAT_THRESHOLD_MS) {
    return createResult("stale-heartbeat", "Indexer daemon heartbeat is stale.");
  }

  if (daemonStatus.state === "schema-mismatch") {
    return createResult("schema-mismatch", daemonStatus.lastError ?? "Indexer daemon sqlite schema is incompatible.");
  }

  if (daemonStatus.state === "failed") {
    return createResult("failed", daemonStatus.lastError ?? "Indexer daemon refresh failed.");
  }

  if (daemonStatus.state === "service-version-mismatch") {
    return createResult("service-version-mismatch", "Indexer daemon service API is incompatible.");
  }

  if (options.snapshot === null) {
    if (daemonStatus.state === "reorging") {
      return createResult("reorging", "Indexer daemon is replaying a reorg and refreshing the coherent snapshot.");
    }

    return createResult(
      daemonStatus.state === "catching-up" ? "catching-up" : "starting",
      "Indexer snapshot is not ready yet.",
    );
  }

  if (daemonStatus.state === "catching-up") {
    return createResult("catching-up", "Indexer daemon is still catching up to the managed Bitcoin tip.");
  }

  if (daemonStatus.state === "reorging") {
    return createResult("reorging", "Indexer daemon is replaying a reorg and refreshing the coherent snapshot.");
  }

  return createResult("synced", null);
}

async function attachNodeStatus(options: {
  dataDir: string;
  walletRootId?: string;
  startupTimeoutMs: number;
}): Promise<{
  handle: ManagedBitcoindNodeHandle | null;
  status: WalletNodeStatus | null;
  observedStatus: ManagedBitcoindObservedStatus | null;
  error: string | null;
}> {
  try {
    const probe = await probeManagedBitcoindService({
      dataDir: options.dataDir,
      chain: "main",
      startHeight: 0,
      walletRootId: options.walletRootId,
      startupTimeoutMs: options.startupTimeoutMs,
    });

    if (probe.compatibility !== "compatible" && probe.compatibility !== "unreachable") {
      return {
        handle: null,
        status: null,
        observedStatus: probe.status,
        error: probe.error,
      };
    }

    const genesis = await loadBundledGenesisParameters();
    const handle = await attachOrStartManagedBitcoindService({
      dataDir: options.dataDir,
      chain: "main",
      startHeight: genesis.genesisBlock,
      walletRootId: options.walletRootId,
      startupTimeoutMs: options.startupTimeoutMs,
    });
    const rpc = createRpcClient(handle.rpc);
    const [chainInfo, serviceStatus] = await Promise.all([
      rpc.getBlockchainInfo(),
      handle.refreshServiceStatus?.(),
    ]);
    const status: WalletNodeStatus = {
      ready: true,
      chain: chainInfo.chain,
      pid: handle.pid,
      walletRootId: handle.walletRootId ?? null,
      nodeBestHeight: chainInfo.blocks,
      nodeBestHashHex: chainInfo.bestblockhash,
      nodeHeaderHeight: chainInfo.headers,
      serviceUpdatedAtUnixMs: serviceStatus?.updatedAtUnixMs ?? null,
      serviceStatus: serviceStatus ?? null,
      walletReplica: serviceStatus?.walletReplica ?? null,
      walletReplicaMessage: serviceStatus?.walletReplica?.message ?? null,
    };

    return {
      handle,
      status,
      observedStatus: serviceStatus ?? null,
      error: null,
    };
  } catch (error) {
    return {
      handle: null,
      status: null,
      observedStatus: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function openWalletReadContext(options: {
  dataDir: string;
  databasePath: string;
  walletStatePassphrase?: Uint8Array | string;
  secretProvider?: WalletSecretProvider;
  walletControlLockHeld?: boolean;
  startupTimeoutMs?: number;
  now?: number;
  paths?: WalletRuntimePaths;
}): Promise<WalletReadContext> {
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_SERVICE_START_TIMEOUT_MS;
  const now = options.now ?? Date.now();
  const localState = await inspectWalletLocalState({
    dataDir: options.dataDir,
    passphrase: options.walletStatePassphrase,
    secretProvider: options.secretProvider,
    walletControlLockHeld: options.walletControlLockHeld,
    now,
    paths: options.paths,
  });
  const walletRootId = localState.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;

  const node = await attachNodeStatus({
    dataDir: options.dataDir,
    walletRootId,
    startupTimeoutMs,
  });
  if (localState.state !== null && node.status !== null) {
    const verifiedReplica = await verifyManagedCoreWalletReplica(localState.state, options.dataDir, {
      nodeHandle: node.handle ?? undefined,
    });
    node.status = {
      ...node.status,
      walletReplica: verifiedReplica,
      walletReplicaMessage: verifiedReplica.message ?? null,
    };
  }
  const bitcoind = deriveBitcoindHealth({
    status: node.observedStatus,
    nodeStatus: node.status,
    startupError: node.error,
  });
  const nodeDerived = deriveNodeHealth(node.status, bitcoind.health);

  let daemonClient: IndexerDaemonClient | null = null;
  let daemonStatus: ManagedIndexerDaemonStatus | null = null;
  let observedDaemonStatus: ManagedIndexerDaemonObservedStatus | null = null;
  let snapshot: WalletSnapshotView | null = null;
  let indexerSource: ManagedIndexerTruthSource = "none";
  let daemonError: string | null = null;

  try {
    const probe = await probeIndexerDaemon({
      dataDir: options.dataDir,
      walletRootId,
    });

    if (probe.compatibility === "compatible") {
      daemonClient = probe.client;
      observedDaemonStatus = probe.status;
      indexerSource = "probe";
    } else if (probe.compatibility === "unreachable") {
      daemonClient = await attachOrStartIndexerDaemon({
        dataDir: options.dataDir,
        databasePath: options.databasePath,
        walletRootId,
        startupTimeoutMs,
      });
    } else {
      observedDaemonStatus = probe.status;
      indexerSource = probe.status === null ? "none" : "probe";
      daemonError = probe.error;
    }

    if (daemonClient !== null) {
      const lease = await readSnapshotWithRetry(daemonClient, walletRootId);
      daemonStatus = lease.status;
      observedDaemonStatus = lease.status;
      snapshot = {
        tip: lease.payload.tip,
        state: deserializeIndexerState(Buffer.from(lease.payload.stateBase64, "base64")),
        source: "lease",
        daemonInstanceId: lease.payload.daemonInstanceId,
        snapshotSeq: lease.payload.snapshotSeq,
        openedAtUnixMs: lease.payload.openedAtUnixMs,
      };
      indexerSource = "lease";
    }
  } catch (error) {
    daemonError = error instanceof Error ? error.message : String(error);
    if (observedDaemonStatus === null) {
      observedDaemonStatus = await readObservedIndexerDaemonStatus({
        dataDir: options.dataDir,
        walletRootId,
      }).catch(() => null);
      if (observedDaemonStatus !== null) {
        indexerSource = "status-file";
      }
    }
  }

  const indexer = deriveIndexerHealth({
    daemonStatus,
    observedStatus: observedDaemonStatus,
    snapshot,
    source: indexerSource,
    now,
    startupError: daemonError,
  });
  const mining = await inspectMiningControlPlane({
    provider: options.secretProvider,
    localState,
    bitcoind,
    nodeStatus: node.status,
    nodeHealth: nodeDerived.health,
    indexer,
    nowUnixMs: now,
    paths: options.paths,
  });

  return {
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    localState,
    bitcoind,
    nodeStatus: node.status,
    nodeHealth: nodeDerived.health,
    nodeMessage: nodeDerived.message,
    indexer,
    snapshot,
    model: localState.state === null
      ? null
      : createWalletReadModel(localState.state, snapshot),
    mining,
    async close(): Promise<void> {
      await daemonClient?.close().catch(() => undefined);
      await node.handle?.stop().catch(() => undefined);
    },
  };
}

export {
  inspectWalletLocalState,
  readSnapshotWithRetry,
};
