import { formatManagedSyncErrorMessage } from "../errors.js";
import type { BitcoinRpcClient } from "../rpc.js";
import type { ManagedProgressController } from "../progress.js";
import {
  DEFAULT_SNAPSHOT_METADATA,
  HEADER_NO_PEER_TIMEOUT_MS,
  HEADER_POLL_MS,
} from "./constants.js";
import type { RpcNetworkInfo, SnapshotMetadata } from "../types.js";

function createAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;

  if (reason instanceof Error) {
    return reason;
  }

  const error = new Error("managed_sync_aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(createAbortError(signal));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function resolvePeerCount(networkInfo: RpcNetworkInfo): number {
  return typeof networkInfo.connections === "number"
    ? networkInfo.connections
    : (networkInfo.connections_in ?? 0) + (networkInfo.connections_out ?? 0);
}

function resolveHeaderWaitMessage(headers: number, peerCount: number, networkActive: boolean): string {
  if (!networkActive) {
    return "Bitcoin networking is inactive for the managed node.";
  }

  if (headers === 0 && peerCount === 0) {
    return "Waiting for Bitcoin peers before downloading headers (0 peers; check internet/firewall).";
  }

  if (peerCount === 0) {
    return `Waiting for peers to continue header sync (${headers.toLocaleString()} headers, 0 peers).`;
  }

  return "Waiting for Bitcoin headers to reach the snapshot height.";
}

export async function waitForHeaders(
  rpc: Pick<BitcoinRpcClient, "getBlockchainInfo" | "getNetworkInfo">,
  snapshot: SnapshotMetadata,
  progress: Pick<ManagedProgressController, "setPhase">,
  options: {
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    noPeerTimeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleepImpl = options.sleep ?? sleep;
  const noPeerTimeoutMs = options.noPeerTimeoutMs ?? HEADER_NO_PEER_TIMEOUT_MS;
  const { signal } = options;
  let noPeerSince: number | null = null;

  while (true) {
    throwIfAborted(signal);
    const [info, networkInfo] = await Promise.all([
      rpc.getBlockchainInfo(),
      rpc.getNetworkInfo(),
    ]);
    const peerCount = resolvePeerCount(networkInfo);
    const message = resolveHeaderWaitMessage(info.headers, peerCount, networkInfo.networkactive);

    await progress.setPhase("wait_headers_for_snapshot", {
      headers: info.headers,
      targetHeight: snapshot.height,
      blocks: info.blocks,
      percent: (Math.min(info.headers, snapshot.height) / snapshot.height) * 100,
      message,
    });

    if (info.headers >= snapshot.height) {
      return;
    }

    if (info.headers === 0 && peerCount === 0) {
      noPeerSince ??= now();

      if (now() - noPeerSince >= noPeerTimeoutMs) {
        throw new Error(formatManagedSyncErrorMessage("bitcoind_no_peers_for_header_sync_check_internet_or_firewall"));
      }
    } else {
      noPeerSince = null;
    }

    await sleepImpl(HEADER_POLL_MS, signal);
  }
}

export async function waitForHeadersForTesting(
  rpc: Pick<BitcoinRpcClient, "getBlockchainInfo" | "getNetworkInfo">,
  snapshot: SnapshotMetadata = DEFAULT_SNAPSHOT_METADATA,
  progress: Pick<ManagedProgressController, "setPhase">,
  options?: {
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    noPeerTimeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<void> {
  await waitForHeaders(rpc, snapshot, progress, options);
}
