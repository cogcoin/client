import type {
  RpcDecodedPsbt,
  RpcListUnspentEntry,
} from "../../../bitcoind/types.js";
import {
  buildWalletMutationTransactionWithReserveFallback,
  outpointKey,
} from "../common.js";
import type {
  BuiltReputationTransaction,
  ReputationPlan,
  ReputationRpcClient,
} from "./types.js";
import type { WalletStateV1 } from "../../types.js";
import type { MutationSender } from "../common.js";

function encodeOpReturnScript(payload: Uint8Array): string {
  if (payload.length <= 75) {
    return Buffer.concat([
      Buffer.from([0x6a, payload.length]),
      Buffer.from(payload),
    ]).toString("hex");
  }

  return Buffer.concat([
    Buffer.from([0x6a, 0x4c, payload.length]),
    Buffer.from(payload),
  ]).toString("hex");
}

export function buildPlanForReputationOperation(options: {
  state: WalletStateV1;
  allUtxos: RpcListUnspentEntry[];
  sender: MutationSender;
  opReturnData: Uint8Array;
  errorPrefix: string;
}): ReputationPlan {
  const fundingUtxos = options.allUtxos.filter((entry) =>
    entry.scriptPubKey === options.state.funding.scriptPubKeyHex
    && entry.confirmations >= 1
    && entry.spendable !== false
    && entry.safe !== false
  );

  return {
    sender: options.sender,
    changeAddress: options.state.funding.address,
    fixedInputs: [],
    outputs: [{ data: Buffer.from(options.opReturnData).toString("hex") }],
    changePosition: 1,
    expectedOpReturnScriptHex: encodeOpReturnScript(options.opReturnData),
    allowedFundingScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
    eligibleFundingOutpointKeys: new Set(
      fundingUtxos.map((entry) => outpointKey({ txid: entry.txid, vout: entry.vout })),
    ),
    errorPrefix: options.errorPrefix,
  };
}

export function validateFundedReputationDraft(
  decoded: RpcDecodedPsbt,
  funded: BuiltReputationTransaction["funded"],
  plan: ReputationPlan,
): void {
  const inputs = decoded.tx.vin;
  const outputs = decoded.tx.vout;

  if (inputs.length === 0) {
    throw new Error(`${plan.errorPrefix}_missing_sender_input`);
  }

  if (outputs[0]?.scriptPubKey?.hex !== plan.expectedOpReturnScriptHex) {
    throw new Error(`${plan.errorPrefix}_opreturn_mismatch`);
  }

  if (funded.changepos === -1) {
    if (outputs.length !== 1) {
      throw new Error(`${plan.errorPrefix}_unexpected_output_count`);
    }
    return;
  }

  if (funded.changepos !== plan.changePosition || outputs.length !== 2) {
    throw new Error(`${plan.errorPrefix}_change_position_mismatch`);
  }

  if (outputs[funded.changepos]?.scriptPubKey?.hex !== plan.allowedFundingScriptPubKeyHex) {
    throw new Error(`${plan.errorPrefix}_change_output_mismatch`);
  }
}

export async function buildReputationTransaction(options: {
  rpc: ReputationRpcClient;
  walletName: string;
  state: WalletStateV1;
  plan: ReputationPlan;
  feeRateSatVb: number;
}): Promise<BuiltReputationTransaction> {
  return buildWalletMutationTransactionWithReserveFallback({
    rpc: options.rpc,
    walletName: options.walletName,
    state: options.state,
    plan: options.plan,
    validateFundedDraft: validateFundedReputationDraft,
    finalizeErrorCode: `${options.plan.errorPrefix}_finalize_failed`,
    mempoolRejectPrefix: `${options.plan.errorPrefix}_mempool_rejected`,
    feeRate: options.feeRateSatVb,
  });
}
