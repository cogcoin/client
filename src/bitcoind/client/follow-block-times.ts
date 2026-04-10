import type { Client, ClientStoreAdapter } from "../../types.js";
import type { BitcoinRpcClient } from "../rpc.js";

const FOLLOW_VISIBLE_PRIOR_BLOCKS = 4;

export async function loadVisibleFollowBlockTimes(
  options: {
    tip: Awaited<ReturnType<Client["getTip"]>>;
    startHeight: number;
    store: ClientStoreAdapter;
    rpc: BitcoinRpcClient;
  },
): Promise<Record<number, number>> {
  const { tip, startHeight, store, rpc } = options;

  if (tip === null) {
    return {};
  }

  const blockTimesByHeight: Record<number, number> = {};

  for (let offset = 0; offset <= FOLLOW_VISIBLE_PRIOR_BLOCKS; offset += 1) {
    const height = tip.height - offset;

    if (height < startHeight || height < 0) {
      break;
    }

    const hashHex = height === tip.height
      ? tip.blockHashHex
      : (await store.loadBlockRecord(height))?.blockHashHex ?? null;

    if (hashHex === null) {
      continue;
    }

    const rpcBlock = await rpc.getBlock(hashHex);

    if (typeof rpcBlock.time === "number") {
      blockTimesByHeight[height] = rpcBlock.time;
    }
  }

  return blockTimesByHeight;
}
