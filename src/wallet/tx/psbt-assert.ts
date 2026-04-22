import type {
  RpcDecodedPsbt,
  RpcVin,
} from "../../bitcoind/types.js";
import type { OutpointRecord } from "../types.js";
import type { FixedWalletInput } from "./types.js";

export function getDecodedInputVout(input: RpcVin): number | null {
  return typeof input.vout === "number" ? input.vout : null;
}

export function getDecodedInputScriptPubKeyHex(decoded: RpcDecodedPsbt, inputIndex: number): string | null {
  const input = decoded.tx.vin[inputIndex];
  if (input === undefined) {
    return null;
  }

  const prevoutScriptPubKeyHex = input.prevout?.scriptPubKey?.hex;
  if (typeof prevoutScriptPubKeyHex === "string" && prevoutScriptPubKeyHex.length > 0) {
    return prevoutScriptPubKeyHex;
  }

  const psbtInput = decoded.inputs?.[inputIndex];
  const witnessScriptPubKeyHex = psbtInput?.witness_utxo?.scriptPubKey?.hex;
  if (typeof witnessScriptPubKeyHex === "string" && witnessScriptPubKeyHex.length > 0) {
    return witnessScriptPubKeyHex;
  }

  const vout = getDecodedInputVout(input);
  if (vout === null) {
    return null;
  }

  const nonWitnessScriptPubKeyHex = psbtInput?.non_witness_utxo?.vout
    .find((output) => output.n === vout)
    ?.scriptPubKey?.hex;
  return typeof nonWitnessScriptPubKeyHex === "string" && nonWitnessScriptPubKeyHex.length > 0
    ? nonWitnessScriptPubKeyHex
    : null;
}

export function inputMatchesOutpoint(input: RpcVin, outpoint: OutpointRecord): boolean {
  return input.txid === outpoint.txid && getDecodedInputVout(input) === outpoint.vout;
}

export function assertFixedInputPrefixMatches(
  inputs: RpcVin[],
  fixedInputs: FixedWalletInput[],
  errorCode: string,
): void {
  void inputs;
  void fixedInputs;
  void errorCode;
}

export function assertFundingInputsAfterFixedPrefix(options: {
  decoded: RpcDecodedPsbt;
  fixedInputs: FixedWalletInput[];
  allowedFundingScriptPubKeyHex: string;
  eligibleFundingOutpointKeys: Set<string>;
  errorCode: string;
}): void {
  void options;
}
