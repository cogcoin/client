import { access, constants } from "node:fs/promises";

import {
  attachOrStartIndexerDaemon,
  probeIndexerDaemon,
} from "../../bitcoind/indexer-daemon.js";
import { createRpcClient } from "../../bitcoind/node.js";
import { attachOrStartManagedBitcoindService, probeManagedBitcoindService } from "../../bitcoind/service.js";
import { resolveManagedServicePaths } from "../../bitcoind/service-paths.js";
import { persistWalletCoinControlStateIfNeeded } from "../coin-control.js";
import { normalizeWalletDescriptorState } from "../descriptor-normalization.js";
import { acquireFileLock } from "../fs/lock.js";
import { clearLegacyWalletLockArtifacts } from "../managed-core-wallet.js";
import { loadMiningRuntimeStatus } from "../mining/runtime-artifacts.js";
import { resolveWalletRuntimePathsForTesting, type WalletRuntimePaths } from "../runtime.js";
import {
  createDefaultWalletSecretProvider,
  createWalletSecretReference,
  type WalletSecretProvider,
} from "../state/provider.js";
import { loadWalletState } from "../state/storage.js";
import { recreateManagedCoreWalletReplica, verifyManagedCoreWalletReplica } from "./managed-core.js";
import {
  applyRepairStoppedMiningState,
  cleanupMiningForRepair,
  persistRepairState,
  resumeBackgroundMiningAfterRepair,
} from "./repair-mining.js";
import {
  clearIndexerDaemonArtifacts,
  clearManagedBitcoindArtifacts,
  clearOrphanedRepairLocks,
  ensureIndexerDatabaseHealthy,
  mapBitcoindCompatibilityToRepairIssue,
  mapBitcoindRepairHealth,
  mapIndexerCompatibilityToRepairIssue,
  verifyIndexerPostRepairHealth,
  waitForProcessExit,
} from "./repair-runtime.js";
import type {
  WalletRepairDependencies,
  WalletRepairResult,
} from "./types.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function repairWallet(options: {
  dataDir: string;
  databasePath: string;
  provider?: WalletSecretProvider;
  assumeYes?: boolean;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
} & WalletRepairDependencies): Promise<WalletRepairResult> {
  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const probeManagedBitcoind = options.probeBitcoindService ?? probeManagedBitcoindService;
  const attachManagedBitcoind = options.attachService ?? attachOrStartManagedBitcoindService;
  const probeManagedIndexerDaemon = options.probeIndexerDaemon ?? probeIndexerDaemon;
  const attachManagedIndexerDaemon = options.attachIndexerDaemon ?? attachOrStartIndexerDaemon;
  await clearOrphanedRepairLocks([
    paths.walletControlLockPath,
    paths.miningControlLockPath,
  ]);
  const controlLock = await acquireFileLock(paths.walletControlLockPath, {
    purpose: "wallet-repair",
    walletRootId: null,
  });

  try {
    let loaded;

    try {
      loaded = await loadWalletState({
        primaryPath: paths.walletStatePath,
        backupPath: paths.walletStateBackupPath,
      }, {
        provider,
      });
    } catch {
      throw new Error("local-state-corrupt");
    }

    const recoveredFromBackup = loaded.source === "backup";
    const secretReference = createWalletSecretReference(loaded.state.walletRootId);
    let repairedState = loaded.state;
    let repairStateNeedsPersist = false;
    const servicePaths = resolveManagedServicePaths(options.dataDir, repairedState.walletRootId);
    await clearOrphanedRepairLocks([
      servicePaths.bitcoindLockPath,
      servicePaths.indexerDaemonLockPath,
    ]);
    const preRepairMiningRuntime = await loadMiningRuntimeStatus(paths.miningStatusPath).catch(() => null);
    const miningCleanup = await cleanupMiningForRepair({
      paths,
      state: repairedState,
      snapshot: preRepairMiningRuntime,
      nowUnixMs,
    });
    const miningPreRepairRunMode = miningCleanup.preRepairRunMode;

    if (miningPreRepairRunMode !== "stopped" || preRepairMiningRuntime?.runMode !== "stopped") {
      repairedState = applyRepairStoppedMiningState(repairedState);
      repairStateNeedsPersist = true;
    }

    if (!(options.assumeYes ?? false)) {
      await ensureIndexerDatabaseHealthy({
        databasePath: options.databasePath,
        dataDir: options.dataDir,
        walletRootId: repairedState.walletRootId,
        resetIfNeeded: false,
      });
    }

    let bitcoindServiceAction: WalletRepairResult["bitcoindServiceAction"] = "none";
    let bitcoindCompatibilityIssue: WalletRepairResult["bitcoindCompatibilityIssue"] = "none";
    let managedCoreReplicaAction: WalletRepairResult["managedCoreReplicaAction"] = "none";
    let indexerDaemonAction: WalletRepairResult["indexerDaemonAction"] = "none";
    let indexerCompatibilityIssue: WalletRepairResult["indexerCompatibilityIssue"] = "none";
    let initialBitcoindProbe: Awaited<ReturnType<typeof probeManagedBitcoindService>> = {
      compatibility: "unreachable",
      status: null,
      error: null,
    };
    let resetIndexerDatabase = false;
    let bitcoindHandle = null as Awaited<ReturnType<typeof attachManagedBitcoind>> | null;
    let bitcoindPostRepairHealth: WalletRepairResult["bitcoindPostRepairHealth"] = "unavailable";

    const bitcoindLock = await acquireFileLock(servicePaths.bitcoindLockPath, {
      purpose: "managed-bitcoind-repair",
      walletRootId: repairedState.walletRootId,
      dataDir: options.dataDir,
    });

    try {
      initialBitcoindProbe = await probeManagedBitcoind({
        dataDir: options.dataDir,
        chain: "main",
        startHeight: 0,
        walletRootId: repairedState.walletRootId,
      });

      bitcoindCompatibilityIssue = mapBitcoindCompatibilityToRepairIssue(initialBitcoindProbe.compatibility);

      if (
        initialBitcoindProbe.compatibility === "service-version-mismatch"
        || initialBitcoindProbe.compatibility === "wallet-root-mismatch"
        || initialBitcoindProbe.compatibility === "runtime-mismatch"
      ) {
        const processId = initialBitcoindProbe.status?.processId ?? null;

        if (processId === null) {
          throw new Error("managed_bitcoind_process_id_unavailable");
        }

        try {
          process.kill(processId, "SIGTERM");
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ESRCH") {
            throw error;
          }
        }
        await waitForProcessExit(processId, 15_000, "managed_bitcoind_stop_timeout");
        await clearManagedBitcoindArtifacts(servicePaths);
        bitcoindServiceAction = "stopped-incompatible-service";
      } else if (initialBitcoindProbe.compatibility === "unreachable") {
        const hasStaleArtifacts = await Promise.all([
          servicePaths.bitcoindStatusPath,
          servicePaths.bitcoindPidPath,
          servicePaths.bitcoindReadyPath,
          servicePaths.bitcoindWalletStatusPath,
        ].map(pathExists));

        if (hasStaleArtifacts.some(Boolean)) {
          await clearManagedBitcoindArtifacts(servicePaths);
          bitcoindServiceAction = "cleared-stale-artifacts";
        }
      } else if (initialBitcoindProbe.compatibility === "protocol-error") {
        throw new Error(initialBitcoindProbe.error ?? "managed_bitcoind_protocol_error");
      }
    } finally {
      await bitcoindLock.release();
    }

    try {
      bitcoindHandle = await attachManagedBitcoind({
        dataDir: options.dataDir,
        chain: "main",
        startHeight: 0,
        walletRootId: repairedState.walletRootId,
      });
      const bitcoindRpc = (options.rpcFactory ?? createRpcClient)(bitcoindHandle.rpc);
      const normalizedDescriptorState = await normalizeWalletDescriptorState(repairedState, bitcoindRpc);

      if (normalizedDescriptorState.changed) {
        repairedState = normalizedDescriptorState.state;
        repairStateNeedsPersist = true;
      }
      const reconciledCoinControl = await persistWalletCoinControlStateIfNeeded({
        state: repairedState,
        access: {
          provider,
          secretReference,
        },
        paths,
        nowUnixMs,
        replacePrimary: recoveredFromBackup && !repairStateNeedsPersist,
        rpc: (options.rpcFactory ?? createRpcClient)(bitcoindHandle.rpc),
      });
      repairedState = reconciledCoinControl.state;
      if (reconciledCoinControl.changed) {
        repairStateNeedsPersist = false;
      }

      let replica = await verifyManagedCoreWalletReplica(repairedState, options.dataDir, {
        nodeHandle: bitcoindHandle,
        attachService: options.attachService,
        rpcFactory: options.rpcFactory,
      });
      let recreatedManagedCoreWallet = false;

      if (replica.proofStatus !== "ready") {
        repairedState = await recreateManagedCoreWalletReplica(
          repairedState,
          provider,
          paths,
          options.dataDir,
          nowUnixMs,
          {
            attachService: options.attachService,
            rpcFactory: options.rpcFactory,
          },
        );
        recreatedManagedCoreWallet = true;
        managedCoreReplicaAction = "recreated";
        repairStateNeedsPersist = false;
        replica = await verifyManagedCoreWalletReplica(repairedState, options.dataDir, {
          nodeHandle: bitcoindHandle,
          attachService: options.attachService,
          rpcFactory: options.rpcFactory,
        });
      }

      const finalBitcoindStatus = await bitcoindHandle.refreshServiceStatus?.() ?? null;
      const chainInfo = await bitcoindRpc.getBlockchainInfo();
      bitcoindPostRepairHealth = mapBitcoindRepairHealth({
        serviceState: finalBitcoindStatus?.state ?? null,
        catchingUp: chainInfo.blocks < chainInfo.headers,
        replica,
      });

      if (bitcoindServiceAction === "none" && initialBitcoindProbe.compatibility === "unreachable") {
        bitcoindServiceAction = "restarted-compatible-service";
      }

      let initialIndexerDaemonInstanceId: string | null = null;
      let preAttachIndexerDaemonInstanceId: string | null = null;

      const indexerLock = await acquireFileLock(servicePaths.indexerDaemonLockPath, {
        purpose: "indexer-daemon-repair",
        walletRootId: repairedState.walletRootId,
        dataDir: options.dataDir,
        databasePath: options.databasePath,
      });

      try {
        const initialProbe = await probeManagedIndexerDaemon({
          dataDir: options.dataDir,
          walletRootId: repairedState.walletRootId,
        });

        indexerCompatibilityIssue = mapIndexerCompatibilityToRepairIssue(initialProbe.compatibility);
        initialIndexerDaemonInstanceId = initialProbe.status?.daemonInstanceId ?? null;

        if (initialProbe.compatibility === "compatible") {
          await initialProbe.client?.close().catch(() => undefined);
        } else if (
          initialProbe.compatibility === "service-version-mismatch"
          || initialProbe.compatibility === "wallet-root-mismatch"
          || initialProbe.compatibility === "schema-mismatch"
        ) {
          const processId = initialProbe.status?.processId ?? null;

          if (processId === null) {
            throw new Error("indexer_daemon_process_id_unavailable");
          }

          try {
            process.kill(processId, "SIGTERM");
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ESRCH") {
              throw error;
            }
          }
          await waitForProcessExit(processId);
          await clearIndexerDaemonArtifacts(servicePaths);
          indexerDaemonAction = "stopped-incompatible-daemon";
        } else if (initialProbe.compatibility === "unreachable") {
          const hasStaleArtifacts = await Promise.all([
            servicePaths.indexerDaemonSocketPath,
            servicePaths.indexerDaemonStatusPath,
          ].map(pathExists));

          if (hasStaleArtifacts.some(Boolean)) {
            await clearIndexerDaemonArtifacts(servicePaths);
            indexerDaemonAction = "cleared-stale-artifacts";
          }
        } else {
          throw new Error(initialProbe.error ?? "indexer_daemon_protocol_error");
        }

        resetIndexerDatabase = await ensureIndexerDatabaseHealthy({
          databasePath: options.databasePath,
          dataDir: options.dataDir,
          walletRootId: repairedState.walletRootId,
          resetIfNeeded: options.assumeYes ?? false,
        });
      } finally {
        await indexerLock.release();
      }

      if (recoveredFromBackup) {
        repairedState = await persistRepairState({
          state: repairedState,
          provider,
          paths,
          nowUnixMs,
          replacePrimary: true,
        });
        repairStateNeedsPersist = false;
      } else if (repairStateNeedsPersist) {
        repairedState = await persistRepairState({
          state: repairedState,
          provider,
          paths,
          nowUnixMs,
        });
        repairStateNeedsPersist = false;
      }

      const preAttachProbe = await probeManagedIndexerDaemon({
        dataDir: options.dataDir,
        walletRootId: repairedState.walletRootId,
      });

      if (preAttachProbe.compatibility === "compatible") {
        preAttachIndexerDaemonInstanceId = preAttachProbe.status?.daemonInstanceId ?? null;
        await preAttachProbe.client?.close().catch(() => undefined);
      } else if (preAttachProbe.compatibility !== "unreachable") {
        throw new Error(preAttachProbe.error ?? "indexer_daemon_protocol_error");
      }

      const daemon = await attachManagedIndexerDaemon({
        dataDir: options.dataDir,
        databasePath: options.databasePath,
        walletRootId: repairedState.walletRootId,
      });

      try {
        const {
          health: indexerPostRepairHealth,
          daemonInstanceId: postRepairDaemonInstanceId,
        } = await verifyIndexerPostRepairHealth({
          daemon,
          probeIndexerDaemon: probeManagedIndexerDaemon,
          dataDir: options.dataDir,
          walletRootId: repairedState.walletRootId,
          nowUnixMs,
        });
        const restartedIndexerDaemon = indexerDaemonAction !== "none" || preAttachProbe.compatibility === "unreachable";

        if (
          restartedIndexerDaemon
          && initialIndexerDaemonInstanceId !== null
          && postRepairDaemonInstanceId === initialIndexerDaemonInstanceId
        ) {
          throw new Error("indexer_daemon_repair_identity_not_rotated");
        }

        if (
          !restartedIndexerDaemon
          && preAttachProbe.compatibility === "compatible"
          && preAttachIndexerDaemonInstanceId !== null
          && postRepairDaemonInstanceId !== preAttachIndexerDaemonInstanceId
        ) {
          throw new Error("indexer_daemon_repair_identity_changed");
        }

        if (indexerDaemonAction === "none" && preAttachProbe.compatibility === "unreachable") {
          indexerDaemonAction = "restarted-compatible-daemon";
        }

        const miningResume = await resumeBackgroundMiningAfterRepair({
          miningPreRepairRunMode,
          provider,
          paths,
          repairedState,
          bitcoindPostRepairHealth,
          indexerPostRepairHealth,
          dataDir: options.dataDir,
          databasePath: options.databasePath,
          startBackgroundMining: options.startBackgroundMining,
        });

        await clearLegacyWalletLockArtifacts(paths.walletRuntimeRoot);

        return {
          walletRootId: repairedState.walletRootId,
          recoveredFromBackup,
          recreatedManagedCoreWallet,
          resetIndexerDatabase,
          bitcoindServiceAction,
          bitcoindCompatibilityIssue,
          managedCoreReplicaAction,
          bitcoindPostRepairHealth,
          indexerDaemonAction,
          indexerCompatibilityIssue,
          indexerPostRepairHealth,
          miningPreRepairRunMode,
          miningResumeAction: miningResume.miningResumeAction,
          miningPostRepairRunMode: miningResume.miningPostRepairRunMode,
          miningResumeError: miningResume.miningResumeError,
          note: resetIndexerDatabase
            ? "Indexer artifacts were reset and may still be catching up."
            : null,
        };
      } finally {
        await daemon.close().catch(() => undefined);
      }
    } finally {
      await bitcoindHandle?.stop?.().catch(() => undefined);
    }
  } finally {
    await controlLock.release();
  }
}
