import { compareSemver, parseSemver } from "../../semver.js";
import type { WalletIndexerStatus, WalletServiceHealth } from "../../wallet/read/types.js";
import type { IndexerSnapshotHandle, IndexerSnapshotPayload } from "../indexer-daemon.js";
import {
  INDEXER_DAEMON_SCHEMA_VERSION,
  INDEXER_DAEMON_SERVICE_API_VERSION,
  type ManagedIndexerDaemonObservedStatus,
  type ManagedIndexerDaemonStatus,
  type ManagedIndexerTruthSource,
} from "../types.js";
import { buildManagedIndexerStatusFromSnapshotHandle, resolveManagedIndexerStatusProjection } from "./status.js";
import type {
  IndexerDaemonProbeDecision,
  ManagedIndexerDaemonProbeResult,
  ManagedIndexerSnapshotLike,
} from "./types.js";

const STALE_HEARTBEAT_THRESHOLD_MS = 15_000;

type IndexerRuntimeIdentityLike = {
  serviceApiVersion: string;
  schemaVersion: string;
  walletRootId: string;
  daemonInstanceId: string;
  processId: number | null;
  startedAtUnixMs: number;
  state?: ManagedIndexerDaemonStatus["state"] | string;
};

function isUnreachableIndexerDaemonError(error: unknown): boolean {
  if (error instanceof Error) {
    if (
      error.message === "indexer_daemon_connection_closed"
      || error.message === "indexer_daemon_request_timeout"
      || error.message === "indexer_daemon_protocol_error"
    ) {
      return false;
    }

    if ("code" in error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET";
    }
  }

  return false;
}

export function validateIndexerRuntimeIdentity(
  identity: IndexerRuntimeIdentityLike,
  expectedWalletRootId: string,
): void {
  void expectedWalletRootId;

  if (identity.serviceApiVersion !== INDEXER_DAEMON_SERVICE_API_VERSION) {
    throw new Error("indexer_daemon_service_version_mismatch");
  }

  // Managed indexer daemons are adopted across wallet roots when the runtime
  // is otherwise compatible. Wallet-root ownership remains advisory here.
  if (identity.schemaVersion !== INDEXER_DAEMON_SCHEMA_VERSION || identity.state === "schema-mismatch") {
    throw new Error("indexer_daemon_schema_mismatch");
  }
}

export function validateIndexerDaemonStatus(
  status: ManagedIndexerDaemonObservedStatus,
  expectedWalletRootId: string,
): void {
  validateIndexerRuntimeIdentity(status, expectedWalletRootId);
}

export function validateIndexerSnapshotHandle(
  handle: IndexerSnapshotHandle,
  expectedWalletRootId: string,
): void {
  validateIndexerRuntimeIdentity(handle, expectedWalletRootId);
}

export function validateIndexerSnapshotPayload(
  payload: IndexerSnapshotPayload,
  handle: IndexerSnapshotHandle,
  expectedWalletRootId: string,
): void {
  validateIndexerRuntimeIdentity(payload, expectedWalletRootId);

  if (
    payload.token !== handle.token
    || payload.daemonInstanceId !== handle.daemonInstanceId
    || payload.processId !== handle.processId
    || payload.startedAtUnixMs !== handle.startedAtUnixMs
    || payload.snapshotSeq !== handle.snapshotSeq
    || payload.tipHeight !== handle.tipHeight
    || payload.tipHash !== handle.tipHash
    || payload.openedAtUnixMs !== handle.openedAtUnixMs
  ) {
    throw new Error("indexer_daemon_snapshot_identity_mismatch");
  }

  if (payload.tip === null) {
    if (payload.tipHeight !== null || payload.tipHash !== null) {
      throw new Error("indexer_daemon_snapshot_identity_mismatch");
    }
  } else if (payload.tip.height !== payload.tipHeight || payload.tip.blockHashHex !== payload.tipHash) {
    throw new Error("indexer_daemon_snapshot_identity_mismatch");
  }
}

export function mapIndexerDaemonValidationError<TClient>(
  error: unknown,
  status: ManagedIndexerDaemonObservedStatus,
): ManagedIndexerDaemonProbeResult<TClient> {
  return {
    compatibility: error instanceof Error
      ? error.message === "indexer_daemon_service_version_mismatch"
        ? "service-version-mismatch"
        : "schema-mismatch"
      : "protocol-error",
    status,
    client: null,
    error: error instanceof Error ? error.message : "indexer_daemon_protocol_error",
  };
}

export function mapIndexerDaemonTransportError<TClient>(
  error: unknown,
): ManagedIndexerDaemonProbeResult<TClient> {
  return {
    compatibility: isUnreachableIndexerDaemonError(error) ? "unreachable" : "protocol-error",
    status: null,
    client: null,
    error: isUnreachableIndexerDaemonError(error)
      ? null
      : error instanceof Error
        ? "indexer_daemon_protocol_error"
        : "indexer_daemon_protocol_error",
  };
}

export function isStaleIndexerDaemonVersion(
  status: ManagedIndexerDaemonObservedStatus | null,
  expectedBinaryVersion: string | null | undefined,
): boolean {
  if (status === null || expectedBinaryVersion === null || expectedBinaryVersion === undefined) {
    return false;
  }

  if (parseSemver(expectedBinaryVersion) === null) {
    return false;
  }

  const comparison = compareSemver(status.binaryVersion, expectedBinaryVersion);
  return comparison === null || comparison < 0;
}

export function resolveIndexerDaemonProbeDecision<TClient>(options: {
  probe: ManagedIndexerDaemonProbeResult<TClient>;
  expectedBinaryVersion: string | null | undefined;
}): IndexerDaemonProbeDecision {
  if (options.probe.compatibility === "compatible") {
    return {
      action: isStaleIndexerDaemonVersion(options.probe.status, options.expectedBinaryVersion)
        ? "replace"
        : "attach",
      error: null,
    };
  }

  if (options.probe.compatibility === "unreachable") {
    return {
      action: "start",
      error: null,
    };
  }

  return {
    action: "reject",
    error: options.probe.error ?? "indexer_daemon_protocol_error",
  };
}

function mapIndexerStartupError(message: string): {
  health: WalletServiceHealth;
  message: string;
} {
  switch (message) {
    case "indexer_daemon_start_timeout":
      return {
        health: "starting",
        message: "Indexer daemon is still starting.",
      };
    case "indexer_daemon_start_failed":
      return {
        health: "failed",
        message: "The managed indexer daemon exited before it opened its local IPC socket.",
      };
    case "sqlite_native_module_unavailable":
      return {
        health: "failed",
        message: "The managed indexer daemon could not load its SQLite native module.",
      };
    case "indexer_daemon_service_version_mismatch":
      return {
        health: "service-version-mismatch",
        message: "The live indexer daemon is running an incompatible service API version.",
      };
    case "indexer_daemon_schema_mismatch":
      return {
        health: "schema-mismatch",
        message: "The live indexer daemon is using an incompatible sqlite schema.",
      };
    case "indexer_daemon_wallet_root_mismatch":
      return {
        health: "wallet-root-mismatch",
        message: "The live indexer daemon belongs to a different wallet root.",
      };
    case "indexer_daemon_protocol_error":
      return {
        health: "unavailable",
        message: "The live indexer daemon socket responded with an invalid or incomplete protocol exchange.",
      };
    case "indexer_daemon_background_follow_recovery_failed":
      return {
        health: "failed",
        message: "The managed indexer daemon could not recover automatic background follow.",
      };
    default:
      return {
        health: "unavailable",
        message,
      };
  }
}

export function deriveManagedIndexerWalletStatus(options: {
  daemonStatus: ManagedIndexerDaemonStatus | null;
  observedStatus?: ManagedIndexerDaemonObservedStatus | null;
  snapshot: ManagedIndexerSnapshotLike | null;
  source: ManagedIndexerTruthSource;
  now: number;
  startupError: string | null;
}): WalletIndexerStatus {
  const projection = resolveManagedIndexerStatusProjection({
    daemonStatus: options.daemonStatus,
    observedStatus: options.observedStatus,
    snapshot: options.snapshot,
    source: options.source,
  });

  const createResult = (
    health: WalletIndexerStatus["health"],
    message: string | null,
  ): WalletIndexerStatus => ({
    health,
    status: projection.status,
    message,
    snapshotTip: projection.snapshotTip,
    source: projection.source,
    daemonInstanceId: projection.daemonInstanceId,
    snapshotSeq: projection.snapshotSeq,
    openedAtUnixMs: projection.openedAtUnixMs,
  });

  if (options.startupError !== null) {
    const mapped = mapIndexerStartupError(options.startupError);
    return createResult(mapped.health, mapped.message);
  }

  if (projection.status === null) {
    return createResult("unavailable", "Indexer daemon is unavailable.");
  }

  if ((options.now - projection.status.heartbeatAtUnixMs) > STALE_HEARTBEAT_THRESHOLD_MS) {
    return createResult("stale-heartbeat", "Indexer daemon heartbeat is stale.");
  }

  if (projection.status.state === "schema-mismatch") {
    return createResult("schema-mismatch", projection.status.lastError ?? "Indexer daemon sqlite schema is incompatible.");
  }

  if (projection.status.state === "failed") {
    return createResult("failed", projection.status.lastError ?? "Indexer daemon refresh failed.");
  }

  if (projection.status.state === "service-version-mismatch") {
    return createResult("service-version-mismatch", "Indexer daemon service API is incompatible.");
  }

  if (options.snapshot === null) {
    if (projection.status.state === "reorging") {
      return createResult("reorging", "Indexer daemon is replaying a reorg and refreshing the coherent snapshot.");
    }

    return createResult(
      projection.status.state === "catching-up" ? "catching-up" : "starting",
      "Indexer snapshot is not ready yet.",
    );
  }

  if (projection.status.state === "catching-up") {
    return createResult("catching-up", "Indexer daemon is still catching up to the managed Bitcoin tip.");
  }

  if (projection.status.state === "reorging") {
    return createResult("reorging", "Indexer daemon is replaying a reorg and refreshing the coherent snapshot.");
  }

  return createResult("synced", null);
}

export { buildManagedIndexerStatusFromSnapshotHandle };
