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
  reportRepairProgress,
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
      await reportRepairProgress(context, "wallet-check", "Checking wallet state...");
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

    await reportRepairProgress(context, "lock-cleanup", "Checking repair locks...");
    await clearOrphanedRepairLocks([
      servicePaths.bitcoindLockPath,
      servicePaths.indexerDaemonLockPath,
    ]);

    await reportRepairProgress(context, "mining-cleanup", "Checking mining runtime...");
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
      await reportRepairProgress(context, "indexer-database-check", "Checking local indexer database...");
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

    const repairNotes: string[] = [];

    if (bitcoindStage.bitcoindPostRepairHealth === "starting") {
      repairNotes.push("Managed bitcoind was restarted and is still loading the block index; rerun mining after it reaches ready.");
    }

    if (recoveredFromBackup) {
      await reportRepairProgress(context, "wallet-state-persist", "Persisting repaired wallet state...");
      repairedState = await persistRepairState({
        state: repairedState,
        provider: context.provider,
        paths: context.paths,
        nowUnixMs: context.nowUnixMs,
        replacePrimary: true,
      });
      repairStateNeedsPersist = false;
    } else if (repairStateNeedsPersist) {
      await reportRepairProgress(context, "wallet-state-persist", "Persisting repaired wallet state...");
      repairedState = await persistRepairState({
        state: repairedState,
        provider: context.provider,
        paths: context.paths,
        nowUnixMs: context.nowUnixMs,
      });
      repairStateNeedsPersist = false;
    }

    const indexerStage = bitcoindStage.bitcoindPostRepairHealth === "starting"
      ? {
        resetIndexerDatabase: false,
        indexerDaemonAction: "none" as const,
        indexerCompatibilityIssue: "none" as const,
        indexerPostRepairHealth: "starting" as const,
      }
      : await (async () => {
        await reportRepairProgress(context, "indexer-check", "Checking indexer...");
        return repairManagedIndexerStage({
          context,
          servicePaths,
          state: repairedState,
        });
      })();

    if (indexerStage.resetIndexerDatabase) {
      repairNotes.push("Indexer artifacts were reset and may still be catching up.");
    }

    await reportRepairProgress(context, "mining-resume", "Checking whether mining should resume...");
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
      note: repairNotes.length > 0 ? repairNotes.join(" ") : null,
    };
  } finally {
    await controlLock.release();
  }
}
