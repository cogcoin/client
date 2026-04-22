import { serializeDomainBuy } from "../../../cogop/index.js";
import { confirmBuy } from "../confirm.js";
import {
  createDomainMarketIntentFingerprint,
  createResolvedBuyerSummary,
  createResolvedSellerSummary,
  normalizeDomainMarketDomainName,
  resolveBuyOperation,
} from "../intent.js";
import {
  createDomainMarketDraftMutation,
  getBuyStatusAfterAcceptance,
  reserveTransferredDomainRecord,
} from "../draft.js";
import {
  createBuyResult,
  createBuyReuseResult,
} from "../result.js";
import type {
  BuyDomainMutationOperation,
  BuyDomainOptions,
  DomainMarketMutationVariant,
} from "../types.js";
import { upsertPendingMutation } from "../../journal.js";
import { updateMutationRecord } from "../../common.js";

export function createBuyDomainVariant(
  options: BuyDomainOptions,
): DomainMarketMutationVariant<BuyDomainMutationOperation> {
  const normalizedDomainName = normalizeDomainMarketDomainName(options.domainName);

  return {
    controlLockPurpose: "wallet-buy",
    preemptionReason: "wallet-buy",
    errorPrefix: "wallet_buy",
    repairRequiredErrorCode: "wallet_buy_repair_required",
    resolveOperation(readContext) {
      const operation = resolveBuyOperation(readContext, normalizedDomainName, options.fromIdentity ?? null);
      const model = readContext.model!;
      const sellerScriptPubKeyHex = Buffer.from(operation.chainDomain.ownerScriptPubKey).toString("hex");
      const sellerAddress = sellerScriptPubKeyHex === model.walletScriptPubKeyHex ? model.walletAddress : null;
      return {
        ...operation,
        normalizedDomainName,
        sellerScriptPubKeyHex,
        resolvedBuyer: createResolvedBuyerSummary(operation.buyerSelector, operation.sender),
        resolvedSeller: createResolvedSellerSummary(sellerScriptPubKeyHex, sellerAddress),
      };
    },
    createIntentFingerprint(operation) {
      return createDomainMarketIntentFingerprint([
        "buy",
        operation.state.walletRootId,
        operation.normalizedDomainName,
        operation.sender.scriptPubKeyHex,
        operation.listingPriceCogtoshi.toString(),
      ]);
    },
    confirm(operation) {
      return confirmBuy(
        options.prompter,
        operation.normalizedDomainName,
        operation.buyerSelector,
        operation.sender,
        operation.sellerScriptPubKeyHex,
        operation.resolvedSeller.address,
        operation.listingPriceCogtoshi,
        options.assumeYes,
      );
    },
    createDraftMutation({ operation, existingMutation, feeSelection, intentFingerprintHex, nowUnixMs }) {
      return createDomainMarketDraftMutation({
        kind: "buy",
        domainName: operation.normalizedDomainName,
        sender: operation.sender,
        priceCogtoshi: operation.listingPriceCogtoshi,
        intentFingerprintHex,
        nowUnixMs,
        feeSelection,
        existing: existingMutation,
      });
    },
    createOpReturnData(operation) {
      return serializeDomainBuy(
        operation.chainDomain.domainId,
        operation.listingPriceCogtoshi,
      ).opReturnData;
    },
    async beforePublish(operation) {
      const currentSellerHex = Buffer.from(operation.chainDomain.ownerScriptPubKey).toString("hex");
      if (currentSellerHex !== operation.sellerScriptPubKeyHex) {
        throw new Error("wallet_buy_stale_listing_owner");
      }
    },
    async afterAccepted({ operation, acceptedState, broadcastingMutation, built, nowUnixMs, snapshot }) {
      const finalStatus = getBuyStatusAfterAcceptance({
        snapshot,
        domainName: operation.normalizedDomainName,
        buyerScriptPubKeyHex: operation.sender.scriptPubKeyHex,
      });
      const finalMutation = updateMutationRecord(broadcastingMutation, finalStatus, nowUnixMs, {
        attemptedTxid: built.txid,
        attemptedWtxid: built.wtxid,
        temporaryBuilderLockedOutpoints: [],
      });
      return {
        state: reserveTransferredDomainRecord({
          state: upsertPendingMutation(acceptedState, finalMutation),
          domainName: operation.normalizedDomainName,
          domainId: operation.chainDomain.domainId,
          currentOwnerScriptPubKeyHex: operation.sender.scriptPubKeyHex,
          nowUnixMs,
        }),
        mutation: finalMutation,
        status: finalStatus,
      };
    },
    createReuseResult({ operation, mutation, resolution, fees }) {
      return createBuyReuseResult({
        operation,
        mutation,
        resolution,
        fees,
      });
    },
    createResult({ operation, mutation, builtTxid, status, reusedExisting, fees }) {
      return createBuyResult({
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
