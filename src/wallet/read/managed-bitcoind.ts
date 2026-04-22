import { loadBundledGenesisParameters } from "@cogcoin/indexer";

import {
  deriveManagedBitcoindWalletStatus,
  resolveManagedBitcoindProbeDecision,
} from "../../bitcoind/managed-runtime/bitcoind-policy.js";
import type { ManagedWalletNodeConnection } from "../../bitcoind/managed-runtime/types.js";
import { createRpcClient } from "../../bitcoind/node.js";
import { resolveCogcoinProcessingStartHeight } from "../../bitcoind/processing-start-height.js";
import {
  attachOrStartManagedBitcoindService,
  probeManagedBitcoindService,
} from "../../bitcoind/service.js";
import type { ManagedBitcoindNodeHandle } from "../../bitcoind/types.js";
import { verifyManagedCoreWalletReplica } from "../lifecycle.js";
import type { WalletBitcoindStatus, WalletLocalStateStatus, WalletNodeStatus, WalletServiceHealth } from "./types.js";

const TOLERATED_NODE_HEADER_LEAD_BLOCKS = 2;
const TOLERATED_NODE_HEADER_LEAD_MESSAGE =
  "Bitcoin headers can briefly lead validated blocks; a short 1-2 block lead is normal and is being tolerated.";
const NODE_CATCHING_UP_MESSAGE = "Bitcoin Core is still catching up to headers.";

export type ManagedWalletBitcoindReadDeps = {
  loadBundledGenesisParameters: typeof loadBundledGenesisParameters;
  probeManagedBitcoindService: typeof probeManagedBitcoindService;
  attachOrStartManagedBitcoindService: typeof attachOrStartManagedBitcoindService;
  createRpcClient: typeof createRpcClient;
  verifyManagedCoreWalletReplica: typeof verifyManagedCoreWalletReplica;
};

const defaultManagedWalletBitcoindReadDeps: ManagedWalletBitcoindReadDeps = {
  loadBundledGenesisParameters,
  probeManagedBitcoindService,
  attachOrStartManagedBitcoindService,
  createRpcClient,
  verifyManagedCoreWalletReplica,
};

export interface ManagedWalletBitcoindReadState {
  node: ManagedWalletNodeConnection<ManagedBitcoindNodeHandle, ReturnType<typeof createRpcClient>>;
  bitcoind: WalletBitcoindStatus;
  nodeHealth: WalletServiceHealth;
  nodeMessage: string | null;
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

async function attachNodeStatus(
  options: {
    dataDir: string;
    walletRootId: string;
    startupTimeoutMs: number;
  },
  dependencies: ManagedWalletBitcoindReadDeps,
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

export async function openManagedWalletBitcoindReadState(options: {
  dataDir: string;
  walletRootId: string;
  localState: WalletLocalStateStatus;
  startupTimeoutMs: number;
}, dependencies: ManagedWalletBitcoindReadDeps = defaultManagedWalletBitcoindReadDeps): Promise<ManagedWalletBitcoindReadState> {
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

  return {
    node,
    bitcoind,
    nodeHealth: nodeDerived.health,
    nodeMessage: nodeDerived.message,
  };
}
