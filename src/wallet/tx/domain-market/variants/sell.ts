import { serializeDomainSell } from "../../../cogop/index.js";
import { confirmSell } from "../confirm.js";
import {
  createDomainMarketIntentFingerprint,
  createResolvedDomainMarketSenderSummary,
  createSellEconomicEffectSummary,
  normalizeDomainMarketDomainName,
  resolveOwnedDomainOperation,
} from "../intent.js";
import {
  createDomainMarketDraftMutation,
  getSellStatusAfterAcceptance,
} from "../draft.js";
import {
  createSellResult,
  createSellReuseResult,
} from "../result.js";
import type {
  DomainMarketMutationVariant,
  SellDomainMutationOperation,
  SellDomainOptions,
} from "../types.js";
import { upsertPendingMutation } from "../../journal.js";
import { updateMutationRecord } from "../../common.js";

export function createSellDomainVariant(
  options: SellDomainOptions,
): DomainMarketMutationVariant<SellDomainMutationOperation> {
  const normalizedDomainName = normalizeDomainMarketDomainName(options.domainName);

  return {
    controlLockPurpose: "wallet-sell",
    preemptionReason: "wallet-sell",
    errorPrefix: "wallet_sell",
    repairRequiredErrorCode: "wallet_sell_repair_required",
    resolveOperation(readContext) {
      const operation = resolveOwnedDomainOperation(readContext, normalizedDomainName, "wallet_sell");
      return {
        ...operation,
        normalizedDomainName,
        listedPriceCogtoshi: options.listedPriceCogtoshi,
        resolvedSender: createResolvedDomainMarketSenderSummary(operation.sender, operation.senderSelector),
        resolvedEconomicEffect: createSellEconomicEffectSummary(options.listedPriceCogtoshi),
      };
    },
    createIntentFingerprint(operation) {
      return createDomainMarketIntentFingerprint([
        "sell",
        operation.state.walletRootId,
        operation.normalizedDomainName,
        operation.sender.scriptPubKeyHex,
        operation.listedPriceCogtoshi.toString(),
      ]);
    },
    async confirm(operation) {
      if (operation.listedPriceCogtoshi > 0n) {
        await confirmSell(
          options.prompter,
          operation.normalizedDomainName,
          operation.resolvedSender,
          operation.listedPriceCogtoshi,
          options.assumeYes,
        );
      }
    },
    createDraftMutation({ operation, existingMutation, feeSelection, intentFingerprintHex, nowUnixMs }) {
      return createDomainMarketDraftMutation({
        kind: "sell",
        domainName: operation.normalizedDomainName,
        sender: operation.sender,
        priceCogtoshi: operation.listedPriceCogtoshi,
        intentFingerprintHex,
        nowUnixMs,
        feeSelection,
        existing: existingMutation,
      });
    },
    createOpReturnData(operation) {
      return serializeDomainSell(
        operation.chainDomain.domainId,
        operation.listedPriceCogtoshi,
      ).opReturnData;
    },
    async afterAccepted({ operation, acceptedState, broadcastingMutation, built, nowUnixMs, snapshot }) {
      const finalStatus = getSellStatusAfterAcceptance({
        snapshot,
        domainName: operation.normalizedDomainName,
        senderScriptPubKeyHex: operation.sender.scriptPubKeyHex,
        listedPriceCogtoshi: operation.listedPriceCogtoshi,
      });
      const finalMutation = updateMutationRecord(broadcastingMutation, finalStatus, nowUnixMs, {
        attemptedTxid: built.txid,
        attemptedWtxid: built.wtxid,
        temporaryBuilderLockedOutpoints: [],
      });
      return {
        state: upsertPendingMutation(acceptedState, finalMutation),
        mutation: finalMutation,
        status: finalStatus,
      };
    },
    createReuseResult({ operation, mutation, resolution, fees }) {
      return createSellReuseResult({
        operation,
        mutation,
        resolution,
        fees,
      });
    },
    createResult({ operation, mutation, builtTxid, status, reusedExisting, fees }) {
      return createSellResult({
        operation,
        mutation,
        builtTxid,
        status,
        reusedExisting,
        fees,
      });
    },
  };
}
