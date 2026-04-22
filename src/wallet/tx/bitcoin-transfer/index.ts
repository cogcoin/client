import { attachOrStartManagedBitcoindService } from "../../../bitcoind/service.js";
import { createRpcClient } from "../../../bitcoind/node.js";
import { acquireFileLock } from "../../fs/lock.js";
import { openWalletReadContext } from "../../read/index.js";
import { resolveWalletRuntimePathsForTesting, type WalletRuntimePaths } from "../../runtime.js";
import {
  createDefaultWalletSecretProvider,
} from "../../state/provider.js";
import {
  assertWalletBitcoinTransferContextReady,
  buildWalletMutationTransaction,
  isAlreadyAcceptedError,
  isBroadcastUnknownError,
  isInsufficientFundsError,
  outpointKey,
  pauseMiningForWalletMutation,
  unlockTemporaryBuilderLocks,
} from "../common.js";
import { confirmBitcoinTransfer } from "./confirm.js";
import {
  buildPlanForBitcoinTransfer,
  resolveBitcoinTransferIntent,
  type TransferBitcoinOptions,
} from "./intent.js";
import { validateFundedBitcoinTransfer } from "./plan.js";
import { createBitcoinTransferResult, type BitcoinTransferResult } from "./result.js";

export type { TransferBitcoinOptions } from "./intent.js";
export type { BitcoinTransferResult } from "./result.js";

export async function transferBitcoin(options: TransferBitcoinOptions): Promise<BitcoinTransferResult> {
  const intent = resolveBitcoinTransferIntent(options);
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

      if (state.funding.scriptPubKeyHex === intent.recipientScriptPubKeyHex) {
        throw new Error("wallet_bitcoin_transfer_self_transfer");
      }

      await confirmBitcoinTransfer(options.prompter, {
        senderAddress: state.funding.address,
        recipientAddress: intent.recipientAddress,
        amountSats: intent.amountSats,
        assumeYes: options.assumeYes,
      });

      const node = await (options.attachService ?? attachOrStartManagedBitcoindService)({
        dataDir: options.dataDir,
        chain: "main",
        startHeight: 0,
        walletRootId: state.walletRootId,
      });
      const rpc = (options.rpcFactory ?? createRpcClient)(node.rpc);
      const walletName = state.managedCoreWallet.walletName;
      const allUtxos = await rpc.listUnspent(walletName, 1);
      const plan = buildPlanForBitcoinTransfer({
        state,
        allUtxos,
        recipientAddress: intent.recipientAddress,
        recipientScriptPubKeyHex: intent.recipientScriptPubKeyHex,
        amountSats: intent.amountSats,
        outpointKey,
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

      return createBitcoinTransferResult({
        state,
        built,
        amountSats: intent.amountSats,
        recipientAddress: intent.recipientAddress,
        recipientScriptPubKeyHex: intent.recipientScriptPubKeyHex,
      });
    } finally {
      await readContext.close();
      await miningPreemption.release();
    }
  } finally {
    await controlLock.release();
  }
}
