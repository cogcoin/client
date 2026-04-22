import type { RpcListUnspentEntry } from "../../bitcoind/types.js";
import type {
  OutpointRecord,
  WalletStateV1,
} from "../types.js";
import type {
  FixedWalletInput,
  MutationSender,
} from "./types.js";

export function isLocalWalletScript(state: WalletStateV1, scriptPubKeyHex: string | null | undefined): boolean {
  if (typeof scriptPubKeyHex !== "string" || scriptPubKeyHex.length === 0) {
    return false;
  }

  return scriptPubKeyHex === state.funding.scriptPubKeyHex
    || (state.localScriptPubKeyHexes ?? []).includes(scriptPubKeyHex);
}

export function createFundingMutationSender(state: WalletStateV1): MutationSender {
  return {
    localIndex: 0,
    scriptPubKeyHex: state.funding.scriptPubKeyHex,
    address: state.funding.address,
  };
}

export function formatCogAmount(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / 100_000_000n;
  const fraction = absolute % 100_000_000n;
  return `${sign}${whole.toString()}.${fraction.toString().padStart(8, "0")} COG`;
}

export function outpointKey(outpoint: OutpointRecord): string {
  return `${outpoint.txid}:${outpoint.vout}`;
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

export function findSpendableFundingInputsFromTransaction(options: {
  allUtxos: RpcListUnspentEntry[];
  txid: string;
  fundingScriptPubKeyHex: string;
  minConf?: number;
}): FixedWalletInput[] {
  const minConf = options.minConf ?? 0;
  return options.allUtxos
    .filter((entry) =>
      entry.txid === options.txid
      && isSpendableFundingUtxo(entry, options.fundingScriptPubKeyHex, minConf)
    )
    .sort((left, right) =>
      left.vout - right.vout
      || left.txid.localeCompare(right.txid)
    )
    .map((entry) => ({
      txid: entry.txid,
      vout: entry.vout,
    }));
}
