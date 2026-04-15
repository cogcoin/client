import { open } from "node:fs/promises";

import { formatManagedSyncErrorMessage } from "../errors.js";
import {
  MANAGED_RPC_RETRY_MESSAGE,
  consumeManagedRpcRetryDelayMs,
  createManagedRpcRetryState,
  describeManagedRpcRetryError,
  type ManagedRpcRetryState,
  resetManagedRpcRetryState,
  isRetryableManagedRpcError,
} from "../retryable-rpc.js";
import type { BitcoinRpcClient } from "../rpc.js";
import type { ManagedProgressController } from "../progress.js";
import {
  DEFAULT_SNAPSHOT_METADATA,
  HEADER_NO_PEER_TIMEOUT_MS,
  HEADER_POLL_MS,
} from "./constants.js";
import type { RpcNetworkInfo, SnapshotMetadata } from "../types.js";

const DEBUG_LOG_TAIL_BYTES = 64 * 1024;
const HEADER_SYNC_DEBUG_LINE_PATTERN = /Pre-synchronizing blockheaders,\s*height:\s*([\d,]+)\s*\(~(\d+(?:\.\d+)?)%\)/u;

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

async function readDebugLogTail(filePath: string, maxBytes = DEBUG_LOG_TAIL_BYTES): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;

  try {
    handle = await open(filePath, "r");
    const stats = await handle.stat();
    const bytesToRead = Math.min(maxBytes, Math.max(0, stats.size));

    if (bytesToRead === 0) {
      return null;
    }

    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, stats.size - bytesToRead);
    return buffer.toString("utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readHeaderSyncProgressFromDebugLog(
  debugLogPath: string,
): Promise<{ height: number; message: string } | null> {
  const tail = await readDebugLogTail(debugLogPath);

  if (tail === null) {
    return null;
  }

  const lines = tail.split(/\r?\n/u).reverse();

  for (const line of lines) {
    const match = HEADER_SYNC_DEBUG_LINE_PATTERN.exec(line);

    if (match === null) {
      continue;
    }

    const height = Number(match[1].replaceAll(",", ""));

    if (!Number.isFinite(height) || height < 0) {
      return null;
    }

    return {
      height,
      message: `Pre-synchronizing blockheaders, height: ${height.toLocaleString()} (~${match[2]}%)`,
    };
  }

  return null;
}

function resolveHeaderWaitMessage(
  headers: number,
  peerCount: number,
  networkActive: boolean,
  rpcHeaders: number,
  headerSyncMessage: string | null,
): string {
  if (!networkActive) {
    return "Bitcoin networking is inactive for the managed node.";
  }

  if (headers === 0 && peerCount === 0) {
    return "Waiting for Bitcoin peers before downloading headers (0 peers; check internet/firewall).";
  }

  if (peerCount === 0) {
    return `Waiting for peers to continue header sync (${headers.toLocaleString()} headers, 0 peers).`;
  }

  if (rpcHeaders > 0) {
    return "Waiting for Bitcoin headers to reach the snapshot height.";
  }

  return headerSyncMessage ?? "Pre-synchronizing blockheaders.";
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
    retryState?: ManagedRpcRetryState;
    debugLogPath?: string;
    readDebugLogProgress?: (debugLogPath: string) => Promise<{ height: number; message: string } | null>;
  } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleepImpl = options.sleep ?? sleep;
  const noPeerTimeoutMs = options.noPeerTimeoutMs ?? HEADER_NO_PEER_TIMEOUT_MS;
  const { signal } = options;
  const retryState = options.retryState ?? createManagedRpcRetryState();
  const readDebugLogProgress = options.readDebugLogProgress ?? readHeaderSyncProgressFromDebugLog;
  let noPeerSince: number | null = null;
  let lastBlocks = 0;
  let lastHeaders = 0;

  while (true) {
    throwIfAborted(signal);
    let info: Awaited<ReturnType<typeof rpc.getBlockchainInfo>>;
    let networkInfo: Awaited<ReturnType<typeof rpc.getNetworkInfo>>;

    try {
      [info, networkInfo] = await Promise.all([
        rpc.getBlockchainInfo(),
        rpc.getNetworkInfo(),
      ]);
      resetManagedRpcRetryState(retryState);
    } catch (error) {
      if (!isRetryableManagedRpcError(error)) {
        throw error;
      }

      await progress.setPhase("wait_headers_for_snapshot", {
        headers: lastHeaders,
        targetHeight: snapshot.height,
        blocks: lastBlocks,
        percent: (Math.min(lastHeaders, snapshot.height) / snapshot.height) * 100,
        lastError: describeManagedRpcRetryError(error),
        message: MANAGED_RPC_RETRY_MESSAGE,
      });
      await sleepImpl(consumeManagedRpcRetryDelayMs(retryState), signal);
      continue;
    }

    lastBlocks = info.blocks;
    const debugLogProgress = info.headers === 0 && options.debugLogPath !== undefined
      ? await readDebugLogProgress(options.debugLogPath)
      : null;
    const observedHeaders = info.headers > 0
      ? info.headers
      : Math.max(info.headers, debugLogProgress?.height ?? 0);
    lastHeaders = observedHeaders;
    const peerCount = resolvePeerCount(networkInfo);
    const message = resolveHeaderWaitMessage(
      observedHeaders,
      peerCount,
      networkInfo.networkactive,
      info.headers,
      debugLogProgress?.message ?? null,
    );

    await progress.setPhase("wait_headers_for_snapshot", {
      headers: observedHeaders,
      targetHeight: snapshot.height,
      blocks: info.blocks,
      percent: (Math.min(observedHeaders, snapshot.height) / snapshot.height) * 100,
      lastError: null,
      message,
    });

    if (info.headers >= snapshot.height) {
      return;
    }

    if (observedHeaders === 0 && peerCount === 0) {
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
    debugLogPath?: string;
    readDebugLogProgress?: (debugLogPath: string) => Promise<{ height: number; message: string } | null>;
  },
): Promise<void> {
  await waitForHeaders(rpc, snapshot, progress, options);
}
