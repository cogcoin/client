import { resolveManagedServicePaths } from "../../bitcoind/service-paths.js";
import { clearLegacyWalletLockArtifacts } from "../managed-core-wallet.js";
import { loadMiningRuntimeStatus } from "../mining/runtime-artifacts.js";
import { loadWalletState } from "../state/storage.js";
import type { WalletStateV1 } from "../types.js";
import {
  acquireWalletControlLock,
  resolveWalletRepairContext,
} from "./context.js";
import { repairManagedBitcoindStage } from "./repair-bitcoind.js";
import { repairManagedIndexerStage } from "./repair-indexer.js";
import {
  applyRepairStoppedMiningState,
  cleanupMiningForRepair,
  persistRepairState,
  resumeBackgroundMiningAfterRepair,
} from "./repair-mining.js";
import {
  clearOrphanedRepairLocks,
  ensureIndexerDatabaseHealthy,
} from "./repair-runtime.js";
import type {
  WalletRepairDependencies,
  WalletRepairResult,
} from "./types.js";

export async function repairWallet(options: {
  dataDir: string;
  databasePath: string;
  provider?: import("../state/provider.js").WalletSecretProvider;
  assumeYes?: boolean;
  nowUnixMs?: number;
  paths?: import("../runtime.js").WalletRuntimePaths;
} & WalletRepairDependencies): Promise<WalletRepairResult> {
  const context = resolveWalletRepairContext(options);
  await clearOrphanedRepairLocks([
    context.paths.walletControlLockPath,
    context.paths.miningControlLockPath,
  ]);
  const controlLock = await acquireWalletControlLock(context.paths, "wallet-repair");

  try {
    let loaded;

    try {
      loaded = await loadWalletState({
        primaryPath: context.paths.walletStatePath,
        backupPath: context.paths.walletStateBackupPath,
      }, {
        provider: context.provider,
      });
    } catch {
      throw new Error("local-state-corrupt");
    }

    const recoveredFromBackup = loaded.source === "backup";
    let repairedState: WalletStateV1 = loaded.state;
    let repairStateNeedsPersist = false;
    const servicePaths = resolveManagedServicePaths(context.dataDir, repairedState.walletRootId);

    await clearOrphanedRepairLocks([
      servicePaths.bitcoindLockPath,
      servicePaths.indexerDaemonLockPath,
    ]);

    const preRepairMiningRuntime = await loadMiningRuntimeStatus(context.paths.miningStatusPath).catch(() => null);
    const miningCleanup = await cleanupMiningForRepair({
      paths: context.paths,
      state: repairedState,
      snapshot: preRepairMiningRuntime,
      nowUnixMs: context.nowUnixMs,
    });
    const miningPreRepairRunMode = miningCleanup.preRepairRunMode;

    if (miningPreRepairRunMode !== "stopped" || preRepairMiningRuntime?.runMode !== "stopped") {
      repairedState = applyRepairStoppedMiningState(repairedState);
      repairStateNeedsPersist = true;
    }

    if (!context.assumeYes) {
      await ensureIndexerDatabaseHealthy({
        databasePath: context.databasePath,
        dataDir: context.dataDir,
        walletRootId: repairedState.walletRootId,
        resetIfNeeded: false,
      });
    }

    const bitcoindStage = await repairManagedBitcoindStage({
      context,
      servicePaths,
      state: repairedState,
      recoveredFromBackup,
      repairStateNeedsPersist,
    });
    repairedState = bitcoindStage.state;
    repairStateNeedsPersist = bitcoindStage.repairStateNeedsPersist;

    if (recoveredFromBackup) {
      repairedState = await persistRepairState({
        state: repairedState,
        provider: context.provider,
        paths: context.paths,
        nowUnixMs: context.nowUnixMs,
        replacePrimary: true,
      });
      repairStateNeedsPersist = false;
    } else if (repairStateNeedsPersist) {
      repairedState = await persistRepairState({
        state: repairedState,
        provider: context.provider,
        paths: context.paths,
        nowUnixMs: context.nowUnixMs,
      });
      repairStateNeedsPersist = false;
    }

    const indexerStage = await repairManagedIndexerStage({
      context,
      servicePaths,
      state: repairedState,
    });

    const miningResume = await resumeBackgroundMiningAfterRepair({
      miningPreRepairRunMode,
      provider: context.provider,
      paths: context.paths,
      repairedState,
      bitcoindPostRepairHealth: bitcoindStage.bitcoindPostRepairHealth,
      indexerPostRepairHealth: indexerStage.indexerPostRepairHealth,
    });

    await clearLegacyWalletLockArtifacts(context.paths.walletRuntimeRoot);

    return {
      walletRootId: repairedState.walletRootId,
      recoveredFromBackup,
      recreatedManagedCoreWallet: bitcoindStage.recreatedManagedCoreWallet,
      resetIndexerDatabase: indexerStage.resetIndexerDatabase,
      bitcoindServiceAction: bitcoindStage.bitcoindServiceAction,
      bitcoindCompatibilityIssue: bitcoindStage.bitcoindCompatibilityIssue,
      managedCoreReplicaAction: bitcoindStage.managedCoreReplicaAction,
      bitcoindPostRepairHealth: bitcoindStage.bitcoindPostRepairHealth,
      indexerDaemonAction: indexerStage.indexerDaemonAction,
      indexerCompatibilityIssue: indexerStage.indexerCompatibilityIssue,
      indexerPostRepairHealth: indexerStage.indexerPostRepairHealth,
      miningPreRepairRunMode,
      miningResumeAction: miningResume.miningResumeAction,
      miningPostRepairRunMode: miningResume.miningPostRepairRunMode,
      miningResumeError: miningResume.miningResumeError,
      note: indexerStage.resetIndexerDatabase
        ? "Indexer artifacts were reset and may still be catching up."
        : null,
    };
  } finally {
    await controlLock.release();
  }
}
