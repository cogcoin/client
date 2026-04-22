import type { RpcListUnspentEntry } from "../../../bitcoind/types.js";
import { attachOrStartManagedBitcoindService } from "../../../bitcoind/service.js";
import { createRpcClient } from "../../../bitcoind/node.js";
import type { WalletPrompter } from "../../lifecycle.js";
import { openWalletReadContext } from "../../read/index.js";
import type { WalletRuntimePaths } from "../../runtime.js";
import type { WalletSecretProvider } from "../../state/provider.js";
import type { WalletStateV1 } from "../../types.js";
import { normalizeBtcTarget } from "../targets.js";
import type {
  FixedWalletInput,
  WalletMutationRpcClient,
} from "../common.js";

export interface WalletBitcoinTransferRpcClient extends WalletMutationRpcClient {
  sendRawTransaction(hex: string): Promise<string>;
}

export interface TransferBitcoinOptions {
  amountSatsText: string;
  target: string;
  dataDir: string;
  databasePath: string;
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  assumeYes?: boolean;
  paths?: WalletRuntimePaths;
  openReadContext?: typeof openWalletReadContext;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => WalletBitcoinTransferRpcClient;
}

export interface BitcoinTransferIntent {
  amountSats: bigint;
  recipientAddress: string;
  recipientScriptPubKeyHex: string;
}

export interface BitcoinTransferPlan {
  fixedInputs: FixedWalletInput[];
  outputs: unknown[];
  changeAddress: string;
  changePosition: number | null;
  allowedFundingScriptPubKeyHex: string;
  eligibleFundingOutpointKeys: Set<string>;
  recipientScriptPubKeyHex: string;
  amountSats: bigint;
}

function parsePositiveSats(value: string): bigint {
  const trimmed = value.trim();

  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error("wallet_bitcoin_transfer_invalid_amount");
  }

  return BigInt(trimmed);
}

function normalizeRecipientAddress(target: string): {
  address: string;
  scriptPubKeyHex: string;
} {
  const trimmed = target.trim();

  try {
    const normalized = normalizeBtcTarget(trimmed);

    if (trimmed.startsWith("spk:") || normalized.opaque || normalized.address === null) {
      throw new Error("wallet_bitcoin_transfer_address_required");
    }

    return {
      address: normalized.address,
      scriptPubKeyHex: normalized.scriptPubKeyHex,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "wallet_bitcoin_transfer_address_required") {
      throw error;
    }

    if (trimmed.startsWith("spk:")) {
      throw new Error("wallet_bitcoin_transfer_address_required", { cause: error });
    }

    if (
      error instanceof Error
      && (
        error.message === "wallet_target_missing"
        || error.message === "wallet_target_invalid_address"
        || error.message === "wallet_target_invalid_script"
      )
    ) {
      throw new Error("wallet_bitcoin_transfer_invalid_address", { cause: error });
    }

    throw error;
  }
}

function satsToBtcNumber(value: bigint): number {
  return Number(value) / 100_000_000;
}

function isSpendableFundingUtxo(entry: RpcListUnspentEntry, fundingScriptPubKeyHex: string): boolean {
  return entry.scriptPubKey === fundingScriptPubKeyHex
    && entry.confirmations >= 1
    && entry.spendable !== false
    && entry.safe !== false;
}

export function resolveBitcoinTransferIntent(options: TransferBitcoinOptions): BitcoinTransferIntent {
  const amountSats = parsePositiveSats(options.amountSatsText);
  const recipient = normalizeRecipientAddress(options.target);
  return {
    amountSats,
    recipientAddress: recipient.address,
    recipientScriptPubKeyHex: recipient.scriptPubKeyHex,
  };
}

export function buildPlanForBitcoinTransfer(options: {
  state: WalletStateV1;
  allUtxos: RpcListUnspentEntry[];
  recipientAddress: string;
  recipientScriptPubKeyHex: string;
  amountSats: bigint;
  outpointKey(outpoint: { txid: string; vout: number }): string;
}): BitcoinTransferPlan {
  const fundingUtxos = options.allUtxos.filter((entry) =>
    isSpendableFundingUtxo(entry, options.state.funding.scriptPubKeyHex)
  );

  return {
    fixedInputs: [],
    outputs: [
      {
        [options.recipientAddress]: satsToBtcNumber(options.amountSats),
      },
    ],
    changeAddress: options.state.funding.address,
    changePosition: null,
    allowedFundingScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
    eligibleFundingOutpointKeys: new Set(
      fundingUtxos.map((entry) => options.outpointKey({ txid: entry.txid, vout: entry.vout })),
    ),
    recipientScriptPubKeyHex: options.recipientScriptPubKeyHex,
    amountSats: options.amountSats,
  };
}
