import type { WalletStateV1 } from "../../types.js";
import type { BuiltWalletMutationTransaction } from "../common.js";

export interface BitcoinTransferResult {
  amountSats: bigint;
  feeSats: bigint;
  senderAddress: string;
  recipientAddress: string;
  recipientScriptPubKeyHex: string;
  changeAddress: string;
  txid: string;
  wtxid: string | null;
}

function btcValueToSats(value: number | string): bigint {
  const numeric = typeof value === "string" ? Number(value) : value;
  return BigInt(Math.round(numeric * 100_000_000));
}

export function createBitcoinTransferResult(options: {
  state: WalletStateV1;
  built: BuiltWalletMutationTransaction;
  amountSats: bigint;
  recipientAddress: string;
  recipientScriptPubKeyHex: string;
}): BitcoinTransferResult {
  return {
    amountSats: options.amountSats,
    feeSats: btcValueToSats(options.built.funded.fee),
    senderAddress: options.state.funding.address,
    recipientAddress: options.recipientAddress,
    recipientScriptPubKeyHex: options.recipientScriptPubKeyHex,
    changeAddress: options.state.funding.address,
    txid: options.built.txid,
    wtxid: options.built.wtxid,
  };
}
