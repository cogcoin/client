import type { BitcoinBlock, BitcoinInput, BitcoinOutput, BitcoinTransaction } from "@cogcoin/indexer/types";

import { hexToBytes } from "../bytes.js";
import type { RpcBlock, RpcTransaction, RpcVin, RpcVout } from "./types.js";

function btcValueToSats(value: number | string): bigint {
  const source = typeof value === "number"
    ? value.toFixed(8)
    : value;

  const negative = source.startsWith("-");
  const unsigned = negative ? source.slice(1) : source;
  const [whole, fraction = ""] = unsigned.split(".");
  const normalizedFraction = fraction.padEnd(8, "0");

  if (normalizedFraction.length > 8) {
    throw new Error("rpc_output_value_precision_invalid");
  }

  const combined = `${whole || "0"}${normalizedFraction}`;
  const sats = BigInt(combined);
  return negative ? -sats : sats;
}

function normalizeInput(input: RpcVin): BitcoinInput {
  const scriptHex = input.prevout?.scriptPubKey?.hex;

  return {
    prevoutScriptPubKey: scriptHex ? hexToBytes(scriptHex) : null,
  };
}

function normalizeOutput(output: RpcVout): BitcoinOutput {
  const scriptHex = output.scriptPubKey?.hex;

  if (!scriptHex) {
    throw new Error("rpc_output_script_missing");
  }

  return {
    valueSats: btcValueToSats(output.value),
    scriptPubKey: hexToBytes(scriptHex),
  };
}

function normalizeTransaction(transaction: RpcTransaction): BitcoinTransaction {
  return {
    txid: hexToBytes(transaction.txid),
    inputs: transaction.vin.map(normalizeInput),
    outputs: transaction.vout.map(normalizeOutput),
  };
}

export function normalizeRpcBlock(block: RpcBlock): BitcoinBlock {
  return {
    height: block.height,
    hash: hexToBytes(block.hash),
    previousHash: block.previousblockhash ? hexToBytes(block.previousblockhash) : null,
    transactions: block.tx.map(normalizeTransaction),
  };
}
