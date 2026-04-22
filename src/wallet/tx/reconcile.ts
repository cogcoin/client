import type {
  RpcTransaction,
  RpcVin,
} from "../../bitcoind/types.js";
import type {
  PendingMutationRecord,
  WalletStateV1,
} from "../types.js";
import { resolvePendingMutationFeeSummary, type WalletMutationFeeSelection, type WalletMutationFeeSummary } from "./fee.js";
import { outpointKey } from "./primitives.js";
import type {
  FixedWalletInput,
  WalletMutationRpcClient,
} from "./types.js";

export async function loadAttemptedMutationFixedInputs(options: {
  rpc: Pick<WalletMutationRpcClient, "getTransaction" | "getRawTransaction">;
  walletName: string;
  mutation: PendingMutationRecord;
}): Promise<FixedWalletInput[] | null> {
  if (options.mutation.attemptedTxid === null) {
    return null;
  }

  const txid = options.mutation.attemptedTxid;
  let decoded: RpcTransaction | null = null;

  if (options.rpc.getTransaction !== undefined) {
    try {
      const walletTx = await options.rpc.getTransaction(options.walletName, txid);
      decoded = (walletTx as { decoded?: RpcTransaction | null }).decoded ?? null;
    } catch {
      decoded = null;
    }
  }

  if (decoded === null && options.rpc.getRawTransaction !== undefined) {
    try {
      decoded = await options.rpc.getRawTransaction(txid, true);
    } catch {
      decoded = null;
    }
  }

  if (decoded === null) {
    return null;
  }

  const fixedInputs = decoded.vin
    .filter((input): input is RpcVin & { txid: string; vout: number } =>
      typeof input.txid === "string" && typeof input.vout === "number")
    .map((input) => ({
      txid: input.txid,
      vout: input.vout,
    }));

  return fixedInputs.length > 0 ? fixedInputs : null;
}

export async function resolvePendingMutationReuseDecision(options: {
  rpc: Pick<WalletMutationRpcClient, "getMempoolEntry" | "getTransaction" | "getRawTransaction">;
  walletName: string;
  mutation: PendingMutationRecord;
  nextFeeSelection: WalletMutationFeeSelection;
}): Promise<{
  reuseExisting: boolean;
  fees: WalletMutationFeeSummary;
  replacementFixedInputs: FixedWalletInput[] | null;
}> {
  const fees = await resolvePendingMutationFeeSummary({
    rpc: options.rpc,
    mutation: options.mutation,
  });

  if (
    options.mutation.status === "confirmed"
    || options.nextFeeSelection.feeRateSatVb <= fees.feeRateSatVb
  ) {
    return {
      reuseExisting: true,
      fees,
      replacementFixedInputs: null,
    };
  }

  return {
    reuseExisting: false,
    fees,
    replacementFixedInputs: await loadAttemptedMutationFixedInputs({
      rpc: options.rpc,
      walletName: options.walletName,
      mutation: options.mutation,
    }),
  };
}

export function mergeFixedWalletInputs(
  fixedInputs: readonly FixedWalletInput[],
  replacementInputs: readonly FixedWalletInput[] | null,
): FixedWalletInput[] {
  if (replacementInputs === null || replacementInputs.length === 0) {
    return [...fixedInputs];
  }

  const merged = new Map<string, FixedWalletInput>();

  for (const input of fixedInputs) {
    merged.set(outpointKey(input), { txid: input.txid, vout: input.vout });
  }

  for (const input of replacementInputs) {
    merged.set(outpointKey(input), { txid: input.txid, vout: input.vout });
  }

  return [...merged.values()];
}

export interface WalletMutationReconcileResult {
  state: WalletStateV1;
  mutation: PendingMutationRecord;
  resolution: "confirmed" | "live" | "repair-required" | "not-seen" | "continue";
}
