import { reconcilePersistentPolicyLocks as reconcileWalletCoinControlLocks } from "../coin-control.js";
import type { WalletStateV1 } from "../types.js";
import type { WalletMutationRpcClient } from "./types.js";

export * from "./types.js";
export * from "./primitives.js";
export * from "./fee.js";
export * from "./reconcile.js";
export * from "./state-persist.js";
export * from "./psbt-assert.js";
export * from "./readiness.js";
export * from "./mining-preemption.js";
export * from "./signing.js";
export * from "./draft-build.js";

export async function reconcilePersistentPolicyLocks(options: {
  rpc: Pick<WalletMutationRpcClient, "listLockUnspent" | "lockUnspent" | "listUnspent">;
  walletName: string;
  state: WalletStateV1;
  fixedInputs: import("./types.js").FixedWalletInput[];
  temporarilyUnlockedOutpoints?: readonly import("../types.js").OutpointRecord[];
  cleanupInactiveTemporaryBuilderLocks?: boolean;
}): Promise<void> {
  await reconcileWalletCoinControlLocks({
    rpc: options.rpc,
    walletName: options.walletName,
    state: options.state,
  });
}

export function isBroadcastUnknownError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("timeout")
    || message.includes("timed out")
    || message.includes("socket hang up")
    || message.includes("econnreset")
    || message.includes("econnrefused")
    || message.includes("broken pipe")
    || message.includes("broadcast_unknown");
}

export function isAlreadyAcceptedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("already in block chain")
    || message.includes("already in blockchain")
    || message.includes("txn-already-known");
}

export function isInsufficientFundsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("insufficient funds");
}
