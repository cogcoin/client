import { deserializeIndexerState } from "@cogcoin/indexer";

import {
  attachOrStartIndexerDaemon,
  INDEXER_DAEMON_BACKGROUND_FOLLOW_RECOVERY_FAILED,
  probeIndexerDaemon,
  readObservedIndexerDaemonStatus,
  readSnapshotWithRetry,
  type IndexerDaemonClient,
} from "../../bitcoind/indexer-daemon.js";
import {
  deriveManagedIndexerWalletStatus,
  resolveIndexerDaemonProbeDecision,
} from "../../bitcoind/managed-runtime/indexer-policy.js";
import type { ManagedBitcoindNodeHandle, ManagedIndexerDaemonObservedStatus, ManagedIndexerDaemonStatus, ManagedIndexerTruthSource } from "../../bitcoind/types.js";
import type { WalletIndexerStatus, WalletSnapshotView } from "./types.js";

export type ManagedWalletIndexerReadDeps = {
  probeIndexerDaemon: typeof probeIndexerDaemon;
  attachOrStartIndexerDaemon: typeof attachOrStartIndexerDaemon;
  readSnapshotWithRetry: typeof readSnapshotWithRetry;
  readObservedIndexerDaemonStatus: typeof readObservedIndexerDaemonStatus;
};

const defaultManagedWalletIndexerReadDeps: ManagedWalletIndexerReadDeps = {
  probeIndexerDaemon,
  attachOrStartIndexerDaemon,
  readSnapshotWithRetry,
  readObservedIndexerDaemonStatus,
};

export interface ManagedWalletIndexerReadState {
  daemonClient: IndexerDaemonClient | null;
  indexer: WalletIndexerStatus;
  snapshot: WalletSnapshotView | null;
}

export async function openManagedWalletIndexerReadState(options: {
  dataDir: string;
  databasePath: string;
  walletRootId: string;
  startupTimeoutMs: number;
  expectedIndexerBinaryVersion: string | null;
  now: number;
  nodeHandle: ManagedBitcoindNodeHandle | null;
}, dependencies: ManagedWalletIndexerReadDeps = defaultManagedWalletIndexerReadDeps): Promise<ManagedWalletIndexerReadState> {
  let daemonClient: IndexerDaemonClient | null = null;
  let daemonStatus: ManagedIndexerDaemonStatus | null = null;
  let observedDaemonStatus: ManagedIndexerDaemonObservedStatus | null = null;
  let snapshot: WalletSnapshotView | null = null;
  let indexerSource: ManagedIndexerTruthSource = "none";
  let daemonError: string | null = null;

  try {
    const probe = await dependencies.probeIndexerDaemon({
      dataDir: options.dataDir,
      walletRootId: options.walletRootId,
    });
    const probeDecision = resolveIndexerDaemonProbeDecision({
      probe,
      expectedBinaryVersion: options.expectedIndexerBinaryVersion,
    });

    if (probeDecision.action !== "reject") {
      await probe.client?.close().catch(() => undefined);
      daemonClient = await dependencies.attachOrStartIndexerDaemon({
        dataDir: options.dataDir,
        databasePath: options.databasePath,
        walletRootId: options.walletRootId,
        startupTimeoutMs: options.startupTimeoutMs,
        ensureBackgroundFollow: true,
        expectedBinaryVersion: options.expectedIndexerBinaryVersion,
      });
    } else {
      observedDaemonStatus = probe.status;
      indexerSource = probe.status === null ? "none" : "probe";
      daemonError = probeDecision.error;
    }

    if (daemonClient !== null) {
      const lease = await dependencies.readSnapshotWithRetry(daemonClient, options.walletRootId);
      daemonStatus = lease.status;
      observedDaemonStatus = lease.status;
      snapshot = {
        tip: lease.payload.tip,
        state: deserializeIndexerState(Buffer.from(lease.payload.stateBase64, "base64")),
        source: "lease",
        daemonInstanceId: lease.payload.daemonInstanceId,
        snapshotSeq: lease.payload.snapshotSeq,
        openedAtUnixMs: lease.payload.openedAtUnixMs,
      };
      indexerSource = "lease";
    }
  } catch (error) {
    daemonError = error instanceof Error ? error.message : String(error);

    if (daemonError === INDEXER_DAEMON_BACKGROUND_FOLLOW_RECOVERY_FAILED) {
      await daemonClient?.close().catch(() => undefined);
      await options.nodeHandle?.stop().catch(() => undefined);
      throw error;
    }

    if (observedDaemonStatus === null) {
      observedDaemonStatus = await dependencies.readObservedIndexerDaemonStatus({
        dataDir: options.dataDir,
        walletRootId: options.walletRootId,
      }).catch(() => null);

      if (observedDaemonStatus !== null) {
        indexerSource = "status-file";
      }
    }
  }

  const indexer = deriveManagedIndexerWalletStatus({
    daemonStatus,
    observedStatus: observedDaemonStatus,
    snapshot,
    source: indexerSource,
    now: options.now,
    startupError: daemonError,
  });

  return {
    daemonClient,
    indexer,
    snapshot,
  };
}
