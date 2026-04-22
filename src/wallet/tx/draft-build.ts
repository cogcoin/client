import type {
  RpcDecodedPsbt,
  RpcListUnspentEntry,
  RpcTransaction,
  RpcWalletCreateFundedPsbtResult,
} from "../../bitcoind/types.js";
import type {
  OutpointRecord,
  WalletStateV1,
} from "../types.js";
import { DEFAULT_WALLET_MUTATION_FEE_RATE_SAT_VB } from "./fee.js";
import { getDecodedInputScriptPubKeyHex, getDecodedInputVout } from "./psbt-assert.js";
import { outpointKey } from "./primitives.js";
import { unlockTemporaryBuilderLocks } from "./state-persist.js";
import { signAndFinalizeWalletMutation } from "./signing.js";
import type {
  BuiltWalletMutationTransaction,
  FixedWalletInput,
  WalletMutationRpcClient,
} from "./types.js";

function btcNumberToSats(value: number): bigint {
  return BigInt(Math.round(value * 100_000_000));
}

function valueToSats(value: number | string): bigint {
  return typeof value === "string"
    ? BigInt(Math.round(Number(value) * 100_000_000))
    : btcNumberToSats(value);
}

function isSpendableFundingUtxo(
  entry: RpcListUnspentEntry,
  fundingScriptPubKeyHex: string,
  minConf: number,
): boolean {
  return entry.scriptPubKey === fundingScriptPubKeyHex
    && entry.confirmations >= minConf
    && entry.spendable !== false
    && entry.safe !== false;
}

function isReserveFloorFundingError(error: unknown): boolean {
  void error;
  return false;
}

function computeRemainingFundingValueSats(options: {
  decoded: RpcDecodedPsbt;
  fundingScriptPubKeyHex: string;
  availableFundingValueByKey: Map<string, bigint>;
}): bigint {
  let remaining = 0n;

  for (const value of options.availableFundingValueByKey.values()) {
    remaining += value;
  }

  for (const [index, input] of options.decoded.tx.vin.entries()) {
    const scriptPubKeyHex = getDecodedInputScriptPubKeyHex(options.decoded, index);
    const vout = getDecodedInputVout(input);
    if (scriptPubKeyHex !== options.fundingScriptPubKeyHex || vout === null || typeof input.txid !== "string") {
      continue;
    }

    remaining -= options.availableFundingValueByKey.get(outpointKey({
      txid: input.txid,
      vout,
    })) ?? 0n;
  }

  for (const output of options.decoded.tx.vout) {
    if (output.scriptPubKey?.hex !== options.fundingScriptPubKeyHex) {
      continue;
    }
    remaining += valueToSats(output.value);
  }

  return remaining;
}

export async function fundAndValidateWalletMutationDraft<TPlan>(options: {
  rpc: WalletMutationRpcClient;
  walletName: string;
  plan: TPlan & {
    fixedInputs: FixedWalletInput[];
    outputs: unknown[];
    changeAddress: string;
    changePosition?: number | null;
    allowedFundingScriptPubKeyHex: string;
    eligibleFundingOutpointKeys: Set<string>;
  };
  validateFundedDraft(
    decoded: RpcDecodedPsbt,
    funded: RpcWalletCreateFundedPsbtResult,
    plan: TPlan,
  ): void;
  feeRate?: number;
  availableFundingMinConf?: number;
}): Promise<{
  funded: RpcWalletCreateFundedPsbtResult;
  decoded: RpcDecodedPsbt;
}> {
  const availableFundingMinConf = options.availableFundingMinConf ?? 1;
  const availableFundingUtxos = (await options.rpc.listUnspent(options.walletName, availableFundingMinConf))
    .filter((entry) => isSpendableFundingUtxo(
      entry,
      options.plan.allowedFundingScriptPubKeyHex,
      availableFundingMinConf,
    ));
  const validationPlan = {
    ...options.plan,
    eligibleFundingOutpointKeys: new Set([
      ...options.plan.eligibleFundingOutpointKeys,
      ...availableFundingUtxos.map((entry) => outpointKey({ txid: entry.txid, vout: entry.vout })),
    ]),
  } as TPlan;
  const funded = await options.rpc.walletCreateFundedPsbt(
    options.walletName,
    options.plan.fixedInputs,
    options.plan.outputs,
    0,
    {
      add_inputs: true,
      include_unsafe: false,
      minconf: availableFundingMinConf,
      changeAddress: options.plan.changeAddress,
      ...(options.plan.changePosition == null ? {} : { changePosition: options.plan.changePosition }),
      lockUnspents: false,
      fee_rate: options.feeRate ?? DEFAULT_WALLET_MUTATION_FEE_RATE_SAT_VB,
      replaceable: true,
      subtractFeeFromOutputs: [],
    },
  );
  const decoded = await options.rpc.decodePsbt(funded.psbt);
  options.validateFundedDraft(decoded, funded, validationPlan);
  return {
    funded,
    decoded,
  };
}

export async function buildWalletMutationTransaction<TPlan>(options: {
  rpc: WalletMutationRpcClient;
  walletName: string;
  state: WalletStateV1;
  plan: TPlan & {
    fixedInputs: FixedWalletInput[];
    outputs: unknown[];
    changeAddress: string;
    changePosition?: number | null;
    allowedFundingScriptPubKeyHex: string;
    eligibleFundingOutpointKeys: Set<string>;
  };
  validateFundedDraft(
    decoded: RpcDecodedPsbt,
    funded: RpcWalletCreateFundedPsbtResult,
    plan: TPlan,
  ): void;
  finalizeErrorCode: string;
  mempoolRejectPrefix: string;
  feeRate?: number;
  availableFundingMinConf?: number;
  temporarilyUnlockedPolicyOutpoints?: readonly OutpointRecord[];
  recoverManagedCoreWalletLockedOnce?: boolean;
  onManagedCoreWalletLockedRecoveryOutcome?: (outcome: "recovered" | "still-locked") => void;
}): Promise<BuiltWalletMutationTransaction> {
  const temporaryBuilderLockedOutpoints: OutpointRecord[] = [];

  try {
    const { funded, decoded } = await fundAndValidateWalletMutationDraft({
      rpc: options.rpc,
      walletName: options.walletName,
      plan: options.plan,
      validateFundedDraft: options.validateFundedDraft,
      feeRate: options.feeRate,
      availableFundingMinConf: options.availableFundingMinConf,
    });
    const { signed, rawHex, decodedRaw } = await signAndFinalizeWalletMutation({
      rpc: options.rpc,
      walletName: options.walletName,
      state: options.state,
      psbt: funded.psbt,
      finalizeErrorCode: options.finalizeErrorCode,
      mempoolRejectPrefix: options.mempoolRejectPrefix,
      recoverManagedCoreWalletLockedOnce: options.recoverManagedCoreWalletLockedOnce,
      onManagedCoreWalletLockedRecoveryOutcome: options.onManagedCoreWalletLockedRecoveryOutcome,
    });

    return {
      funded,
      decoded,
      psbt: signed.psbt,
      rawHex,
      txid: decodedRaw.txid,
      wtxid: decodedRaw.hash ?? null,
      temporaryBuilderLockedOutpoints,
    };
  } catch (error) {
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, temporaryBuilderLockedOutpoints);
    throw error;
  }
}

export async function buildWalletMutationTransactionWithReserveFallback<TPlan>(options: {
  rpc: WalletMutationRpcClient;
  walletName: string;
  state: WalletStateV1;
  plan: TPlan & {
    fixedInputs: FixedWalletInput[];
    outputs: unknown[];
    changeAddress: string;
    changePosition: number;
    allowedFundingScriptPubKeyHex: string;
    eligibleFundingOutpointKeys: Set<string>;
  };
  validateFundedDraft(
    decoded: RpcDecodedPsbt,
    funded: RpcWalletCreateFundedPsbtResult,
    plan: TPlan,
  ): void;
  finalizeErrorCode: string;
  mempoolRejectPrefix: string;
  feeRate?: number;
  availableFundingMinConf?: number;
}): Promise<BuiltWalletMutationTransaction> {
  void isReserveFloorFundingError;
  void computeRemainingFundingValueSats;
  return buildWalletMutationTransaction({
    rpc: options.rpc,
    walletName: options.walletName,
    state: options.state,
    plan: options.plan,
    validateFundedDraft: options.validateFundedDraft,
    finalizeErrorCode: options.finalizeErrorCode,
    mempoolRejectPrefix: options.mempoolRejectPrefix,
    feeRate: options.feeRate,
    availableFundingMinConf: options.availableFundingMinConf,
  });
}
