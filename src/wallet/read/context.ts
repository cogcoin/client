import { access, constants } from "node:fs/promises";

import { deserializeIndexerState, loadBundledGenesisParameters } from "@cogcoin/indexer";
import { readPackageVersionFromDisk } from "../../package-version.js";

import {
  attachOrStartIndexerDaemon,
  INDEXER_DAEMON_BACKGROUND_FOLLOW_RECOVERY_FAILED,
  probeIndexerDaemon,
  readObservedIndexerDaemonStatus,
  readSnapshotWithRetry,
  type IndexerDaemonClient,
} from "../../bitcoind/indexer-daemon.js";
import {
  deriveManagedBitcoindWalletStatus,
  resolveManagedBitcoindProbeDecision,
} from "../../bitcoind/managed-runtime/bitcoind-policy.js";
import {
  deriveManagedIndexerWalletStatus,
  resolveIndexerDaemonProbeDecision,
} from "../../bitcoind/managed-runtime/indexer-policy.js";
import { createRpcClient } from "../../bitcoind/node.js";
import { UNINITIALIZED_WALLET_ROOT_ID } from "../../bitcoind/service-paths.js";
import {
  attachOrStartManagedBitcoindService,
  probeManagedBitcoindService,
} from "../../bitcoind/service.js";
import { resolveCogcoinProcessingStartHeight } from "../../bitcoind/processing-start-height.js";
import {
  type ManagedBitcoindObservedStatus,
  type ManagedBitcoindNodeHandle,
  type ManagedIndexerDaemonObservedStatus,
  type ManagedIndexerDaemonStatus,
  type ManagedIndexerTruthSource,
  type RpcListUnspentEntry,
} from "../../bitcoind/types.js";
import {
  verifyManagedCoreWalletReplica,
} from "../lifecycle.js";
import { normalizeWalletStateRecord, persistWalletCoinControlStateIfNeeded } from "../coin-control.js";
import { persistNormalizedWalletDescriptorStateIfNeeded } from "../descriptor-normalization.js";
import { inspectMiningControlPlane } from "../mining/index.js";
import { normalizeMiningStateRecord } from "../mining/state.js";
import { resolveWalletRootIdFromLocalArtifacts } from "../root-resolution.js";
import { resolveWalletRuntimePathsForTesting } from "../runtime.js";
import {
  extractWalletRootIdHintFromWalletStateEnvelope,
  loadRawWalletStateEnvelope,
  loadWalletState,
  type LoadedWalletState,
} from "../state/storage.js";
import {
  createDefaultWalletSecretProvider,
  createWalletSecretReference,
  inspectClientPasswordSetupReadiness,
  type WalletSecretProvider,
} from "../state/provider.js";
import {
  describeClientPasswordLockedMessage,
  describeClientPasswordMigrationMessage,
  describeClientPasswordSetupMessage,
} from "../state/client-password.js";
import { createWalletReadModel } from "./project.js";
import type {
  WalletBitcoindStatus,
  WalletLocalStateStatus,
  WalletNodeStatus,
  WalletReadContext,
  WalletServiceHealth,
  WalletSnapshotView,
} from "./types.js";
import type { WalletRuntimePaths } from "../runtime.js";

const DEFAULT_SERVICE_START_TIMEOUT_MS = 10_000;
const TOLERATED_NODE_HEADER_LEAD_BLOCKS = 2;
const TOLERATED_NODE_HEADER_LEAD_MESSAGE =
  "Bitcoin headers can briefly lead validated blocks; a short 1-2 block lead is normal and is being tolerated.";
const NODE_CATCHING_UP_MESSAGE = "Bitcoin Core is still catching up to headers.";

function btcAmountToSats(value: number): bigint {
  return BigInt(Math.round(value * 100_000_000));
}

function isSpendableFundingUtxo(entry: RpcListUnspentEntry, fundingScriptPubKeyHex: string): boolean {
  return entry.scriptPubKey === fundingScriptPubKeyHex
    && entry.confirmations >= 1
    && entry.spendable !== false
    && entry.safe !== false;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isWalletAccessError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("wallet_secret_missing_")
    || message.startsWith("wallet_secret_provider_")
    || message.startsWith("wallet_client_password_")
    || message === "wallet_state_legacy_envelope_unsupported";
}

function describeWalletAccessMessage(options: {
  accessError?: unknown;
}): string {
  const message = options.accessError instanceof Error ? options.accessError.message : String(options.accessError ?? "");

  if (message === "wallet_state_legacy_envelope_unsupported") {
    return "Wallet state exists but was created by an older Cogcoin wallet format that this version no longer loads directly.";
  }

  if (message === "wallet_client_password_setup_required") {
    return describeClientPasswordSetupMessage();
  }

  if (message === "wallet_client_password_migration_required") {
    return describeClientPasswordMigrationMessage();
  }

  if (message === "wallet_client_password_locked") {
    return describeClientPasswordLockedMessage();
  }

  if (message.startsWith("wallet_secret_provider_")) {
    return "Wallet state exists but the local secret provider is unavailable.";
  }

  if (message.startsWith("wallet_secret_missing_")) {
    return "Wallet state exists but its local secret-provider material is unavailable.";
  }

  return message.length > 0
    ? message
    : "Wallet state exists but could not be loaded from the local secret provider.";
}

async function normalizeLoadedWalletStateForRead(options: {
  access: { provider: WalletSecretProvider };
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
    const access = {
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
    const coinControl = await persistWalletCoinControlStateIfNeeded({
      state: normalized.state,
      access,
      paths: options.paths,
      nowUnixMs: options.now,
      replacePrimary: (normalized.changed ? "primary" : options.loaded.source) === "backup",
      rpc: createRpcClient(node.rpc),
    });

    return {
      source: coinControl.changed ? "primary" : normalized.changed ? "primary" : options.loaded.source,
      state: coinControl.state,
    };
  } finally {
    await node.stop?.().catch(() => undefined);
  }
}

async function inspectWalletLocalState(options: {
  dataDir?: string;
  secretProvider?: WalletSecretProvider;
  now?: number;
  paths?: WalletRuntimePaths;
  walletControlLockHeld?: boolean;
} = {}): Promise<WalletLocalStateStatus> {
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const now = options.now ?? Date.now();
  const provider = options.secretProvider ?? createDefaultWalletSecretProvider();
  const [hasPrimaryStateFile, hasBackupStateFile] = await Promise.all([
    pathExists(paths.walletStatePath),
    pathExists(paths.walletStateBackupPath),
  ]);
  const clientPasswordReadiness = await inspectClientPasswordSetupReadiness(provider).catch(() => "ready" as const);

  if (!hasPrimaryStateFile && !hasBackupStateFile) {
    return {
      availability: "uninitialized",
      clientPasswordReadiness,
      unlockRequired: false,
      walletRootId: null,
      state: null,
      source: null,
      hasPrimaryStateFile,
      hasBackupStateFile,
      message: "Wallet state has not been initialized yet.",
    };
  }

  if (clientPasswordReadiness !== "ready") {
    const rawEnvelope = await loadRawWalletStateEnvelope({
      primaryPath: paths.walletStatePath,
      backupPath: paths.walletStateBackupPath,
    }).catch(() => null);

    if (rawEnvelope?.envelope.secretProvider == null) {
      return {
        availability: "local-state-corrupt",
        clientPasswordReadiness: "ready",
        unlockRequired: false,
        walletRootId: extractWalletRootIdHintFromWalletStateEnvelope(rawEnvelope?.envelope ?? null),
        state: null,
        source: null,
        hasPrimaryStateFile,
        hasBackupStateFile,
        message: "Wallet state exists but was created by an older Cogcoin wallet format that this version no longer loads directly.",
      };
    }

    const resolvedRoot = await resolveWalletRootIdFromLocalArtifacts({
      paths,
      provider,
    }).catch(() => null);

    return {
      availability: "local-state-corrupt",
      clientPasswordReadiness,
      unlockRequired: false,
      walletRootId: resolvedRoot?.walletRootId ?? null,
      state: null,
      source: null,
      hasPrimaryStateFile,
      hasBackupStateFile,
      message: clientPasswordReadiness === "migration-required"
        ? describeClientPasswordMigrationMessage()
        : describeClientPasswordSetupMessage(),
    };
  }

  try {
    const loaded = await loadWalletState({
      primaryPath: paths.walletStatePath,
      backupPath: paths.walletStateBackupPath,
    }, {
      provider,
    });
    const normalized = await normalizeLoadedWalletStateForRead({
      loaded,
      access: { provider },
      dataDir: options.dataDir,
      now,
      paths,
    });

    return {
      availability: "ready",
      clientPasswordReadiness,
      unlockRequired: false,
      walletRootId: normalized.state.walletRootId,
      state: normalizeWalletStateRecord({
        ...normalized.state,
        miningState: normalizeMiningStateRecord(normalized.state.miningState),
      }),
      source: normalized.source,
      hasPrimaryStateFile,
      hasBackupStateFile,
      message: null,
    };
  } catch (error) {
    const resolvedRoot = await resolveWalletRootIdFromLocalArtifacts({
      paths,
      provider,
    }).catch(() => null);
    const message = error instanceof Error ? error.message : String(error);

    return {
      availability: "local-state-corrupt",
      clientPasswordReadiness,
      unlockRequired: message === "wallet_client_password_locked",
      walletRootId: resolvedRoot?.walletRootId ?? null,
      state: null,
      source: null,
      hasPrimaryStateFile,
      hasBackupStateFile,
      message: isWalletAccessError(error)
        ? describeWalletAccessMessage({ accessError: error })
        : error instanceof Error
          ? error.message
          : String(error),
    };
  }
}

function deriveNodeHealth(status: WalletNodeStatus | null, bitcoindHealth: WalletBitcoindStatus["health"]): {
  health: WalletServiceHealth;
  message: string | null;
} {
  if (bitcoindHealth !== "ready" || status === null || !status.ready) {
    return {
      health: "catching-up",
      message: NODE_CATCHING_UP_MESSAGE,
    };
  }

  const headerLead = status.nodeBestHeight !== null && status.nodeHeaderHeight !== null
    ? status.nodeHeaderHeight - status.nodeBestHeight
    : null;

  if (headerLead !== null && headerLead > 0) {
    if (headerLead <= TOLERATED_NODE_HEADER_LEAD_BLOCKS) {
      return {
        health: "synced",
        message: TOLERATED_NODE_HEADER_LEAD_MESSAGE,
      };
    }

    return {
      health: "catching-up",
      message: NODE_CATCHING_UP_MESSAGE,
    };
  }

  return {
    health: "synced",
    message: null,
  };
}

export function deriveNodeHealthForTesting(
  status: WalletNodeStatus | null,
  bitcoindHealth: WalletBitcoindStatus["health"],
): {
  health: WalletServiceHealth;
  message: string | null;
} {
  return deriveNodeHealth(status, bitcoindHealth);
}

async function attachNodeStatus(options: {
  dataDir: string;
  walletRootId?: string;
  startupTimeoutMs: number;
}): Promise<{
  handle: ManagedBitcoindNodeHandle | null;
  rpc: ReturnType<typeof createRpcClient> | null;
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
    const decision = resolveManagedBitcoindProbeDecision(probe);

    if (decision.action === "reject") {
      return {
        handle: null,
        rpc: null,
        status: null,
        observedStatus: probe.status,
        error: decision.error,
      };
    }

    const genesis = await loadBundledGenesisParameters();
    const handle = await attachOrStartManagedBitcoindService({
      dataDir: options.dataDir,
      chain: "main",
      startHeight: resolveCogcoinProcessingStartHeight(genesis),
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
      rpc,
      status,
      observedStatus: serviceStatus ?? null,
      error: null,
    };
  } catch (error) {
    return {
      handle: null,
      rpc: null,
      status: null,
      observedStatus: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readFundingSpendableSats(options: {
  state: WalletLocalStateStatus["state"];
  rpc: ReturnType<typeof createRpcClient> | null;
}): Promise<bigint | null> {
  if (options.state === null || options.rpc === null) {
    return null;
  }

  const state = options.state;

  try {
    const utxos = await options.rpc.listUnspent(state.managedCoreWallet.walletName, 1);
    return utxos.reduce((sum, entry) =>
      isSpendableFundingUtxo(entry, state.funding.scriptPubKeyHex)
        ? sum + btcAmountToSats(entry.amount)
        : sum, 0n);
  } catch {
    return null;
  }
}

export async function openWalletReadContext(options: {
  dataDir: string;
  databasePath: string;
  secretProvider?: WalletSecretProvider;
  walletControlLockHeld?: boolean;
  startupTimeoutMs?: number;
  expectedIndexerBinaryVersion?: string | null;
  now?: number;
  paths?: WalletRuntimePaths;
}): Promise<WalletReadContext> {
  const expectedIndexerBinaryVersion = options.expectedIndexerBinaryVersion === undefined
    ? await readPackageVersionFromDisk()
    : options.expectedIndexerBinaryVersion;
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_SERVICE_START_TIMEOUT_MS;
  const now = options.now ?? Date.now();
  const localState = await inspectWalletLocalState({
    dataDir: options.dataDir,
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
  const bitcoind = deriveManagedBitcoindWalletStatus({
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
    const probeDecision = resolveIndexerDaemonProbeDecision({
      probe,
      expectedBinaryVersion: expectedIndexerBinaryVersion,
    });

    if (probeDecision.action !== "reject") {
      await probe.client?.close().catch(() => undefined);
      daemonClient = await attachOrStartIndexerDaemon({
        dataDir: options.dataDir,
        databasePath: options.databasePath,
        walletRootId,
        startupTimeoutMs,
        ensureBackgroundFollow: true,
        expectedBinaryVersion: expectedIndexerBinaryVersion,
      });
    } else {
      observedDaemonStatus = probe.status;
      indexerSource = probe.status === null ? "none" : "probe";
      daemonError = probeDecision.error;
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
    if (daemonError === INDEXER_DAEMON_BACKGROUND_FOLLOW_RECOVERY_FAILED) {
      await daemonClient?.close().catch(() => undefined);
      await node.handle?.stop().catch(() => undefined);
      throw error;
    }

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

  const indexer = deriveManagedIndexerWalletStatus({
    daemonStatus,
    observedStatus: observedDaemonStatus,
    snapshot,
    source: indexerSource,
    now,
    startupError: daemonError,
  });
  const fundingSpendableSats = await readFundingSpendableSats({
    state: localState.state,
    rpc: node.rpc,
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
    fundingSpendableSats,
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
