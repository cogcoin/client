import { deserializeIndexerState, loadBundledGenesisParameters } from "@cogcoin/indexer";

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
import type { ManagedWalletNodeConnection, ManagedWalletReadServiceBundle } from "../../bitcoind/managed-runtime/types.js";
import { createRpcClient } from "../../bitcoind/node.js";
import { resolveCogcoinProcessingStartHeight } from "../../bitcoind/processing-start-height.js";
import {
  attachOrStartManagedBitcoindService,
  probeManagedBitcoindService,
} from "../../bitcoind/service.js";
import type {
  ManagedBitcoindNodeHandle,
  ManagedIndexerDaemonObservedStatus,
  ManagedIndexerDaemonStatus,
  ManagedIndexerTruthSource,
} from "../../bitcoind/types.js";
import { verifyManagedCoreWalletReplica } from "../lifecycle.js";
import type { WalletBitcoindStatus, WalletLocalStateStatus, WalletNodeStatus, WalletServiceHealth, WalletSnapshotView } from "./types.js";

const TOLERATED_NODE_HEADER_LEAD_BLOCKS = 2;
const TOLERATED_NODE_HEADER_LEAD_MESSAGE =
  "Bitcoin headers can briefly lead validated blocks; a short 1-2 block lead is normal and is being tolerated.";
const NODE_CATCHING_UP_MESSAGE = "Bitcoin Core is still catching up to headers.";

type ManagedWalletReadServiceDeps = {
  loadBundledGenesisParameters: typeof loadBundledGenesisParameters;
  probeManagedBitcoindService: typeof probeManagedBitcoindService;
  attachOrStartManagedBitcoindService: typeof attachOrStartManagedBitcoindService;
  createRpcClient: typeof createRpcClient;
  verifyManagedCoreWalletReplica: typeof verifyManagedCoreWalletReplica;
  probeIndexerDaemon: typeof probeIndexerDaemon;
  attachOrStartIndexerDaemon: typeof attachOrStartIndexerDaemon;
  readSnapshotWithRetry: typeof readSnapshotWithRetry;
  readObservedIndexerDaemonStatus: typeof readObservedIndexerDaemonStatus;
};

const defaultManagedWalletReadServiceDeps: ManagedWalletReadServiceDeps = {
  loadBundledGenesisParameters,
  probeManagedBitcoindService,
  attachOrStartManagedBitcoindService,
  createRpcClient,
  verifyManagedCoreWalletReplica,
  probeIndexerDaemon,
  attachOrStartIndexerDaemon,
  readSnapshotWithRetry,
  readObservedIndexerDaemonStatus,
};

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

async function attachNodeStatus(
  options: {
    dataDir: string;
    walletRootId: string;
    startupTimeoutMs: number;
  },
  dependencies: ManagedWalletReadServiceDeps,
): Promise<ManagedWalletNodeConnection<ManagedBitcoindNodeHandle, ReturnType<typeof createRpcClient>>> {
  try {
    const probe = await dependencies.probeManagedBitcoindService({
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

    const genesis = await dependencies.loadBundledGenesisParameters();
    const handle = await dependencies.attachOrStartManagedBitcoindService({
      dataDir: options.dataDir,
      chain: "main",
      startHeight: resolveCogcoinProcessingStartHeight(genesis),
      walletRootId: options.walletRootId,
      startupTimeoutMs: options.startupTimeoutMs,
    });
    const rpc = dependencies.createRpcClient(handle.rpc);
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

export async function openManagedWalletReadServiceBundle(
  options: {
    dataDir: string;
    databasePath: string;
    walletRootId: string;
    localState: WalletLocalStateStatus;
    startupTimeoutMs: number;
    expectedIndexerBinaryVersion: string | null;
    now: number;
  },
  dependencies: ManagedWalletReadServiceDeps = defaultManagedWalletReadServiceDeps,
): Promise<ManagedWalletReadServiceBundle<
  ManagedBitcoindNodeHandle,
  ReturnType<typeof createRpcClient>,
  IndexerDaemonClient
>> {
  const node = await attachNodeStatus({
    dataDir: options.dataDir,
    walletRootId: options.walletRootId,
    startupTimeoutMs: options.startupTimeoutMs,
  }, dependencies);

  if (options.localState.state !== null && node.status !== null) {
    const verifiedReplica = await dependencies.verifyManagedCoreWalletReplica(options.localState.state, options.dataDir, {
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
    const probe = await dependencies.probeIndexerDaemon({
      dataDir: options.dataDir,
      walletRootId: options.walletRootId,
    });
    const probeDecision = resolveIndexerDaemonProbeDecision({
      probe,
      expectedBinaryVersion: options.expectedIndexerBinaryVersion,
    });

    if (probeDecision.action !== "reject") {
      await probe.client?.close().catch(() => undefined);
      daemonClient = await dependencies.attachOrStartIndexerDaemon({
        dataDir: options.dataDir,
        databasePath: options.databasePath,
        walletRootId: options.walletRootId,
        startupTimeoutMs: options.startupTimeoutMs,
        ensureBackgroundFollow: true,
        expectedBinaryVersion: options.expectedIndexerBinaryVersion,
      });
    } else {
      observedDaemonStatus = probe.status;
      indexerSource = probe.status === null ? "none" : "probe";
      daemonError = probeDecision.error;
    }

    if (daemonClient !== null) {
      const lease = await dependencies.readSnapshotWithRetry(daemonClient, options.walletRootId);
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
      observedDaemonStatus = await dependencies.readObservedIndexerDaemonStatus({
        dataDir: options.dataDir,
        walletRootId: options.walletRootId,
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
    now: options.now,
    startupError: daemonError,
  });

  return {
    node,
    bitcoind,
    nodeHealth: nodeDerived.health,
    nodeMessage: nodeDerived.message,
    daemonClient,
    indexer,
    snapshot,
    async close(): Promise<void> {
      await daemonClient?.close().catch(() => undefined);
      await node.handle?.stop().catch(() => undefined);
    },
  };
}
