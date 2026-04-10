import type { BitcoinBlock, Client } from "../../types.js";
import { formatManagedSyncErrorMessage } from "../errors.js";
import { normalizeRpcBlock } from "../normalize.js";
import type { RpcBlockchainInfo, SyncResult } from "../types.js";
import type { BitcoinSyncProgressDependencies, SyncEngineDependencies, SyncPassResult } from "./internal-types.js";
import { estimateEtaSeconds } from "./rate-tracker.js";

const DEFAULT_SYNC_CATCH_UP_POLL_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function setBitcoinSyncProgress(
  dependencies: BitcoinSyncProgressDependencies,
  info: RpcBlockchainInfo,
): Promise<void> {
  const etaSeconds = estimateEtaSeconds(dependencies.bitcoinRateTracker, info.blocks, info.headers);

  await dependencies.progress.setPhase("bitcoin_sync", {
    blocks: info.blocks,
    headers: info.headers,
    targetHeight: info.headers,
    etaSeconds,
    message: dependencies.node.expectedChain === "main"
      ? "Bitcoin Core is syncing blocks after assumeutxo bootstrap."
      : "Reading blocks from the managed Bitcoin node.",
  });
}

async function findCommonAncestor(
  dependencies: Pick<SyncEngineDependencies, "rpc" | "store" | "startHeight">,
  tip: NonNullable<Awaited<ReturnType<Client["getTip"]>>>,
  bestHeight: number,
): Promise<number> {
  const startHeight = Math.min(tip.height, bestHeight);

  for (let height = startHeight; height >= dependencies.startHeight; height -= 1) {
    const localHashHex = height === tip.height
      ? tip.blockHashHex
      : (await dependencies.store.loadBlockRecord(height))?.blockHashHex ?? null;

    if (localHashHex === null) {
      continue;
    }

    const chainHashHex = await dependencies.rpc.getBlockHash(height);

    if (chainHashHex === localHashHex) {
      return height;
    }
  }

  return dependencies.startHeight - 1;
}

async function syncAgainstBestHeight(
  dependencies: SyncEngineDependencies,
  bestHeight: number,
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
    const rewindTarget = await findCommonAncestor(dependencies, startTip, bestHeight);

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
    const blockHashHex = await dependencies.rpc.getBlockHash(height);
    const rpcBlock = await dependencies.rpc.getBlock(blockHashHex);
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
    await dependencies.node.validate();
    const indexedTipBeforeBootstrap = await dependencies.client.getTip();
    await dependencies.bootstrap.ensureReady(indexedTipBeforeBootstrap, dependencies.node.expectedChain);

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
      const startInfo = await dependencies.rpc.getBlockchainInfo();
      await setBitcoinSyncProgress(dependencies, startInfo);

      const pass = await syncAgainstBestHeight(dependencies, startInfo.blocks);
      aggregate.appliedBlocks += pass.appliedBlocks;
      aggregate.rewoundBlocks += pass.rewoundBlocks;

      if (pass.commonAncestorHeight !== null) {
        aggregate.commonAncestorHeight = aggregate.commonAncestorHeight === null
          ? pass.commonAncestorHeight
          : Math.min(aggregate.commonAncestorHeight, pass.commonAncestorHeight);
      }

      const finalTip = await dependencies.client.getTip();
      const endInfo = await dependencies.rpc.getBlockchainInfo();
      const caughtUpCogcoin = endInfo.blocks < dependencies.startHeight || finalTip?.height === endInfo.blocks;

      aggregate.endingHeight = finalTip?.height ?? null;
      aggregate.bestHeight = endInfo.blocks;
      aggregate.bestHashHex = endInfo.bestblockhash;

      if (endInfo.blocks === endInfo.headers && caughtUpCogcoin) {
        if (dependencies.isFollowing()) {
          dependencies.progress.replaceFollowBlockTimes(await dependencies.loadVisibleFollowBlockTimes(finalTip));
        }

        await dependencies.progress.setPhase(dependencies.isFollowing() ? "follow_tip" : "complete", {
          blocks: endInfo.blocks,
          headers: endInfo.headers,
          targetHeight: endInfo.headers,
          message: dependencies.isFollowing()
            ? "Following the live Bitcoin tip."
            : "Managed sync fully caught up to the live tip.",
        });

        return aggregate;
      }

      await setBitcoinSyncProgress(dependencies, endInfo);

      if (endInfo.blocks >= dependencies.startHeight && finalTip?.height !== endInfo.blocks) {
        continue;
      }

      await sleep(DEFAULT_SYNC_CATCH_UP_POLL_MS);
    }
  } catch (error) {
    const message = formatManagedSyncErrorMessage(error instanceof Error ? error.message : String(error));
    await dependencies.progress.setPhase("error", {
      lastError: message,
      message: "Managed sync can be resumed after the last error.",
    });
    throw new Error(message);
  }
}
