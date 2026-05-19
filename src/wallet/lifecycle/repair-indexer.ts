import type { ManagedServicePaths } from "../../bitcoind/service-paths.js";
import { acquireFileLock } from "../fs/lock.js";
import type { WalletStateV1 } from "../types.js";
import {
  clearIndexerDaemonArtifacts,
  ensureIndexerDatabaseHealthy,
  mapIndexerCompatibilityToRepairIssue,
  reportRepairProgress,
  stopRecordedManagedProcess,
  verifyIndexerPostRepairHealth,
} from "./repair-runtime.js";
import type {
  WalletIndexerRepairStageResult,
  WalletRepairContext,
  WalletRepairResult,
} from "./types.js";

export interface WalletIndexerRepairPreparationResult {
  resetIndexerDatabase: boolean;
  indexerDaemonAction: WalletRepairResult["indexerDaemonAction"];
  indexerCompatibilityIssue: WalletRepairResult["indexerCompatibilityIssue"];
  initialIndexerDaemonInstanceId: string | null;
}

export async function prepareManagedIndexerForRepair(options: {
  context: WalletRepairContext;
  servicePaths: ManagedServicePaths;
  state: WalletStateV1;
}): Promise<WalletIndexerRepairPreparationResult> {
  const indexerDaemonAction: WalletRepairResult["indexerDaemonAction"] = "restarted-managed-daemon";
  let indexerCompatibilityIssue: WalletRepairResult["indexerCompatibilityIssue"] = "none";
  let initialIndexerDaemonInstanceId: string | null = null;

  const indexerLock = await acquireFileLock(options.servicePaths.indexerDaemonLockPath, {
    purpose: "indexer-daemon-repair",
    walletRootId: options.state.walletRootId,
    dataDir: options.context.dataDir,
    databasePath: options.context.databasePath,
  });

  let resetIndexerDatabase = false;

  try {
    await reportRepairProgress(options.context, "indexer-check", "Checking indexer...");
    const initialProbe = await options.context.probeIndexerDaemon({
      dataDir: options.context.dataDir,
      walletRootId: options.state.walletRootId,
    });

    indexerCompatibilityIssue = mapIndexerCompatibilityToRepairIssue(initialProbe.compatibility);
    initialIndexerDaemonInstanceId = initialProbe.status?.daemonInstanceId ?? null;

    if (initialProbe.compatibility === "protocol-error") {
      throw new Error(initialProbe.error ?? "indexer_daemon_protocol_error");
    }

    if (initialProbe.compatibility !== "unreachable") {
      const processId = initialProbe.status?.processId ?? null;

      if (processId === null) {
        throw new Error("indexer_daemon_process_id_unavailable");
      }

      await reportRepairProgress(
        options.context,
        "indexer-stop-managed",
        initialProbe.compatibility === "compatible"
          ? "Stopping managed indexer daemon for repair..."
          : "Stopping incompatible managed indexer daemon...",
      );
      await initialProbe.client?.close().catch(() => undefined);
      await stopRecordedManagedProcess(processId, "indexer_daemon_stop_timeout");
    }

    await reportRepairProgress(options.context, "indexer-clear-artifacts", "Clearing managed indexer runtime artifacts...");
    await clearIndexerDaemonArtifacts(options.servicePaths);
    await reportRepairProgress(options.context, "indexer-database-check", "Checking local indexer database...");
    resetIndexerDatabase = await ensureIndexerDatabaseHealthy({
      databasePath: options.context.databasePath,
      dataDir: options.context.dataDir,
      walletRootId: options.state.walletRootId,
      resetIfNeeded: options.context.assumeYes,
    });
  } finally {
    await indexerLock.release();
  }

  return {
    resetIndexerDatabase,
    indexerDaemonAction,
    indexerCompatibilityIssue,
    initialIndexerDaemonInstanceId,
  };
}

export async function startManagedIndexerAfterRepair(options: {
  context: WalletRepairContext;
  servicePaths: ManagedServicePaths;
  state: WalletStateV1;
  preparation: WalletIndexerRepairPreparationResult;
}): Promise<WalletIndexerRepairStageResult> {
  await reportRepairProgress(options.context, "indexer-start", "Starting managed indexer daemon...");
  const daemon = await options.context.attachIndexerDaemon({
    dataDir: options.context.dataDir,
    databasePath: options.context.databasePath,
    walletRootId: options.state.walletRootId,
    ensureBackgroundFollow: true,
  });

  try {
    const {
      health: indexerPostRepairHealth,
      daemonInstanceId: postRepairDaemonInstanceId,
    } = await verifyIndexerPostRepairHealth({
      daemon,
      probeIndexerDaemon: options.context.probeIndexerDaemon,
      dataDir: options.context.dataDir,
      walletRootId: options.state.walletRootId,
      nowUnixMs: options.context.nowUnixMs,
    });

    if (
      options.preparation.initialIndexerDaemonInstanceId !== null
      && postRepairDaemonInstanceId === options.preparation.initialIndexerDaemonInstanceId
    ) {
      throw new Error("indexer_daemon_repair_identity_not_rotated");
    }

    return {
      resetIndexerDatabase: options.preparation.resetIndexerDatabase,
      indexerDaemonAction: options.preparation.indexerDaemonAction,
      indexerCompatibilityIssue: options.preparation.indexerCompatibilityIssue,
      indexerPostRepairHealth,
    };
  } finally {
    await daemon.close().catch(() => undefined);
  }
}

export async function repairManagedIndexerStage(options: {
  context: WalletRepairContext;
  servicePaths: ManagedServicePaths;
  state: WalletStateV1;
}): Promise<WalletIndexerRepairStageResult> {
  const preparation = await prepareManagedIndexerForRepair(options);

  return await startManagedIndexerAfterRepair({
    ...options,
    preparation,
  });
}
