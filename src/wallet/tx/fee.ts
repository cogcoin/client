import type { RpcMempoolEntry } from "../../bitcoind/types.js";
import type { PendingMutationRecord } from "../types.js";
import type {
  BuiltWalletMutationTransaction,
  WalletMutationRpcClient,
} from "./types.js";

export const DEFAULT_WALLET_MUTATION_FEE_RATE_SAT_VB = 10;
export const NEXT_BLOCK_FEE_CONFIRM_TARGET = 1;

export type WalletMutationFeeSelectionSource =
  | "custom-satvb"
  | "estimated-next-block-plus-one"
  | "fallback-default";

export interface WalletMutationFeeSelection {
  feeRateSatVb: number;
  source: WalletMutationFeeSelectionSource;
}

export interface WalletMutationFeeSummary extends WalletMutationFeeSelection {
  feeSats: string | null;
}

function btcNumberToSats(value: number): bigint {
  return BigInt(Math.round(value * 100_000_000));
}

function normalizeSatVb(value: number): number {
  return Number.parseFloat(value.toFixed(8));
}

function satVbFromBtcPerKvB(value: number): number {
  return normalizeSatVb((value * 100_000_000) / 1_000);
}

function feeRateFromMempoolEntry(entry: RpcMempoolEntry): number | null {
  if (!Number.isFinite(entry.vsize) || entry.vsize <= 0) {
    return null;
  }

  const feeSats = Number(btcNumberToSats(entry.fees.base));
  if (!Number.isFinite(feeSats) || feeSats <= 0) {
    return null;
  }

  return normalizeSatVb(feeSats / entry.vsize);
}

export function formatSatVb(value: number): string {
  return normalizeSatVb(value).toString();
}

export function createWalletMutationFeeMetadata(
  selection: WalletMutationFeeSelection,
): {
  selectedFeeRateSatVb: number;
  feeSelectionSource: WalletMutationFeeSelectionSource;
} {
  return {
    selectedFeeRateSatVb: selection.feeRateSatVb,
    feeSelectionSource: selection.source,
  };
}

export async function resolveWalletMutationFeeSelection(options: {
  rpc: Pick<WalletMutationRpcClient, "estimateSmartFee">;
  feeRateSatVb?: number | null;
}): Promise<WalletMutationFeeSelection> {
  if (typeof options.feeRateSatVb === "number") {
    return {
      feeRateSatVb: normalizeSatVb(options.feeRateSatVb),
      source: "custom-satvb",
    };
  }

  if (options.rpc.estimateSmartFee !== undefined) {
    try {
      const estimate = await options.rpc.estimateSmartFee(
        NEXT_BLOCK_FEE_CONFIRM_TARGET,
        "conservative",
      );
      const estimatedSatVb = typeof estimate.feerate === "number"
        ? satVbFromBtcPerKvB(estimate.feerate)
        : null;

      if (estimatedSatVb !== null && Number.isFinite(estimatedSatVb) && estimatedSatVb > 0) {
        return {
          feeRateSatVb: normalizeSatVb(estimatedSatVb + 1),
          source: "estimated-next-block-plus-one",
        };
      }
    } catch {
      // Fall through to the compatibility default.
    }
  }

  return {
    feeRateSatVb: DEFAULT_WALLET_MUTATION_FEE_RATE_SAT_VB,
    source: "fallback-default",
  };
}

export function createWalletMutationFeeSummary(
  selection: WalletMutationFeeSelection,
  feeSats: string | null,
): WalletMutationFeeSummary {
  return {
    feeRateSatVb: selection.feeRateSatVb,
    feeSats,
    source: selection.source,
  };
}

export function createBuiltWalletMutationFeeSummary(options: {
  selection: WalletMutationFeeSelection;
  built: BuiltWalletMutationTransaction;
}): WalletMutationFeeSummary {
  return createWalletMutationFeeSummary(
    options.selection,
    btcNumberToSats(options.built.funded.fee).toString(),
  );
}

export async function resolvePendingMutationFeeSummary(options: {
  rpc: Pick<WalletMutationRpcClient, "getMempoolEntry">;
  mutation: PendingMutationRecord;
}): Promise<WalletMutationFeeSummary> {
  const source = options.mutation.feeSelectionSource ?? "fallback-default";
  const selectedFeeRateSatVb = typeof options.mutation.selectedFeeRateSatVb === "number"
    && Number.isFinite(options.mutation.selectedFeeRateSatVb)
    && options.mutation.selectedFeeRateSatVb > 0
    ? normalizeSatVb(options.mutation.selectedFeeRateSatVb)
    : DEFAULT_WALLET_MUTATION_FEE_RATE_SAT_VB;

  if (options.mutation.attemptedTxid !== null && options.rpc.getMempoolEntry !== undefined) {
    try {
      const entry = await options.rpc.getMempoolEntry(options.mutation.attemptedTxid);
      const feeRateSatVb = feeRateFromMempoolEntry(entry);

      if (feeRateSatVb !== null) {
        return {
          feeRateSatVb,
          feeSats: btcNumberToSats(entry.fees.base).toString(),
          source,
        };
      }
    } catch {
      // Fall back to stored metadata or the historical default.
    }
  }

  return {
    feeRateSatVb: selectedFeeRateSatVb,
    feeSats: null,
    source,
  };
}
