import type { ManagedServicePaths } from "../../bitcoind/service-paths.js";
import { acquireFileLock } from "../fs/lock.js";
import type { WalletStateV1 } from "../types.js";
import { pathExists } from "./context.js";
import {
  clearIndexerDaemonArtifacts,
  ensureIndexerDatabaseHealthy,
  mapIndexerCompatibilityToRepairIssue,
  verifyIndexerPostRepairHealth,
  waitForProcessExit,
} from "./repair-runtime.js";
import type {
  WalletIndexerRepairStageResult,
  WalletRepairContext,
} from "./types.js";

export async function repairManagedIndexerStage(options: {
  context: WalletRepairContext;
  servicePaths: ManagedServicePaths;
  state: WalletStateV1;
}): Promise<WalletIndexerRepairStageResult> {
  let indexerDaemonAction: WalletIndexerRepairStageResult["indexerDaemonAction"] = "none";
  let indexerCompatibilityIssue: WalletIndexerRepairStageResult["indexerCompatibilityIssue"] = "none";
  let initialIndexerDaemonInstanceId: string | null = null;

  const indexerLock = await acquireFileLock(options.servicePaths.indexerDaemonLockPath, {
    purpose: "indexer-daemon-repair",
    walletRootId: options.state.walletRootId,
    dataDir: options.context.dataDir,
    databasePath: options.context.databasePath,
  });

  let resetIndexerDatabase = false;

  try {
    const initialProbe = await options.context.probeIndexerDaemon({
      dataDir: options.context.dataDir,
      walletRootId: options.state.walletRootId,
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
      await clearIndexerDaemonArtifacts(options.servicePaths);
      indexerDaemonAction = "stopped-incompatible-daemon";
    } else if (initialProbe.compatibility === "unreachable") {
      const hasStaleArtifacts = await Promise.all([
        options.servicePaths.indexerDaemonSocketPath,
        options.servicePaths.indexerDaemonStatusPath,
      ].map(pathExists));

      if (hasStaleArtifacts.some(Boolean)) {
        await clearIndexerDaemonArtifacts(options.servicePaths);
        indexerDaemonAction = "cleared-stale-artifacts";
      }
    } else {
      throw new Error(initialProbe.error ?? "indexer_daemon_protocol_error");
    }

    resetIndexerDatabase = await ensureIndexerDatabaseHealthy({
      databasePath: options.context.databasePath,
      dataDir: options.context.dataDir,
      walletRootId: options.state.walletRootId,
      resetIfNeeded: options.context.assumeYes,
    });
  } finally {
    await indexerLock.release();
  }

  let preAttachIndexerDaemonInstanceId: string | null = null;
  const preAttachProbe = await options.context.probeIndexerDaemon({
    dataDir: options.context.dataDir,
    walletRootId: options.state.walletRootId,
  });

  if (preAttachProbe.compatibility === "compatible") {
    preAttachIndexerDaemonInstanceId = preAttachProbe.status?.daemonInstanceId ?? null;
    await preAttachProbe.client?.close().catch(() => undefined);
  } else if (preAttachProbe.compatibility !== "unreachable") {
    throw new Error(preAttachProbe.error ?? "indexer_daemon_protocol_error");
  }

  const daemon = await options.context.attachIndexerDaemon({
    dataDir: options.context.dataDir,
    databasePath: options.context.databasePath,
    walletRootId: options.state.walletRootId,
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

    return {
      resetIndexerDatabase,
      indexerDaemonAction,
      indexerCompatibilityIssue,
      indexerPostRepairHealth,
    };
  } finally {
    await daemon.close().catch(() => undefined);
  }
}
