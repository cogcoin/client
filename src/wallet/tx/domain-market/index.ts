import { mergeFixedWalletInputs } from "../common.js";
import {
  executeWalletMutationOperation,
  publishWalletMutation,
  resolveExistingWalletMutation,
} from "../executor.js";
import { reconcilePendingDomainMarketMutation } from "./draft.js";
import {
  prepareDomainMarketBuildState,
  buildPlanForDomainOperation,
  buildDomainMarketTransaction,
} from "./plan.js";
import type {
  BuiltDomainMarketTransaction,
  BuyDomainMutationOperation,
  BuyDomainOptions,
  DomainMarketMutationResult,
  DomainMarketMutationVariant,
  DomainMarketOperation,
  DomainMarketRpcClient,
  SellDomainMutationOperation,
  SellDomainOptions,
  TransferDomainMutationOperation,
  TransferDomainOptions,
} from "./types.js";
import { parseCogAmountToCogtoshi } from "./intent.js";
import { createBuyDomainVariant } from "./variants/buy.js";
import { createSellDomainVariant } from "./variants/sell.js";
import { createTransferDomainVariant } from "./variants/transfer.js";

export { parseCogAmountToCogtoshi } from "./intent.js";
export type {
  BuyDomainOptions,
  DomainMarketMutationResult,
  DomainMarketResolvedBuyerSummary,
  DomainMarketResolvedEconomicEffect,
  DomainMarketResolvedRecipientSummary,
  DomainMarketResolvedSellerSummary,
  DomainMarketResolvedSenderSummary,
  DomainMarketResolvedSummary,
  SellDomainOptions,
  TransferDomainOptions,
} from "./types.js";

async function executeDomainMarketMutation<TOperation extends DomainMarketOperation>(
  options: TransferDomainOptions | SellDomainOptions | BuyDomainOptions,
  variant: DomainMarketMutationVariant<TOperation>,
): Promise<DomainMarketMutationResult> {
  const execution = await executeWalletMutationOperation<
    TOperation,
    DomainMarketRpcClient,
    null,
    BuiltDomainMarketTransaction,
    DomainMarketMutationResult
  >({
    ...options,
    controlLockPurpose: variant.controlLockPurpose,
    preemptionReason: variant.preemptionReason,
    resolveOperation(readContext) {
      return variant.resolveOperation(readContext);
    },
    createIntentFingerprint(operation) {
      return variant.createIntentFingerprint(operation);
    },
    async resolveExistingMutation({ operation, existingMutation, execution }) {
      if (existingMutation === null) {
        return { state: operation.state, replacementFixedInputs: null, result: null };
      }
      return resolveExistingWalletMutation({
        existingMutation,
        execution,
        repairRequiredErrorCode: variant.repairRequiredErrorCode,
        reconcileExistingMutation: (mutation) => reconcilePendingDomainMarketMutation({
          state: operation.state,
          mutation,
          provider: execution.provider,
          nowUnixMs: execution.nowUnixMs,
          paths: execution.paths,
          rpc: execution.rpc,
          walletName: execution.walletName,
          context: execution.readContext,
        }),
        createReuseResult: ({ mutation, resolution, fees }) => variant.createReuseResult({
          operation,
          mutation,
          resolution,
          fees,
        }),
      });
    },
    confirm({ operation }) {
      return variant.confirm(operation);
    },
    createDraftMutation({ operation, existingMutation, execution, intentFingerprintHex }) {
      return {
        mutation: variant.createDraftMutation({
          operation,
          existingMutation,
          feeSelection: execution.feeSelection,
          intentFingerprintHex,
          nowUnixMs: execution.nowUnixMs,
        }),
        prepared: null,
      };
    },
    async prepareBuildState({ state, execution }) {
      return (await prepareDomainMarketBuildState({
        rpc: execution.rpc,
        walletName: execution.walletName,
        state,
        provider: execution.provider,
        nowUnixMs: execution.nowUnixMs,
        paths: execution.paths,
        preflightCoinControl: false,
      })).state;
    },
    async build({ operation, state, execution, replacementFixedInputs }) {
      const domainPlan = buildPlanForDomainOperation({
        state,
        allUtxos: await execution.rpc.listUnspent(execution.walletName, 1),
        sender: operation.sender,
        opReturnData: variant.createOpReturnData(operation),
        errorPrefix: variant.errorPrefix,
      });
      return buildDomainMarketTransaction({
        rpc: execution.rpc,
        walletName: execution.walletName,
        state,
        plan: {
          ...domainPlan,
          fixedInputs: mergeFixedWalletInputs(domainPlan.fixedInputs, replacementFixedInputs),
        },
        feeRateSatVb: execution.feeSelection.feeRateSatVb,
      });
    },
    async beforePublish({ operation }) {
      if (variant.beforePublish !== undefined) {
        await variant.beforePublish(operation);
      }
    },
    publish({ operation, state, execution, built, mutation }) {
      return publishWalletMutation({
        rpc: execution.rpc,
        walletName: execution.walletName,
        snapshotHeight: execution.readContext.snapshot?.tip?.height ?? null,
        built,
        mutation,
        state,
        provider: execution.provider,
        nowUnixMs: execution.nowUnixMs,
        paths: execution.paths,
        errorPrefix: variant.errorPrefix,
        async afterAccepted({ state: acceptedState, broadcastingMutation, built, nowUnixMs }) {
          return variant.afterAccepted({
            operation,
            acceptedState,
            broadcastingMutation,
            built,
            nowUnixMs,
            snapshot: execution.readContext.snapshot,
          });
        },
      });
    },
    createResult({ operation, mutation, built, status, reusedExisting, fees }) {
      return variant.createResult({
        operation,
        mutation,
        builtTxid: built?.txid ?? null,
        status: status as DomainMarketMutationResult["status"],
        reusedExisting,
        fees,
      });
    },
  });

  return execution.result;
}

export async function transferDomain(options: TransferDomainOptions): Promise<DomainMarketMutationResult> {
  return executeDomainMarketMutation(options, createTransferDomainVariant(options));
}

export async function sellDomain(options: SellDomainOptions): Promise<DomainMarketMutationResult> {
  if (options.listedPriceCogtoshi < 0n) {
    throw new Error("wallet_sell_invalid_amount");
  }

  return executeDomainMarketMutation(options, createSellDomainVariant(options));
}

export async function buyDomain(options: BuyDomainOptions): Promise<DomainMarketMutationResult> {
  return executeDomainMarketMutation(options, createBuyDomainVariant(options));
}
