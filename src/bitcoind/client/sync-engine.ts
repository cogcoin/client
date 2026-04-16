import type { BitcoinBlock, Client } from "../../types.js";
import { waitForGetblockArchiveImport } from "../bootstrap.js";
import { formatManagedSyncErrorMessage } from "../errors.js";
import { normalizeRpcBlock } from "../normalize.js";
import {
  MANAGED_RPC_RETRY_MESSAGE,
  consumeManagedRpcRetryDelayMs,
  createManagedRpcRetryState,
  describeManagedRpcRetryError,
  isRetryableManagedRpcError,
  resetManagedRpcRetryState,
  type ManagedRpcRetryState,
} from "../retryable-rpc.js";
import type { RpcBlockchainInfo, SyncResult } from "../types.js";
import type { BitcoinSyncProgressDependencies, SyncEngineDependencies, SyncPassResult } from "./internal-types.js";
import { estimateEtaSeconds } from "./rate-tracker.js";

const DEFAULT_SYNC_CATCH_UP_POLL_MS = 2_000;
const BITCOIN_SYNC_PHASE_DEBOUNCE_MS = DEFAULT_SYNC_CATCH_UP_POLL_MS * 3;

function createAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;

  if (reason instanceof Error) {
    return reason;
  }

  const error = new Error("managed_sync_aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }

  return error instanceof Error
    && (error.name === "AbortError" || error.message === "managed_sync_aborted");
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

async function setBitcoinSyncProgress(
  dependencies: BitcoinSyncProgressDependencies,
  info: RpcBlockchainInfo,
  targetHeightCap: number | null,
): Promise<void> {
  const targetHeight = targetHeightCap === null ? info.headers : Math.min(info.headers, targetHeightCap);
  const etaSeconds = estimateEtaSeconds(dependencies.bitcoinRateTracker, info.blocks, targetHeight);

  await dependencies.progress.setPhase("bitcoin_sync", {
    blocks: info.blocks,
    headers: info.headers,
    targetHeight,
    etaSeconds,
    lastError: null,
    message: dependencies.node.expectedChain === "main"
      ? "Bitcoin Core is syncing blocks after assumeutxo bootstrap."
      : "Reading blocks from the managed Bitcoin node.",
  });
}

function resolveIndexedHeightForReplayWindow(
  tip: Awaited<ReturnType<Client["getTip"]>>,
  startHeight: number,
): number {
  return tip?.height ?? (startHeight - 1);
}

function hasPendingCogcoinReplay(
  tip: Awaited<ReturnType<Client["getTip"]>>,
  startHeight: number,
  bestHeight: number,
): boolean {
  if (bestHeight < startHeight) {
    return false;
  }

  return resolveIndexedHeightForReplayWindow(tip, startHeight) < bestHeight;
}

function shouldPreserveCogcoinSyncPhase(
  dependencies: Pick<SyncEngineDependencies, "progress">,
): boolean {
  const status = dependencies.progress.getStatusSnapshot();

  // Keep the TTY on Cogcoin replay through brief idle gaps so it does not
  // bounce back to Bitcoin sync between closely spaced replay passes.
  return status.bootstrapPhase === "cogcoin_sync"
    && Date.now() - status.bootstrapProgress.updatedAt < BITCOIN_SYNC_PHASE_DEBOUNCE_MS;
}

async function setRetryingProgress(
  dependencies: Pick<SyncEngineDependencies, "progress">,
  error: unknown,
): Promise<void> {
  const status = dependencies.progress.getStatusSnapshot();
  const { phase: _phase, updatedAt: _updatedAt, ...progress } = status.bootstrapProgress;

  await dependencies.progress.setPhase(status.bootstrapPhase, {
    ...progress,
    lastError: describeManagedRpcRetryError(error),
    message: MANAGED_RPC_RETRY_MESSAGE,
  });
}

async function runWithManagedRpcRetry<T>(
  dependencies: Pick<SyncEngineDependencies, "abortSignal" | "progress">,
  retryState: ManagedRpcRetryState,
  operation: () => Promise<T>,
): Promise<T> {
  while (true) {
    throwIfAborted(dependencies.abortSignal);

    try {
      const result = await operation();
      resetManagedRpcRetryState(retryState);
      return result;
    } catch (error) {
      if (isAbortError(error, dependencies.abortSignal)) {
        throw createAbortError(dependencies.abortSignal);
      }

      if (!isRetryableManagedRpcError(error)) {
        throw error;
      }

      await setRetryingProgress(dependencies, error);
      await sleep(consumeManagedRpcRetryDelayMs(retryState), dependencies.abortSignal);
    }
  }
}

async function findCommonAncestor(
  dependencies: Pick<SyncEngineDependencies, "rpc" | "store" | "startHeight">,
  tip: NonNullable<Awaited<ReturnType<Client["getTip"]>>>,
  bestHeight: number,
  runRpc: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<number> {
  const startHeight = Math.min(tip.height, bestHeight);

  for (let height = startHeight; height >= dependencies.startHeight; height -= 1) {
    const localHashHex = height === tip.height
      ? tip.blockHashHex
      : (await dependencies.store.loadBlockRecord(height))?.blockHashHex ?? null;

    if (localHashHex === null) {
      continue;
    }

    const chainHashHex = await runRpc(() => dependencies.rpc.getBlockHash(height));

    if (chainHashHex === localHashHex) {
      return height;
    }
  }

  return dependencies.startHeight - 1;
}

async function syncAgainstBestHeight(
  dependencies: SyncEngineDependencies,
  bestHeight: number,
  runRpc: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<SyncPassResult> {
  if (bestHeight < dependencies.startHeight) {
    return {
      appliedBlocks: 0,
      rewoundBlocks: 0,
      commonAncestorHeight: null,
    };
  }

  const startTip = await dependencies.client.getTip();
  let rewoundBlocks = 0;
  let commonAncestorHeight: number | null = null;

  if (startTip !== null) {
    const rewindTarget = await findCommonAncestor(dependencies, startTip, bestHeight, runRpc);

    if (rewindTarget < startTip.height) {
      commonAncestorHeight = rewindTarget < dependencies.startHeight ? null : rewindTarget;
      await dependencies.client.rewindToHeight(rewindTarget);
      rewoundBlocks = startTip.height - rewindTarget;
    }
  }

  const tipAfterRewind = await dependencies.client.getTip();
  const nextHeight = tipAfterRewind === null
    ? dependencies.startHeight
    : Math.max(dependencies.startHeight, tipAfterRewind.height + 1);
  let appliedBlocks = 0;

  if (nextHeight <= bestHeight) {
    await dependencies.progress.setCogcoinSync(
      nextHeight - 1,
      bestHeight,
      estimateEtaSeconds(dependencies.cogcoinRateTracker, nextHeight - 1, bestHeight),
    );
  }

  for (let height = nextHeight; height <= bestHeight; height += 1) {
    const blockHashHex = await runRpc(() => dependencies.rpc.getBlockHash(height));
    const rpcBlock = await runRpc(() => dependencies.rpc.getBlock(blockHashHex));
    const normalizedBlock: BitcoinBlock = normalizeRpcBlock(rpcBlock);
    await dependencies.client.applyBlock(normalizedBlock);
    if (typeof rpcBlock.time === "number") {
      dependencies.progress.setFollowBlockTime(height, rpcBlock.time);
    }
    appliedBlocks += 1;
    await dependencies.progress.setCogcoinSync(
      height,
      bestHeight,
      estimateEtaSeconds(dependencies.cogcoinRateTracker, height, bestHeight),
    );
  }

  return {
    appliedBlocks,
    rewoundBlocks,
    commonAncestorHeight,
  };
}

export async function syncToTip(
  dependencies: SyncEngineDependencies,
): Promise<SyncResult> {
  try {
    const retryState = createManagedRpcRetryState();
    const runRpc = <T>(operation: () => Promise<T>) =>
      runWithManagedRpcRetry(dependencies, retryState, operation);

    throwIfAborted(dependencies.abortSignal);
    await runRpc(() => dependencies.node.validate());
    const indexedTipBeforeBootstrap = await dependencies.client.getTip();
    await runRpc(() => dependencies.bootstrap.ensureReady(indexedTipBeforeBootstrap, dependencies.node.expectedChain, {
      signal: dependencies.abortSignal,
      retryState,
      resumeDisplayMode: dependencies.isFollowing() ? "follow" : "sync",
    }));

    if (
      dependencies.node.expectedChain === "main"
      && dependencies.node.getblockArchiveEndHeight !== null
    ) {
      await waitForGetblockArchiveImport(
        {
          getBlockchainInfo: () => runRpc(() => dependencies.rpc.getBlockchainInfo()),
        },
        dependencies.progress,
        dependencies.node.getblockArchiveEndHeight,
        dependencies.abortSignal,
      );
    }

    const startTip = await dependencies.client.getTip();
    const aggregate: SyncResult = {
      appliedBlocks: 0,
      rewoundBlocks: 0,
      commonAncestorHeight: null,
      startingHeight: startTip?.height ?? null,
      endingHeight: startTip?.height ?? null,
      bestHeight: 0,
      bestHashHex: "",
    };

    while (true) {
      throwIfAborted(dependencies.abortSignal);
      const startInfo = await runRpc(() => dependencies.rpc.getBlockchainInfo());
      const cappedBestHeight = dependencies.targetHeightCap === null || dependencies.targetHeightCap === undefined
        ? startInfo.blocks
        : Math.min(startInfo.blocks, dependencies.targetHeightCap);
      const tipBeforePass = await dependencies.client.getTip();

      if (
        !hasPendingCogcoinReplay(tipBeforePass, dependencies.startHeight, cappedBestHeight)
        && !shouldPreserveCogcoinSyncPhase(dependencies)
      ) {
        await setBitcoinSyncProgress(dependencies, startInfo, dependencies.targetHeightCap ?? null);
      }

      const pass = await syncAgainstBestHeight(dependencies, cappedBestHeight, runRpc);
      aggregate.appliedBlocks += pass.appliedBlocks;
      aggregate.rewoundBlocks += pass.rewoundBlocks;

      if (pass.commonAncestorHeight !== null) {
        aggregate.commonAncestorHeight = aggregate.commonAncestorHeight === null
          ? pass.commonAncestorHeight
          : Math.min(aggregate.commonAncestorHeight, pass.commonAncestorHeight);
      }

      const finalTip = await dependencies.client.getTip();
      const endInfo = await runRpc(() => dependencies.rpc.getBlockchainInfo());
      const endBestHeight = dependencies.targetHeightCap === null || dependencies.targetHeightCap === undefined
        ? endInfo.blocks
        : Math.min(endInfo.blocks, dependencies.targetHeightCap);
      const caughtUpCogcoin = endBestHeight < dependencies.startHeight || finalTip?.height === endBestHeight;

      aggregate.endingHeight = finalTip?.height ?? null;
      aggregate.bestHeight = endBestHeight;
      aggregate.bestHashHex = endInfo.bestblockhash;

      const reachedTargetHeightCap = dependencies.targetHeightCap !== null
        && dependencies.targetHeightCap !== undefined
        && endBestHeight >= dependencies.targetHeightCap;

      if (reachedTargetHeightCap && caughtUpCogcoin) {
        return aggregate;
      }

      if (
        dependencies.targetHeightCap === null
        && endInfo.blocks === endInfo.headers
        && caughtUpCogcoin
      ) {
        if (dependencies.isFollowing()) {
          dependencies.progress.replaceFollowBlockTimes(await runRpc(() =>
            dependencies.loadVisibleFollowBlockTimes(finalTip)));
        }

        await dependencies.progress.setPhase(dependencies.isFollowing() ? "follow_tip" : "complete", {
          blocks: endInfo.blocks,
          headers: endInfo.headers,
          targetHeight: dependencies.targetHeightCap ?? endInfo.headers,
          lastError: null,
          message: dependencies.isFollowing()
            ? "Following the live Bitcoin tip."
            : "Managed sync fully caught up to the live tip.",
        });

        return aggregate;
      }

      if (endBestHeight >= dependencies.startHeight && finalTip?.height !== endBestHeight) {
        continue;
      }

      if (!shouldPreserveCogcoinSyncPhase(dependencies)) {
        await setBitcoinSyncProgress(dependencies, endInfo, dependencies.targetHeightCap ?? null);
      }

      await sleep(DEFAULT_SYNC_CATCH_UP_POLL_MS, dependencies.abortSignal);
    }
  } catch (error) {
    if (isAbortError(error, dependencies.abortSignal)) {
      throw createAbortError(dependencies.abortSignal);
    }

    const message = formatManagedSyncErrorMessage(error instanceof Error ? error.message : String(error));
    await dependencies.progress.setPhase("error", {
      lastError: message,
      message: "Managed sync can be resumed after the last error.",
    });
    throw new Error(message);
  }
}
