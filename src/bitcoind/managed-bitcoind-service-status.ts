import { mkdir, rm } from "node:fs/promises";

import { writeFileAtomic } from "../wallet/fs/atomic.js";
import { writeRuntimeStatusFile } from "../wallet/fs/status-file.js";
import {
  mapManagedBitcoindRuntimeProbeFailure,
  mapManagedBitcoindValidationError,
  validateManagedBitcoindObservedStatus,
} from "./managed-runtime/bitcoind-policy.js";
import { createRpcClient, validateNodeConfigForTesting } from "./node.js";
import { resolveManagedServicePaths } from "./service-paths.js";
import {
  MANAGED_BITCOIND_SERVICE_API_VERSION,
  type ManagedBitcoindObservedStatus,
  type ManagedBitcoindNodeHandle,
  type ManagedBitcoindServiceStatus,
  type ManagedCoreWalletReplicaStatus,
} from "./types.js";
import type {
  ManagedBitcoindRpcReadyProgressReporter,
  ManagedBitcoindServiceOwnership,
  ManagedBitcoindServiceOptions,
  ManagedBitcoindServiceStopResult,
} from "./managed-bitcoind-service-types.js";
import {
  createMissingManagedWalletReplicaStatus,
  loadManagedWalletReplicaIfPresent,
} from "./managed-bitcoind-service-replica.js";
import {
  DEFAULT_MANAGED_BITCOIND_STARTUP_TIMEOUT_MS,
  isManagedBitcoindProcessAlive,
  sleep,
} from "./managed-bitcoind-service-process.js";
import {
  type BitcoindRpcConfig,
  type BitcoindZmqConfig,
  waitForManagedBitcoindCookie,
} from "./managed-bitcoind-service-config.js";
import { isManagedRpcWarmupError } from "./retryable-rpc.js";
import type { ManagedBitcoindServiceProbeResult } from "./managed-runtime/types.js";

interface WaitForManagedBitcoindRpcReadyOptions {
  progress?: ManagedBitcoindRpcReadyProgressReporter;
  progressIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function describeRpcReadyError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const warmupMatch = /^bitcoind_rpc_[^_]+_-28_(.+)$/u.exec(error.message);

  if (warmupMatch !== null) {
    return warmupMatch[1].replaceAll("_", " ");
  }

  return error.message;
}

export async function waitForManagedBitcoindRpcReady(
  rpc: ReturnType<typeof createRpcClient>,
  cookieFile: string,
  expectedChain: "main" | "regtest",
  timeoutMs: number,
  options: WaitForManagedBitcoindRpcReadyOptions = {},
): Promise<void> {
  const sleepImpl = options.sleep ?? sleep;
  const now = options.now ?? Date.now;
  const progressIntervalMs = options.progressIntervalMs ?? 30_000;
  const startedAt = now();
  await options.progress?.({
    code: "bitcoind-rpc-wait",
    message: "Waiting for Bitcoin Core RPC readiness...",
    elapsedMs: 0,
    lastError: null,
  });
  await waitForManagedBitcoindCookie(cookieFile, timeoutMs, sleepImpl, {
    now,
    progressIntervalMs,
    onProgress: async (elapsedMs) => {
      await options.progress?.({
        code: "bitcoind-rpc-wait-progress",
        message: `Still waiting for Bitcoin Core RPC readiness (${Math.floor(elapsedMs / 1000)}s elapsed). Last RPC state: cookie not ready.`,
        elapsedMs,
        lastError: "cookie not ready",
      });
    },
  });
  const deadline = now() + timeoutMs;
  let lastError: unknown = null;
  let lastProgressAt = startedAt;

  while (now() < deadline) {
    try {
      const info = await rpc.getBlockchainInfo();

      if (info.chain !== expectedChain) {
        throw new Error(`bitcoind_chain_expected_${expectedChain}_got_${info.chain}`);
      }

      await options.progress?.({
        code: "bitcoind-rpc-ready",
        message: "Bitcoin Core RPC is ready.",
        elapsedMs: Math.max(0, now() - startedAt),
        lastError: null,
      });
      return;
    } catch (error) {
      lastError = error;
      const currentTime = now();

      if (currentTime - lastProgressAt >= progressIntervalMs) {
        const lastErrorText = describeRpcReadyError(lastError);
        await options.progress?.({
          code: "bitcoind-rpc-wait-progress",
          message: `Still waiting for Bitcoin Core RPC readiness (${Math.floor((currentTime - startedAt) / 1000)}s elapsed). Last RPC state: ${lastErrorText}.`,
          elapsedMs: Math.max(0, currentTime - startedAt),
          lastError: lastErrorText,
        });
        lastProgressAt = currentTime;
      }

      await sleepImpl(250);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("bitcoind_rpc_timeout");
}

export function createBitcoindServiceStatus(options: {
  binaryVersion: string;
  serviceInstanceId: string;
  state: ManagedBitcoindServiceStatus["state"];
  processId: number | null;
  walletRootId: string;
  chain: "main" | "regtest";
  dataDir: string;
  runtimeRoot: string;
  startHeight: number;
  rpc: BitcoindRpcConfig;
  zmq: BitcoindZmqConfig;
  p2pPort: number;
  getblockArchiveEndHeight: number | null;
  getblockArchiveSha256: string | null;
  walletReplica: ManagedCoreWalletReplicaStatus | null;
  startedAtUnixMs: number;
  heartbeatAtUnixMs: number;
  lastError: string | null;
}): ManagedBitcoindServiceStatus {
  return {
    serviceApiVersion: MANAGED_BITCOIND_SERVICE_API_VERSION,
    binaryVersion: options.binaryVersion,
    buildId: null,
    serviceInstanceId: options.serviceInstanceId,
    state: options.state,
    processId: options.processId,
    walletRootId: options.walletRootId,
    chain: options.chain,
    dataDir: options.dataDir,
    runtimeRoot: options.runtimeRoot,
    startHeight: options.startHeight,
    rpc: options.rpc,
    zmq: options.zmq,
    p2pPort: options.p2pPort,
    getblockArchiveEndHeight: options.getblockArchiveEndHeight,
    getblockArchiveSha256: options.getblockArchiveSha256,
    walletReplica: options.walletReplica,
    startedAtUnixMs: options.startedAtUnixMs,
    heartbeatAtUnixMs: options.heartbeatAtUnixMs,
    updatedAtUnixMs: options.heartbeatAtUnixMs,
    lastError: options.lastError,
  };
}

export async function probeManagedBitcoindStatusCandidate(
  status: ManagedBitcoindObservedStatus,
  options: ManagedBitcoindServiceOptions,
  runtimeRoot: string,
): Promise<ManagedBitcoindServiceProbeResult> {
  try {
    validateManagedBitcoindObservedStatus(status, {
      chain: options.chain,
      dataDir: options.dataDir ?? "",
      runtimeRoot,
    });
  } catch (error) {
    return mapManagedBitcoindValidationError(error, status);
  }

  const rpc = createRpcClient(status.rpc);

  try {
    await waitForManagedBitcoindRpcReady(
      rpc,
      status.rpc.cookieFile,
      status.chain,
      options.startupTimeoutMs ?? DEFAULT_MANAGED_BITCOIND_STARTUP_TIMEOUT_MS,
      {
        progress: options.rpcReadyProgress,
      },
    );
    await validateNodeConfigForTesting(rpc, status.chain, status.zmq.endpoint, {
      requireRawTxZmq: true,
    });
    return {
      compatibility: "compatible",
      status,
      error: null,
    };
  } catch (error) {
    return mapManagedBitcoindRuntimeProbeFailure(error, status);
  }
}

export async function writeManagedBitcoindStatus(
  paths: ReturnType<typeof resolveManagedServicePaths>,
  status: ManagedBitcoindServiceStatus,
): Promise<void> {
  await mkdir(paths.walletRuntimeRoot, { recursive: true });
  await writeRuntimeStatusFile(paths.bitcoindStatusPath, status);
  await writeFileAtomic(paths.bitcoindPidPath, `${status.processId ?? ""}\n`, { mode: 0o600 });
  await writeFileAtomic(paths.bitcoindReadyPath, `${status.updatedAtUnixMs}\n`, { mode: 0o600 });
  await writeRuntimeStatusFile(paths.bitcoindWalletStatusPath, status.walletReplica ?? createMissingManagedWalletReplicaStatus(
    status.walletRootId,
    "Managed Core wallet replica is missing.",
  ));
}

export async function clearManagedBitcoindRuntimeArtifacts(
  paths: ReturnType<typeof resolveManagedServicePaths>,
): Promise<void> {
  await rm(paths.bitcoindStatusPath, { force: true }).catch(() => undefined);
  await rm(paths.bitcoindPidPath, { force: true }).catch(() => undefined);
  await rm(paths.bitcoindReadyPath, { force: true }).catch(() => undefined);
  await rm(paths.bitcoindWalletStatusPath, { force: true }).catch(() => undefined);
}

export async function refreshManagedBitcoindStatus(
  status: ManagedBitcoindServiceStatus,
  paths: ReturnType<typeof resolveManagedServicePaths>,
  options: ManagedBitcoindServiceOptions,
): Promise<ManagedBitcoindServiceStatus> {
  const nowUnixMs = Date.now();
  const rpc = createRpcClient(status.rpc);
  const targetWalletRootId = options.walletRootId ?? status.walletRootId;

  try {
    await waitForManagedBitcoindRpcReady(
      rpc,
      status.rpc.cookieFile,
      status.chain,
      options.startupTimeoutMs ?? DEFAULT_MANAGED_BITCOIND_STARTUP_TIMEOUT_MS,
      {
        progress: options.rpcReadyProgress,
      },
    );
    await validateNodeConfigForTesting(rpc, status.chain, status.zmq.endpoint, {
      requireRawTxZmq: true,
    });
    const walletReplica = await loadManagedWalletReplicaIfPresent(rpc, targetWalletRootId, status.dataDir);
    const nextStatus: ManagedBitcoindServiceStatus = {
      ...status,
      walletRootId: targetWalletRootId,
      runtimeRoot: paths.walletRuntimeRoot,
      state: "ready",
      processId: await isManagedBitcoindProcessAlive(status.processId) ? status.processId : null,
      walletReplica,
      heartbeatAtUnixMs: nowUnixMs,
      updatedAtUnixMs: nowUnixMs,
      lastError: walletReplica.message ?? null,
    };
    await writeManagedBitcoindStatus(paths, nextStatus);
    return nextStatus;
  } catch (error) {
    const processAlive = await isManagedBitcoindProcessAlive(status.processId);
    const stillStarting = processAlive && isManagedRpcWarmupError(error);
    const nextStatus: ManagedBitcoindServiceStatus = {
      ...status,
      walletRootId: targetWalletRootId,
      runtimeRoot: paths.walletRuntimeRoot,
      state: stillStarting ? "starting" : "failed",
      processId: processAlive ? status.processId : null,
      heartbeatAtUnixMs: nowUnixMs,
      updatedAtUnixMs: nowUnixMs,
      lastError: error instanceof Error ? error.message : String(error),
    };
    await writeManagedBitcoindStatus(paths, nextStatus);
    return nextStatus;
  }
}

export function createManagedBitcoindNodeHandle(options: {
  status: ManagedBitcoindServiceStatus;
  paths: ReturnType<typeof resolveManagedServicePaths>;
  serviceOptions: ManagedBitcoindServiceOptions;
  ownership: ManagedBitcoindServiceOwnership;
  stopService(options: {
    dataDir: string;
    walletRootId?: string;
    shutdownTimeoutMs?: number;
  }): Promise<ManagedBitcoindServiceStopResult>;
}): ManagedBitcoindNodeHandle {
  let currentStatus = options.status;
  const rpc = createRpcClient(currentStatus.rpc);
  let stopped = false;

  return {
    rpc: currentStatus.rpc,
    zmq: currentStatus.zmq,
    pid: currentStatus.processId,
    expectedChain: currentStatus.chain,
    startHeight: currentStatus.startHeight,
    dataDir: currentStatus.dataDir,
    getblockArchiveEndHeight: currentStatus.getblockArchiveEndHeight ?? null,
    getblockArchiveSha256: currentStatus.getblockArchiveSha256 ?? null,
    walletRootId: currentStatus.walletRootId,
    runtimeRoot: options.paths.walletRuntimeRoot,
    async validate(): Promise<void> {
      await validateNodeConfigForTesting(rpc, currentStatus.chain, currentStatus.zmq.endpoint);
    },
    async refreshServiceStatus() {
      currentStatus = await refreshManagedBitcoindStatus(currentStatus, options.paths, options.serviceOptions);
      this.getblockArchiveEndHeight = currentStatus.getblockArchiveEndHeight ?? null;
      this.getblockArchiveSha256 = currentStatus.getblockArchiveSha256 ?? null;
      this.walletRootId = currentStatus.walletRootId;
      return currentStatus;
    },
    async stop(): Promise<void> {
      if (stopped) {
        return;
      }

      stopped = true;

      if (options.serviceOptions.serviceLifetime !== "ephemeral" || options.ownership === "attached") {
        return;
      }

      await options.stopService({
        dataDir: currentStatus.dataDir,
        walletRootId: currentStatus.walletRootId,
        shutdownTimeoutMs: options.serviceOptions.shutdownTimeoutMs,
      });
    },
  };
}
