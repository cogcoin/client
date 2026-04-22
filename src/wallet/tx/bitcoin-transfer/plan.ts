import type { RpcDecodedPsbt } from "../../../bitcoind/types.js";
import type { BitcoinTransferPlan } from "./intent.js";

function btcValueToSats(value: number | string): bigint {
  const numeric = typeof value === "string" ? Number(value) : value;
  return BigInt(Math.round(numeric * 100_000_000));
}

export function validateFundedBitcoinTransfer(
  decoded: RpcDecodedPsbt,
  _funded: { fee: number },
  plan: BitcoinTransferPlan,
): void {
  if (decoded.tx.vin.length === 0) {
    throw new Error("wallet_bitcoin_transfer_missing_sender_input");
  }

  const recipientOutputs = decoded.tx.vout.filter((output) => output.scriptPubKey?.hex === plan.recipientScriptPubKeyHex);

  if (recipientOutputs.length !== 1) {
    throw new Error("wallet_bitcoin_transfer_missing_recipient_output");
  }

  if (btcValueToSats(recipientOutputs[0]!.value) !== plan.amountSats) {
    throw new Error("wallet_bitcoin_transfer_recipient_amount_mismatch");
  }

  const hasUnexpectedOutput = decoded.tx.vout.some((output) =>
    output.scriptPubKey?.hex !== plan.recipientScriptPubKeyHex
    && output.scriptPubKey?.hex !== plan.allowedFundingScriptPubKeyHex
  );

  if (hasUnexpectedOutput) {
    throw new Error("wallet_bitcoin_transfer_unexpected_output");
  }
}
