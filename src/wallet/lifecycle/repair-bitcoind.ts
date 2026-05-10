import type { ManagedServicePaths } from "../../bitcoind/service-paths.js";
import { normalizeWalletDescriptorState } from "../descriptor-normalization.js";
import { acquireFileLock } from "../fs/lock.js";
import type { WalletStateV1 } from "../types.js";
import { persistWalletCoinControlStateIfNeeded } from "../coin-control.js";
import { createWalletSecretReference } from "../state/provider.js";
import { recreateManagedCoreWalletReplica, verifyManagedCoreWalletReplica } from "./managed-core.js";
import { pathExists } from "./context.js";
import {
  clearManagedBitcoindArtifactsForDataDir,
  isManagedBitcoindRpcUnavailableError,
  isManagedBitcoindStartupWarmupError,
  mapBitcoindCompatibilityToRepairIssue,
  mapBitcoindRepairHealth,
  reportRepairProgress,
  waitForProcessExit,
} from "./repair-runtime.js";
import type {
  WalletBitcoindRepairStageResult,
  WalletRepairContext,
} from "./types.js";

export async function repairManagedBitcoindStage(options: {
  context: WalletRepairContext;
  servicePaths: ManagedServicePaths;
  state: WalletStateV1;
  recoveredFromBackup: boolean;
  repairStateNeedsPersist: boolean;
}): Promise<WalletBitcoindRepairStageResult> {
  let state = options.state;
  let repairStateNeedsPersist = options.repairStateNeedsPersist;
  let bitcoindServiceAction: WalletBitcoindRepairStageResult["bitcoindServiceAction"] = "none";
  let bitcoindCompatibilityIssue: WalletBitcoindRepairStageResult["bitcoindCompatibilityIssue"] = "none";
  let managedCoreReplicaAction: WalletBitcoindRepairStageResult["managedCoreReplicaAction"] = "none";
  let recreatedManagedCoreWallet = false;
  let initialBitcoindProbe: Awaited<ReturnType<WalletRepairContext["probeBitcoindService"]>> = {
    compatibility: "unreachable",
    status: null,
    error: null,
  };
  let bitcoindPostRepairHealth: WalletBitcoindRepairStageResult["bitcoindPostRepairHealth"] = "unavailable";
  const rpcReadyProgress = async (event: { code: string; message: string }) => {
    await reportRepairProgress(options.context, event.code, event.message);
  };

  const bitcoindLock = await acquireFileLock(options.servicePaths.bitcoindLockPath, {
    purpose: "managed-bitcoind-repair",
    walletRootId: state.walletRootId,
    dataDir: options.context.dataDir,
  });

  try {
    await reportRepairProgress(options.context, "bitcoind-check", "Checking managed bitcoind...");
    initialBitcoindProbe = await options.context.probeBitcoindService({
      dataDir: options.context.dataDir,
      chain: "main",
      startHeight: 0,
      walletRootId: state.walletRootId,
      rpcReadyProgress,
    });

    bitcoindCompatibilityIssue = mapBitcoindCompatibilityToRepairIssue(initialBitcoindProbe.compatibility);

    if (initialBitcoindProbe.compatibility === "starting") {
      await reportRepairProgress(
        options.context,
        "bitcoind-starting",
        "Bitcoin Core is loading the block index; leaving managed bitcoind running.",
      );
      return {
        state,
        repairStateNeedsPersist,
        recreatedManagedCoreWallet,
        bitcoindServiceAction,
        bitcoindCompatibilityIssue,
        managedCoreReplicaAction,
        bitcoindPostRepairHealth: "starting",
      };
    }

    if (
      initialBitcoindProbe.compatibility === "service-version-mismatch"
      || initialBitcoindProbe.compatibility === "wallet-root-mismatch"
      || initialBitcoindProbe.compatibility === "runtime-mismatch"
      || initialBitcoindProbe.compatibility === "rawtx-zmq-missing"
    ) {
      const processId = initialBitcoindProbe.status?.processId ?? null;

      if (processId === null) {
        if (initialBitcoindProbe.compatibility !== "rawtx-zmq-missing") {
          throw new Error("managed_bitcoind_process_id_unavailable");
        }

        await reportRepairProgress(
          options.context,
          "bitcoind-clear-stale-rawtx",
          "Clearing stale managed bitcoind runtime missing rawtx ZMQ...",
        );
        await clearManagedBitcoindArtifactsForDataDir(options.servicePaths, options.context.dataDir);
        bitcoindServiceAction = "restarted-missing-rawtx-zmq";
      } else {
        await reportRepairProgress(
          options.context,
          "bitcoind-stop-incompatible",
          initialBitcoindProbe.compatibility === "rawtx-zmq-missing"
            ? "Stopping stale managed bitcoind missing rawtx ZMQ..."
            : "Stopping incompatible managed bitcoind service...",
        );
        try {
          process.kill(processId, "SIGTERM");
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ESRCH") {
            throw error;
          }
        }

        await waitForProcessExit(processId, 15_000, "managed_bitcoind_stop_timeout");
        await reportRepairProgress(options.context, "bitcoind-clear-artifacts", "Clearing managed bitcoind runtime artifacts...");
        await clearManagedBitcoindArtifactsForDataDir(options.servicePaths, options.context.dataDir);
        bitcoindServiceAction = initialBitcoindProbe.compatibility === "rawtx-zmq-missing"
          ? "restarted-missing-rawtx-zmq"
          : "stopped-incompatible-service";
      }
    } else if (initialBitcoindProbe.compatibility === "unreachable") {
      const hasStaleArtifacts = await Promise.all([
        options.servicePaths.bitcoindStatusPath,
        options.servicePaths.bitcoindPidPath,
        options.servicePaths.bitcoindReadyPath,
        options.servicePaths.bitcoindRuntimeConfigPath,
        options.servicePaths.bitcoindWalletStatusPath,
      ].map(pathExists));

      if (hasStaleArtifacts.some(Boolean)) {
        await reportRepairProgress(options.context, "bitcoind-clear-stale", "Clearing stale managed bitcoind artifacts...");
        await clearManagedBitcoindArtifactsForDataDir(options.servicePaths, options.context.dataDir);
        bitcoindServiceAction = "cleared-stale-artifacts";
      }
    } else if (initialBitcoindProbe.compatibility === "protocol-error") {
      throw new Error(initialBitcoindProbe.error ?? "managed_bitcoind_protocol_error");
    }
  } finally {
    await bitcoindLock.release();
  }

  for (let attachAttempt = 0; attachAttempt < 2; attachAttempt += 1) {
    let bitcoindHandle: Awaited<ReturnType<WalletRepairContext["attachService"]>> | null = null;
    let handleClosed = false;

    try {
      await reportRepairProgress(
        options.context,
        attachAttempt === 0 ? "bitcoind-start" : "bitcoind-retry-start",
        bitcoindServiceAction === "none"
          ? "Attaching to managed bitcoind..."
          : "Starting managed bitcoind with current ZMQ config...",
      );
      bitcoindHandle = await options.context.attachService({
        dataDir: options.context.dataDir,
        chain: "main",
        startHeight: 0,
        walletRootId: state.walletRootId,
        rpcReadyProgress,
      });

      await reportRepairProgress(options.context, "bitcoind-normalize-wallet", "Checking managed Bitcoin wallet state...");
      const rpc = options.context.rpcFactory(bitcoindHandle.rpc);
      const normalizedDescriptorState = await normalizeWalletDescriptorState(state, rpc);

      if (normalizedDescriptorState.changed) {
        state = normalizedDescriptorState.state;
        repairStateNeedsPersist = true;
      }

      const reconciledCoinControl = await persistWalletCoinControlStateIfNeeded({
        state,
        access: {
          provider: options.context.provider,
          secretReference: createWalletSecretReference(state.walletRootId),
        },
        paths: options.context.paths,
        nowUnixMs: options.context.nowUnixMs,
        replacePrimary: options.recoveredFromBackup && !repairStateNeedsPersist,
        rpc,
      });
      state = reconciledCoinControl.state;

      if (reconciledCoinControl.changed) {
        repairStateNeedsPersist = false;
      }

      let replica = await verifyManagedCoreWalletReplica(state, options.context.dataDir, {
        nodeHandle: bitcoindHandle,
        attachService: options.context.attachService,
        rpcFactory: options.context.rpcFactory,
      });

      if (replica.proofStatus !== "ready") {
        await reportRepairProgress(options.context, "bitcoind-recreate-replica", "Recreating managed Core wallet replica...");
        state = await recreateManagedCoreWalletReplica(
          state,
          options.context.provider,
          options.context.paths,
          options.context.dataDir,
          options.context.nowUnixMs,
          {
            attachService: options.context.attachService,
            rpcFactory: options.context.rpcFactory,
          },
        );
        recreatedManagedCoreWallet = true;
        managedCoreReplicaAction = "recreated";
        repairStateNeedsPersist = false;
        replica = await verifyManagedCoreWalletReplica(state, options.context.dataDir, {
          nodeHandle: bitcoindHandle,
          attachService: options.context.attachService,
          rpcFactory: options.context.rpcFactory,
        });
      }

      await reportRepairProgress(options.context, "bitcoind-final-health", "Checking managed bitcoind post-repair health...");
      const finalBitcoindStatus = await bitcoindHandle.refreshServiceStatus?.() ?? null;
      const chainInfo = await rpc.getBlockchainInfo();
      bitcoindPostRepairHealth = mapBitcoindRepairHealth({
        serviceState: finalBitcoindStatus?.state ?? null,
        catchingUp: chainInfo.blocks < chainInfo.headers,
        replica,
      });

      if (bitcoindServiceAction === "none" && initialBitcoindProbe.compatibility === "unreachable") {
        bitcoindServiceAction = "restarted-compatible-service";
      }

      return {
        state,
        repairStateNeedsPersist,
        recreatedManagedCoreWallet,
        bitcoindServiceAction,
        bitcoindCompatibilityIssue,
        managedCoreReplicaAction,
        bitcoindPostRepairHealth,
      };
    } catch (error) {
      if (isManagedBitcoindStartupWarmupError(error)) {
        await reportRepairProgress(
          options.context,
          "bitcoind-starting",
          "Bitcoin Core is loading the block index; leaving managed bitcoind running.",
        );
        return {
          state,
          repairStateNeedsPersist,
          recreatedManagedCoreWallet,
          bitcoindServiceAction,
          bitcoindCompatibilityIssue,
          managedCoreReplicaAction,
          bitcoindPostRepairHealth: "starting",
        };
      }

      if (bitcoindHandle !== null) {
        await bitcoindHandle.stop?.().catch(() => undefined);
        handleClosed = true;
      }

      if (attachAttempt === 0 && isManagedBitcoindRpcUnavailableError(error)) {
        const retryLock = await acquireFileLock(options.servicePaths.bitcoindLockPath, {
          purpose: "managed-bitcoind-repair-stale-rpc",
          walletRootId: state.walletRootId,
          dataDir: options.context.dataDir,
        });

        try {
          await reportRepairProgress(options.context, "bitcoind-clear-stale-rpc", "Clearing stale managed bitcoind RPC artifacts...");
          await clearManagedBitcoindArtifactsForDataDir(options.servicePaths, options.context.dataDir);
        } finally {
          await retryLock.release();
        }

        if (bitcoindServiceAction === "none") {
          bitcoindServiceAction = "restarted-compatible-service";
        }

        continue;
      }

      throw error;
    } finally {
      if (!handleClosed) {
        await bitcoindHandle?.stop?.().catch(() => undefined);
      }
    }
  }

  throw new Error("managed_bitcoind_repair_retry_exhausted");
}
