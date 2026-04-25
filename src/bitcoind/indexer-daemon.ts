export {
  attachOrStartIndexerDaemon,
  INDEXER_DAEMON_BACKGROUND_FOLLOW_RECOVERY_FAILED,
  probeIndexerDaemon,
  readObservedIndexerDaemonStatus,
  readSnapshotWithRetry,
  stopIndexerDaemonService,
} from "./indexer-daemon/lifecycle.js";
export {
  readIndexerDaemonStatusForTesting,
  shutdownIndexerDaemonForTesting,
  stopIndexerDaemonServiceWithLockHeld,
  writeIndexerDaemonStatusForTesting,
} from "./indexer-daemon/process.js";
export type {
  CoherentIndexerSnapshotLease,
  DaemonRequest,
  DaemonResponse,
  IndexerDaemonClient,
  IndexerDaemonStopResult,
  IndexerSnapshotHandle,
  IndexerSnapshotPayload,
  ManagedIndexerDaemonOwnership,
  ManagedIndexerDaemonServiceLifetime,
} from "./indexer-daemon/types.js";
export type {
  IndexerDaemonCompatibility,
  IndexerDaemonProbeResult,
} from "./indexer-daemon/lifecycle.js";
