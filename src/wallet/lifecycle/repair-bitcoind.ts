import type { ManagedServicePaths } from "../../bitcoind/service-paths.js";
import { normalizeWalletDescriptorState } from "../descriptor-normalization.js";
import { acquireFileLock } from "../fs/lock.js";
import type { WalletStateV1 } from "../types.js";
import { persistWalletCoinControlStateIfNeeded } from "../coin-control.js";
import { createWalletSecretReference } from "../state/provider.js";
import { recreateManagedCoreWalletReplica, verifyManagedCoreWalletReplica } from "./managed-core.js";
import { pathExists } from "./context.js";
import {
  clearManagedBitcoindArtifacts,
  mapBitcoindCompatibilityToRepairIssue,
  mapBitcoindRepairHealth,
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

  const bitcoindLock = await acquireFileLock(options.servicePaths.bitcoindLockPath, {
    purpose: "managed-bitcoind-repair",
    walletRootId: state.walletRootId,
    dataDir: options.context.dataDir,
  });

  try {
    initialBitcoindProbe = await options.context.probeBitcoindService({
      dataDir: options.context.dataDir,
      chain: "main",
      startHeight: 0,
      walletRootId: state.walletRootId,
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
      await clearManagedBitcoindArtifacts(options.servicePaths);
      bitcoindServiceAction = "stopped-incompatible-service";
    } else if (initialBitcoindProbe.compatibility === "unreachable") {
      const hasStaleArtifacts = await Promise.all([
        options.servicePaths.bitcoindStatusPath,
        options.servicePaths.bitcoindPidPath,
        options.servicePaths.bitcoindReadyPath,
        options.servicePaths.bitcoindWalletStatusPath,
      ].map(pathExists));

      if (hasStaleArtifacts.some(Boolean)) {
        await clearManagedBitcoindArtifacts(options.servicePaths);
        bitcoindServiceAction = "cleared-stale-artifacts";
      }
    } else if (initialBitcoindProbe.compatibility === "protocol-error") {
      throw new Error(initialBitcoindProbe.error ?? "managed_bitcoind_protocol_error");
    }
  } finally {
    await bitcoindLock.release();
  }

  const bitcoindHandle = await options.context.attachService({
    dataDir: options.context.dataDir,
    chain: "main",
    startHeight: 0,
    walletRootId: state.walletRootId,
  });

  try {
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
  } finally {
    await bitcoindHandle.stop?.().catch(() => undefined);
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
}
