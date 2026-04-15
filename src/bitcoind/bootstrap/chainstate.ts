import type { BitcoinRpcClient } from "../rpc.js";
import type { RpcChainState, SnapshotMetadata } from "../types.js";
import type { BootstrapPersistentState } from "./types.js";

function chainStateMatches(
  chainState: RpcChainState,
  snapshot: SnapshotMetadata,
  baseHeight: number | null,
  tipHashHex: string | null,
): boolean {
  if (tipHashHex !== null && chainState.snapshot_blockhash === tipHashHex) {
    return true;
  }

  if (baseHeight !== null && chainState.blocks === baseHeight && chainState.validated === false) {
    return true;
  }

  return chainState.blocks === snapshot.height && chainState.validated === false;
}

export async function isSnapshotAlreadyLoaded(
  rpc: Pick<BitcoinRpcClient, "getChainStates">,
  snapshot: SnapshotMetadata,
  state: BootstrapPersistentState,
): Promise<boolean> {
  return (await findLoadedSnapshotChainState(rpc, snapshot, state)) !== null;
}

export async function findLoadedSnapshotChainState(
  rpc: Pick<BitcoinRpcClient, "getChainStates">,
  snapshot: SnapshotMetadata,
  state: BootstrapPersistentState,
): Promise<RpcChainState | null> {
  const chainStates = await rpc.getChainStates();
  return chainStates.chainstates.find((chainState) =>
    chainStateMatches(chainState, snapshot, state.baseHeight, state.tipHashHex)) ?? null;
}
