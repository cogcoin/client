import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";

import { getBitcoindPath } from "@cogcoin/bitcoin";

import { acquireFileLock } from "../wallet/fs/lock.js";
import { stopIndexerDaemonServiceWithLockHeld } from "./indexer-daemon.js";
import { readManagedBitcoindObservedStatus, listManagedBitcoindStatusCandidates } from "./managed-runtime/bitcoind-status.js";
import { attachOrStartManagedBitcoindRuntime, probeManagedBitcoindRuntime } from "./managed-runtime/bitcoind-runtime.js";
import type { ManagedBitcoindServiceProbeResult } from "./managed-runtime/types.js";
import { createRpcClient, validateNodeConfigForTesting } from "./node.js";
import { resolveManagedServicePaths, UNINITIALIZED_WALLET_ROOT_ID } from "./service-paths.js";
import {
  DEFAULT_MANAGED_BITCOIND_FOLLOW_POLL_INTERVAL_MS,
  type ManagedBitcoindNodeHandle,
  type ManagedBitcoindServiceStatus,
} from "./types.js";
import {
  buildManagedServiceArgsForTesting,
  LOCAL_HOST,
  resolveManagedBitcoindRuntimeConfig,
  SUPPORTED_BITCOIND_VERSION,
  verifyManagedBitcoindVersion,
  writeManagedBitcoindRuntimeConfigFile,
  writeManagedBitcoindRuntimeConfigFileFromStatus,
  writeBitcoinConfForTesting,
} from "./managed-bitcoind-service-config.js";
import {
  DEFAULT_MANAGED_BITCOIND_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_MANAGED_BITCOIND_STARTUP_TIMEOUT_MS,
  FileLockBusyError,
  acquireManagedBitcoindFileLockWithRetry,
  isManagedBitcoindProcessAlive,
  waitForManagedBitcoindProcessExit,
  sleep,
} from "./managed-bitcoind-service-process.js";
import {
  createManagedWalletReplica,
  loadManagedWalletReplicaIfPresent,
} from "./managed-bitcoind-service-replica.js";
import {
  clearManagedBitcoindRuntimeArtifacts,
  createBitcoindServiceStatus,
  createManagedBitcoindNodeHandle,
  probeManagedBitcoindStatusCandidate,
  refreshManagedBitcoindStatus,
  waitForManagedBitcoindRpcReady,
  writeManagedBitcoindStatus,
} from "./managed-bitcoind-service-status.js";
import type {
  ManagedBitcoindServiceOptions,
  ManagedBitcoindServiceStopResult,
  ResolvedManagedBitcoindServiceOptions,
} from "./managed-bitcoind-service-types.js";
import type { BitcoindRpcConfig, BitcoindZmqConfig } from "./managed-bitcoind-service-config.js";

const claimedUninitializedRuntimeKeys = new Set<string>();

export async function stopManagedBitcoindServiceWithLockHeld(options: {
  dataDir: string;
  walletRootId?: string;
  shutdownTimeoutMs?: number;
  paths?: ReturnType<typeof resolveManagedServicePaths>;
}): Promise<ManagedBitcoindServiceStopResult> {
  const walletRootId = options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;
  const paths = options.paths ?? resolveManagedServicePaths(options.dataDir, walletRootId);
  const status = await readManagedBitcoindObservedStatus({
    dataDir: options.dataDir,
    walletRootId,
  });
  const processId = status?.processId ?? null;

  if (status === null || processId === null || !await isManagedBitcoindProcessAlive(processId)) {
    await clearManagedBitcoindRuntimeArtifacts(paths);
    return {
      status: "not-running",
      walletRootId,
    };
  }

  const rpc = createRpcClient(status.rpc);

  try {
    await rpc.stop();
  } catch {
    try {
      process.kill(processId, "SIGTERM");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH")) {
        throw error;
      }
    }
  }

  await waitForManagedBitcoindProcessExit(
    processId,
    options.shutdownTimeoutMs ?? DEFAULT_MANAGED_BITCOIND_SHUTDOWN_TIMEOUT_MS,
    "managed_bitcoind_service_stop_timeout",
  );
  await clearManagedBitcoindRuntimeArtifacts(paths);
  return {
    status: "stopped",
    walletRootId,
  };
}

export async function withClaimedUninitializedManagedRuntime<T>(options: {
  dataDir: string;
  walletRootId?: string;
  shutdownTimeoutMs?: number;
}, callback: () => Promise<T>): Promise<T> {
  const targetWalletRootId = options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;
  const targetPaths = resolveManagedServicePaths(options.dataDir, targetWalletRootId);
  const uninitializedPaths = resolveManagedServicePaths(options.dataDir, UNINITIALIZED_WALLET_ROOT_ID);

  if (targetPaths.walletRuntimeRoot === uninitializedPaths.walletRuntimeRoot) {
    return callback();
  }

  if (targetWalletRootId === UNINITIALIZED_WALLET_ROOT_ID) {
    return callback();
  }

  const claimKey = `${options.dataDir}\n${targetWalletRootId}`;

  if (claimedUninitializedRuntimeKeys.has(claimKey)) {
    return callback();
  }

  claimedUninitializedRuntimeKeys.add(claimKey);
  const lockTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_MANAGED_BITCOIND_STARTUP_TIMEOUT_MS;
  const bitcoindLock = await acquireManagedBitcoindFileLockWithRetry(
    uninitializedPaths.bitcoindLockPath,
    {
      purpose: "managed-bitcoind-claim-uninitialized",
      walletRootId: UNINITIALIZED_WALLET_ROOT_ID,
      dataDir: options.dataDir,
    },
    lockTimeoutMs,
  );

  try {
    const indexerLock = await acquireManagedBitcoindFileLockWithRetry(
      uninitializedPaths.indexerDaemonLockPath,
      {
        purpose: "managed-indexer-claim-uninitialized",
        walletRootId: UNINITIALIZED_WALLET_ROOT_ID,
        dataDir: options.dataDir,
      },
      lockTimeoutMs,
    );

    try {
      await stopIndexerDaemonServiceWithLockHeld({
        dataDir: options.dataDir,
        walletRootId: UNINITIALIZED_WALLET_ROOT_ID,
        shutdownTimeoutMs: options.shutdownTimeoutMs,
        paths: uninitializedPaths,
      });
      await stopManagedBitcoindServiceWithLockHeld({
        dataDir: options.dataDir,
        walletRootId: UNINITIALIZED_WALLET_ROOT_ID,
        shutdownTimeoutMs: options.shutdownTimeoutMs,
        paths: uninitializedPaths,
      });
      return await callback();
    } finally {
      await indexerLock.release();
    }
  } finally {
    claimedUninitializedRuntimeKeys.delete(claimKey);
    await bitcoindLock.release();
  }
}

async function tryAttachExistingManagedBitcoindService(
  options: ManagedBitcoindServiceOptions,
): Promise<ManagedBitcoindNodeHandle | null> {
  const walletRootId = options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;
  const paths = resolveManagedServicePaths(options.dataDir ?? "", walletRootId);
  const probe = await probeManagedBitcoindService(options);

  if (probe.compatibility !== "compatible" || probe.status === null) {
    return null;
  }

  const refreshed = await refreshManagedBitcoindStatus(
    probe.status as ManagedBitcoindServiceStatus,
    paths,
    options,
  );
  await writeManagedBitcoindRuntimeConfigFileFromStatus(paths.bitcoindRuntimeConfigPath, refreshed);

  return createManagedBitcoindNodeHandle({
    status: refreshed,
    paths,
    serviceOptions: options,
    ownership: "attached",
    stopService: stopManagedBitcoindService,
  });
}

export async function probeManagedBitcoindService(
  options: ManagedBitcoindServiceOptions,
): Promise<ManagedBitcoindServiceProbeResult> {
  const resolvedOptions: ResolvedManagedBitcoindServiceOptions = {
    ...options,
    dataDir: options.dataDir ?? "",
    walletRootId: options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID,
    startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_MANAGED_BITCOIND_STARTUP_TIMEOUT_MS,
  };

  return probeManagedBitcoindRuntime<ResolvedManagedBitcoindServiceOptions>(resolvedOptions, {
    getPaths: (runtimeOptions) => resolveManagedServicePaths(runtimeOptions.dataDir, runtimeOptions.walletRootId),
    listStatusCandidates: listManagedBitcoindStatusCandidates,
    isProcessAlive: isManagedBitcoindProcessAlive,
    probeStatusCandidate: probeManagedBitcoindStatusCandidate,
  });
}

export async function attachOrStartManagedBitcoindService(
  options: ManagedBitcoindServiceOptions,
): Promise<ManagedBitcoindNodeHandle> {
  const resolvedOptions: ManagedBitcoindServiceOptions = {
    ...options,
    dataDir: options.dataDir,
    serviceLifetime: options.serviceLifetime ?? "persistent",
    walletRootId: options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID,
  };
  const startupTimeoutMs = resolvedOptions.startupTimeoutMs ?? DEFAULT_MANAGED_BITCOIND_STARTUP_TIMEOUT_MS;

  return withClaimedUninitializedManagedRuntime({
    dataDir: resolvedOptions.dataDir ?? "",
    walletRootId: resolvedOptions.walletRootId,
    shutdownTimeoutMs: resolvedOptions.shutdownTimeoutMs,
  }, async () => {
    return attachOrStartManagedBitcoindRuntime<ResolvedManagedBitcoindServiceOptions, ManagedBitcoindNodeHandle>({
      ...resolvedOptions,
      dataDir: resolvedOptions.dataDir ?? "",
      walletRootId: resolvedOptions.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID,
      startupTimeoutMs,
    }, {
      getPaths: (runtimeOptions) => resolveManagedServicePaths(runtimeOptions.dataDir, runtimeOptions.walletRootId),
      listStatusCandidates: listManagedBitcoindStatusCandidates,
      isProcessAlive: isManagedBitcoindProcessAlive,
      probeStatusCandidate: probeManagedBitcoindStatusCandidate,
      attachExisting: tryAttachExistingManagedBitcoindService,
      acquireStartLock: async (runtimeOptions, paths) =>
        acquireFileLock(paths.bitcoindLockPath, {
          purpose: "managed-bitcoind-start",
          walletRootId: runtimeOptions.walletRootId,
          dataDir: runtimeOptions.dataDir,
        }),
      startService: async (runtimeOptions, paths) => {
        const bitcoindPath = await getBitcoindPath();
        await verifyManagedBitcoindVersion(bitcoindPath);
        const binaryVersion = SUPPORTED_BITCOIND_VERSION;
        await mkdir(runtimeOptions.dataDir, { recursive: true });
        const startManagedProcess = async (
          startOptions: ResolvedManagedBitcoindServiceOptions,
        ): Promise<{
          runtimeConfig: Awaited<ReturnType<typeof resolveManagedBitcoindRuntimeConfig>>;
          status: ManagedBitcoindServiceStatus;
        }> => {
          const runtimeConfig = await resolveManagedBitcoindRuntimeConfig(
            paths.bitcoindStatusPath,
            paths.bitcoindRuntimeConfigPath,
            startOptions,
          );
          await writeBitcoinConfForTesting(paths.bitcoinConfPath, startOptions, runtimeConfig);

          const rpcConfig: BitcoindRpcConfig = runtimeConfig.rpc;
          const zmqConfig: BitcoindZmqConfig = {
            endpoint: `tcp://${LOCAL_HOST}:${runtimeConfig.zmqPort}`,
            topic: "hashblock",
            port: runtimeConfig.zmqPort,
            pollIntervalMs: startOptions.pollIntervalMs ?? DEFAULT_MANAGED_BITCOIND_FOLLOW_POLL_INTERVAL_MS,
          };
          const spawnOptions = startOptions.serviceLifetime === "ephemeral"
            ? {
              stdio: "ignore" as const,
            }
            : {
              detached: true,
              stdio: "ignore" as const,
            };
          const child = spawn(bitcoindPath, buildManagedServiceArgsForTesting(startOptions, runtimeConfig), {
            ...spawnOptions,
          });

          if (startOptions.serviceLifetime !== "ephemeral") {
            child.unref();
          }

          const rpc = createRpcClient(rpcConfig);

          try {
            await waitForManagedBitcoindRpcReady(rpc, rpcConfig.cookieFile, startOptions.chain, startupTimeoutMs);
            await validateNodeConfigForTesting(rpc, startOptions.chain, zmqConfig.endpoint);
          } catch (error) {
            if (child.pid !== undefined) {
              try {
                process.kill(child.pid, "SIGTERM");
              } catch {
                // ignore kill failures during startup cleanup
              }
            }

            throw error;
          }

          const nowUnixMs = Date.now();
          const walletReplica = await loadManagedWalletReplicaIfPresent(
            rpc,
            startOptions.walletRootId,
            startOptions.dataDir,
          );

          return {
            runtimeConfig,
            status: createBitcoindServiceStatus({
              binaryVersion,
              serviceInstanceId: randomBytes(16).toString("hex"),
              state: "ready",
              processId: child.pid ?? null,
              walletRootId: startOptions.walletRootId,
              chain: startOptions.chain,
              dataDir: startOptions.dataDir,
              runtimeRoot: paths.walletRuntimeRoot,
              startHeight: startOptions.startHeight,
              rpc: rpcConfig,
              zmq: zmqConfig,
              p2pPort: runtimeConfig.p2pPort,
              getblockArchiveEndHeight: runtimeConfig.getblockArchiveEndHeight ?? null,
              getblockArchiveSha256: runtimeConfig.getblockArchiveSha256 ?? null,
              walletReplica,
              startedAtUnixMs: nowUnixMs,
              heartbeatAtUnixMs: nowUnixMs,
              lastError: walletReplica.message ?? null,
            }),
          };
        };

        let runtimeConfig: Awaited<ReturnType<typeof resolveManagedBitcoindRuntimeConfig>>;
        let status: ManagedBitcoindServiceStatus;

        try {
          ({ runtimeConfig, status } = await startManagedProcess(runtimeOptions));
        } catch (error) {
          if (runtimeOptions.getblockArchivePath === undefined || runtimeOptions.getblockArchivePath === null) {
            throw error;
          }

          ({ runtimeConfig, status } = await startManagedProcess({
            ...runtimeOptions,
            getblockArchivePath: null,
            getblockArchiveEndHeight: null,
            getblockArchiveSha256: null,
          }));
        }

        await writeManagedBitcoindRuntimeConfigFile(paths.bitcoindRuntimeConfigPath, runtimeConfig);
        await writeManagedBitcoindStatus(paths, status);

        return createManagedBitcoindNodeHandle({
          status,
          paths: resolveManagedServicePaths(runtimeOptions.dataDir, runtimeOptions.walletRootId),
          serviceOptions: runtimeOptions,
          ownership: "started",
          stopService: stopManagedBitcoindService,
        });
      },
      isLockBusyError: (error) => error instanceof FileLockBusyError,
      sleep,
    });
  });
}

export async function stopManagedBitcoindService(options: {
  dataDir: string;
  walletRootId?: string;
  shutdownTimeoutMs?: number;
}): Promise<ManagedBitcoindServiceStopResult> {
  const walletRootId = options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;
  const paths = resolveManagedServicePaths(options.dataDir, walletRootId);
  const lock = await acquireFileLock(paths.bitcoindLockPath, {
    purpose: "managed-bitcoind-stop",
    walletRootId,
    dataDir: options.dataDir,
  });

  try {
    return stopManagedBitcoindServiceWithLockHeld({
      ...options,
      walletRootId,
      paths,
    });
  } finally {
    await lock.release();
  }
}

export async function shutdownManagedBitcoindServiceForTesting(options: {
  dataDir: string;
  chain?: "main" | "regtest";
  walletRootId?: string;
  shutdownTimeoutMs?: number;
}): Promise<void> {
  await stopManagedBitcoindService({
    dataDir: options.dataDir,
    walletRootId: options.walletRootId,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
  }).catch(async (error) => {
    const walletRootId = options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;
    const paths = resolveManagedServicePaths(options.dataDir, walletRootId);
    await rm(paths.bitcoindReadyPath, { force: true }).catch(() => undefined);
    throw error;
  });
}
