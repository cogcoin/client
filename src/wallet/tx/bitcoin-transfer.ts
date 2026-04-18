import { attachOrStartManagedBitcoindService } from "../../bitcoind/service.js";
import { createRpcClient } from "../../bitcoind/node.js";
import type {
  RpcDecodedPsbt,
  RpcListUnspentEntry,
} from "../../bitcoind/types.js";
import { acquireFileLock } from "../fs/lock.js";
import type { WalletPrompter } from "../lifecycle.js";
import { openWalletReadContext } from "../read/index.js";
import { resolveWalletRuntimePathsForTesting, type WalletRuntimePaths } from "../runtime.js";
import {
  createDefaultWalletSecretProvider,
  type WalletSecretProvider,
} from "../state/provider.js";
import type { WalletStateV1 } from "../types.js";
import { confirmYesNo } from "./confirm.js";
import {
  assertWalletBitcoinTransferContextReady,
  buildWalletMutationTransaction,
  isAlreadyAcceptedError,
  isBroadcastUnknownError,
  isInsufficientFundsError,
  outpointKey,
  pauseMiningForWalletMutation,
  unlockTemporaryBuilderLocks,
  type FixedWalletInput,
  type WalletMutationRpcClient,
} from "./common.js";
import { normalizeBtcTarget } from "./targets.js";

interface WalletBitcoinTransferRpcClient extends WalletMutationRpcClient {
  sendRawTransaction(hex: string): Promise<string>;
}

interface BitcoinTransferPlan {
  fixedInputs: FixedWalletInput[];
  outputs: unknown[];
  changeAddress: string;
  changePosition: number | null;
  allowedFundingScriptPubKeyHex: string;
  eligibleFundingOutpointKeys: Set<string>;
  recipientScriptPubKeyHex: string;
  amountSats: bigint;
}

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

function parsePositiveSats(value: string): bigint {
  const trimmed = value.trim();

  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error("wallet_bitcoin_transfer_invalid_amount");
  }

  return BigInt(trimmed);
}

function satsToBtcNumber(value: bigint): number {
  return Number(value) / 100_000_000;
}

function btcValueToSats(value: number | string): bigint {
  const numeric = typeof value === "string" ? Number(value) : value;
  return BigInt(Math.round(numeric * 100_000_000));
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

function isSpendableFundingUtxo(entry: RpcListUnspentEntry, fundingScriptPubKeyHex: string): boolean {
  return entry.scriptPubKey === fundingScriptPubKeyHex
    && entry.confirmations >= 1
    && entry.spendable !== false
    && entry.safe !== false;
}

function buildPlanForBitcoinTransfer(options: {
  state: WalletStateV1;
  allUtxos: RpcListUnspentEntry[];
  recipientAddress: string;
  recipientScriptPubKeyHex: string;
  amountSats: bigint;
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
      fundingUtxos.map((entry) => outpointKey({ txid: entry.txid, vout: entry.vout })),
    ),
    recipientScriptPubKeyHex: options.recipientScriptPubKeyHex,
    amountSats: options.amountSats,
  };
}

function validateFundedBitcoinTransfer(
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

async function confirmBitcoinTransfer(
  prompter: WalletPrompter,
  senderAddress: string,
  recipientAddress: string,
  amountSats: bigint,
  assumeYes = false,
): Promise<void> {
  prompter.writeLine(`You are sending ${amountSats.toString()} sats.`);
  prompter.writeLine(`Wallet address: ${senderAddress}`);
  prompter.writeLine(`Recipient: ${recipientAddress}`);
  await confirmYesNo(prompter, "This will publish a standard Bitcoin payment from the wallet address.", {
    assumeYes,
    errorCode: "wallet_bitcoin_transfer_confirmation_rejected",
    requiresTtyErrorCode: "wallet_bitcoin_transfer_requires_tty",
  });
}

export async function transferBitcoin(options: TransferBitcoinOptions): Promise<BitcoinTransferResult> {
  const amountSats = parsePositiveSats(options.amountSatsText);
  const recipient = normalizeRecipientAddress(options.target);
  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const controlLock = await acquireFileLock(paths.walletControlLockPath, {
    purpose: "wallet-bitcoin-transfer",
    walletRootId: null,
  });

  try {
    const miningPreemption = await pauseMiningForWalletMutation({
      paths,
      reason: "wallet-bitcoin-transfer",
    });
    const readContext = await (options.openReadContext ?? openWalletReadContext)({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      secretProvider: provider,
      walletControlLockHeld: true,
      paths,
    });

    try {
      assertWalletBitcoinTransferContextReady(readContext, "wallet_bitcoin_transfer");
      const state = readContext.localState.state;

      if (state.funding.scriptPubKeyHex === recipient.scriptPubKeyHex) {
        throw new Error("wallet_bitcoin_transfer_self_transfer");
      }

      await confirmBitcoinTransfer(
        options.prompter,
        state.funding.address,
        recipient.address,
        amountSats,
        options.assumeYes,
      );

      const node = await (options.attachService ?? attachOrStartManagedBitcoindService)({
        dataDir: options.dataDir,
        chain: "main",
        startHeight: 0,
        serviceLifetime: "ephemeral",
        walletRootId: state.walletRootId,
      });
      const rpc = (options.rpcFactory ?? createRpcClient)(node.rpc);
      const walletName = state.managedCoreWallet.walletName;
      const allUtxos = await rpc.listUnspent(walletName, 1);
      const plan = buildPlanForBitcoinTransfer({
        state,
        allUtxos,
        recipientAddress: recipient.address,
        recipientScriptPubKeyHex: recipient.scriptPubKeyHex,
        amountSats,
      });

      let built;

      try {
        built = await buildWalletMutationTransaction({
          rpc,
          walletName,
          state,
          plan,
          validateFundedDraft: validateFundedBitcoinTransfer,
          finalizeErrorCode: "wallet_bitcoin_transfer_finalize_failed",
          mempoolRejectPrefix: "wallet_bitcoin_transfer_mempool_reject",
        });
      } catch (error) {
        if (isInsufficientFundsError(error)) {
          throw new Error("wallet_bitcoin_transfer_insufficient_funds", { cause: error });
        }

        throw error;
      }

      try {
        await rpc.sendRawTransaction(built.rawHex);
      } catch (error) {
        if (!isAlreadyAcceptedError(error)) {
          if (isInsufficientFundsError(error)) {
            throw new Error("wallet_bitcoin_transfer_insufficient_funds", { cause: error });
          }

          if (isBroadcastUnknownError(error)) {
            throw new Error("wallet_bitcoin_transfer_broadcast_unknown", { cause: error });
          }

          throw error;
        }
      } finally {
        await unlockTemporaryBuilderLocks(rpc, walletName, built.temporaryBuilderLockedOutpoints);
      }

      return {
        amountSats,
        feeSats: btcValueToSats(built.funded.fee),
        senderAddress: state.funding.address,
        recipientAddress: recipient.address,
        recipientScriptPubKeyHex: recipient.scriptPubKeyHex,
        changeAddress: state.funding.address,
        txid: built.txid,
        wtxid: built.wtxid,
      };
    } finally {
      await readContext.close();
      await miningPreemption.release();
    }
  } finally {
    await controlLock.release();
  }
}
