import type {
  RpcDecodedPsbt,
  RpcListUnspentEntry,
} from "../../../bitcoind/types.js";
import {
  buildWalletMutationTransactionWithReserveFallback,
  outpointKey,
  type MutationSender,
} from "../common.js";
import type {
  BuiltCogMutationTransaction,
  CogMutationPlan,
  WalletCogRpcClient,
} from "./types.js";
import type { WalletStateV1 } from "../../types.js";

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

export function buildPlanForCogOperation(options: {
  state: WalletStateV1;
  allUtxos: RpcListUnspentEntry[];
  sender: MutationSender;
  opReturnData: Uint8Array;
  errorPrefix: string;
}): CogMutationPlan {
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

export function validateFundedCogDraft(
  decoded: RpcDecodedPsbt,
  funded: BuiltCogMutationTransaction["funded"],
  plan: CogMutationPlan,
): void {
  const inputs = decoded.tx.vin;
  const outputs = decoded.tx.vout;

  if (inputs.length === 0) {
    throw new Error(`${plan.errorPrefix}_missing_sender_input`);
  }

  if (outputs[0]?.scriptPubKey?.hex !== plan.expectedOpReturnScriptHex) {
    throw new Error(`${plan.errorPrefix}_opreturn_mismatch`);
  }

  const expectedWithoutChange = 1;
  if (funded.changepos === -1) {
    if (outputs.length !== expectedWithoutChange) {
      throw new Error(`${plan.errorPrefix}_unexpected_output_count`);
    }
    return;
  }

  if (funded.changepos !== plan.changePosition || outputs.length !== expectedWithoutChange + 1) {
    throw new Error(`${plan.errorPrefix}_change_position_mismatch`);
  }

  if (outputs[funded.changepos]?.scriptPubKey?.hex !== plan.allowedFundingScriptPubKeyHex) {
    throw new Error(`${plan.errorPrefix}_change_output_mismatch`);
  }
}

export async function buildCogTransaction(options: {
  rpc: WalletCogRpcClient;
  walletName: string;
  state: WalletStateV1;
  plan: CogMutationPlan;
  feeRateSatVb: number;
}): Promise<BuiltCogMutationTransaction> {
  return buildWalletMutationTransactionWithReserveFallback({
    rpc: options.rpc,
    walletName: options.walletName,
    state: options.state,
    plan: options.plan,
    validateFundedDraft: validateFundedCogDraft,
    finalizeErrorCode: `${options.plan.errorPrefix}_finalize_failed`,
    mempoolRejectPrefix: `${options.plan.errorPrefix}_mempool_rejected`,
    feeRate: options.feeRateSatVb,
  });
}
