import { join } from "node:path";

import { resolveManagedServicePaths } from "../service-paths.js";
import { MANAGED_BITCOIND_SERVICE_API_VERSION } from "../types.js";
import type { ManagedBitcoindObservedStatus } from "../types.js";
import type { WalletBitcoindStatus, WalletNodeStatus } from "../../wallet/read/types.js";
import type { ManagedBitcoindProbeDecision, ManagedBitcoindServiceProbeResult } from "./types.js";

function isRuntimeMismatchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.startsWith("bitcoind_chain_expected_")
    || error.message === "managed_bitcoind_runtime_mismatch";
}

function isUnreachableManagedBitcoindError(error: unknown): boolean {
  if (error instanceof Error) {
    if ("code" in error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET";
    }

    return error.message === "bitcoind_cookie_timeout"
      || error.message.includes("cookie file is unavailable")
      || error.message.includes("ECONNREFUSED")
      || error.message.includes("ECONNRESET")
      || error.message.includes("socket hang up");
  }

  return false;
}

export function validateManagedBitcoindObservedStatus(
  status: ManagedBitcoindObservedStatus,
  options: {
    chain: "main" | "regtest";
    dataDir: string;
    runtimeRoot: string;
  },
): void {
  const legacyRuntimeRoot = join(
    resolveManagedServicePaths(options.dataDir, status.walletRootId).runtimeRoot,
    status.walletRootId,
  );

  if (status.serviceApiVersion !== MANAGED_BITCOIND_SERVICE_API_VERSION) {
    throw new Error("managed_bitcoind_service_version_mismatch");
  }

  // Managed bitcoind runtimes are adopted across wallet roots when the live
  // runtime still points at the expected data dir and chain.
  if (
    status.chain !== options.chain
    || status.dataDir !== options.dataDir
    || (status.runtimeRoot !== options.runtimeRoot && status.runtimeRoot !== legacyRuntimeRoot)
  ) {
    throw new Error("managed_bitcoind_runtime_mismatch");
  }
}

export function mapManagedBitcoindValidationError(
  error: unknown,
  status: ManagedBitcoindObservedStatus,
): ManagedBitcoindServiceProbeResult {
  return {
    compatibility: error instanceof Error
      ? error.message === "managed_bitcoind_service_version_mismatch"
        ? "service-version-mismatch"
        : "runtime-mismatch"
      : "protocol-error",
    status,
    error: error instanceof Error ? error.message : "managed_bitcoind_protocol_error",
  };
}

export function mapManagedBitcoindRuntimeProbeFailure(
  error: unknown,
  status: ManagedBitcoindObservedStatus,
): ManagedBitcoindServiceProbeResult {
  if (isRuntimeMismatchError(error)) {
    return {
      compatibility: "runtime-mismatch",
      status,
      error: "managed_bitcoind_runtime_mismatch",
    };
  }

  if (isUnreachableManagedBitcoindError(error)) {
    return {
      compatibility: "unreachable",
      status,
      error: null,
    };
  }

  return {
    compatibility: "protocol-error",
    status,
    error: "managed_bitcoind_protocol_error",
  };
}

export function resolveManagedBitcoindProbeDecision(
  probe: ManagedBitcoindServiceProbeResult,
): ManagedBitcoindProbeDecision {
  if (probe.compatibility === "compatible") {
    return {
      action: "attach",
      error: null,
    };
  }

  if (probe.compatibility === "unreachable") {
    return {
      action: "start",
      error: null,
    };
  }

  return {
    action: "reject",
    error: probe.error ?? "managed_bitcoind_protocol_error",
  };
}

function mapManagedBitcoindStartupError(message: string): WalletBitcoindStatus {
  switch (message) {
    case "managed_bitcoind_service_start_timeout":
      return {
        health: "starting",
        status: null,
        message: "Managed bitcoind service is still starting.",
      };
    case "managed_bitcoind_service_version_mismatch":
      return {
        health: "service-version-mismatch",
        status: null,
        message: "The live managed bitcoind service is running an incompatible service version.",
      };
    case "managed_bitcoind_wallet_root_mismatch":
      return {
        health: "wallet-root-mismatch",
        status: null,
        message: "The live managed bitcoind service belongs to a different wallet root.",
      };
    case "managed_bitcoind_runtime_mismatch":
      return {
        health: "runtime-mismatch",
        status: null,
        message: "The live managed bitcoind service runtime does not match this wallet's expected data directory or chain.",
      };
    case "managed_bitcoind_protocol_error":
      return {
        health: "unavailable",
        status: null,
        message: "The managed bitcoind runtime artifacts are invalid or incomplete.",
      };
    default:
      return {
        health: "unavailable",
        status: null,
        message,
      };
  }
}

export function deriveManagedBitcoindWalletStatus(options: {
  status: ManagedBitcoindObservedStatus | null;
  nodeStatus: WalletNodeStatus | null;
  startupError: string | null;
}): WalletBitcoindStatus {
  if (options.startupError !== null) {
    const mapped = mapManagedBitcoindStartupError(options.startupError);
    return {
      ...mapped,
      status: options.status,
    };
  }

  if (options.status === null) {
    return {
      health: "unavailable",
      status: null,
      message: "Managed bitcoind service is unavailable.",
    };
  }

  if (options.status.state === "starting") {
    return {
      health: "starting",
      status: options.status,
      message: options.status.lastError ?? "Managed bitcoind service is still starting.",
    };
  }

  if (options.status.state === "failed") {
    return {
      health: "failed",
      status: options.status,
      message: options.status.lastError ?? "Managed bitcoind service refresh failed.",
    };
  }

  const proofStatus = options.nodeStatus?.walletReplica?.proofStatus;

  if (proofStatus === "missing") {
    return {
      health: "replica-missing",
      status: options.status,
      message: options.nodeStatus?.walletReplicaMessage ?? "Managed Core wallet replica is missing.",
    };
  }

  if (proofStatus === "mismatch") {
    return {
      health: "replica-mismatch",
      status: options.status,
      message: options.nodeStatus?.walletReplicaMessage ?? "Managed Core wallet replica does not match trusted wallet state.",
    };
  }

  return {
    health: "ready",
    status: options.status,
    message: options.nodeStatus?.walletReplicaMessage ?? options.status.lastError,
  };
}
