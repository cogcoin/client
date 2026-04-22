import { getListing } from "@cogcoin/indexer/queries";

import { serializeDomainTransfer } from "../../../cogop/index.js";
import { confirmTransfer } from "../confirm.js";
import { createDomainMarketDraftMutation } from "../draft.js";
import {
  createDomainMarketIntentFingerprint,
  createResolvedDomainMarketRecipientSummary,
  createResolvedDomainMarketSenderSummary,
  createTransferEconomicEffectSummary,
  normalizeDomainMarketDomainName,
  resolveOwnedDomainOperation,
} from "../intent.js";
import {
  getTransferStatusAfterAcceptance,
  reserveTransferredDomainRecord,
} from "../draft.js";
import {
  createTransferResult,
  createTransferReuseResult,
} from "../result.js";
import type {
  DomainMarketMutationVariant,
  TransferDomainMutationOperation,
  TransferDomainOptions,
} from "../types.js";
import { normalizeBtcTarget } from "../../targets.js";
import { upsertPendingMutation } from "../../journal.js";
import { updateMutationRecord } from "../../common.js";

export function createTransferDomainVariant(
  options: TransferDomainOptions,
): DomainMarketMutationVariant<TransferDomainMutationOperation> {
  const normalizedDomainName = normalizeDomainMarketDomainName(options.domainName);
  const recipient = normalizeBtcTarget(options.target);

  return {
    controlLockPurpose: "wallet-transfer",
    preemptionReason: "wallet-transfer",
    errorPrefix: "wallet_transfer",
    repairRequiredErrorCode: "wallet_transfer_repair_required",
    resolveOperation(readContext) {
      const operation = resolveOwnedDomainOperation(readContext, normalizedDomainName, "wallet_transfer");
      const resolvedSender = createResolvedDomainMarketSenderSummary(operation.sender, operation.senderSelector);
      const resolvedRecipient = createResolvedDomainMarketRecipientSummary(recipient);
      const resolvedEconomicEffect = createTransferEconomicEffectSummary(
        getListing(readContext.snapshot!.state, operation.chainDomain.domainId) !== null,
      );
      if (operation.sender.scriptPubKeyHex === recipient.scriptPubKeyHex) {
        throw new Error("wallet_transfer_self_transfer");
      }

      return {
        ...operation,
        normalizedDomainName,
        recipient,
        resolvedSender,
        resolvedRecipient,
        resolvedEconomicEffect,
      };
    },
    createIntentFingerprint(operation) {
      return createDomainMarketIntentFingerprint([
        "transfer",
        operation.state.walletRootId,
        operation.normalizedDomainName,
        operation.sender.scriptPubKeyHex,
        operation.recipient.scriptPubKeyHex,
      ]);
    },
    confirm(operation) {
      return confirmTransfer(
        options.prompter,
        operation.normalizedDomainName,
        operation.resolvedSender,
        operation.resolvedRecipient,
        operation.resolvedEconomicEffect,
        options.assumeYes,
      );
    },
    createDraftMutation({ operation, existingMutation, feeSelection, intentFingerprintHex, nowUnixMs }) {
      return createDomainMarketDraftMutation({
        kind: "transfer",
        domainName: operation.normalizedDomainName,
        sender: operation.sender,
        recipientScriptPubKeyHex: operation.recipient.scriptPubKeyHex,
        intentFingerprintHex,
        nowUnixMs,
        feeSelection,
        existing: existingMutation,
      });
    },
    createOpReturnData(operation) {
      return serializeDomainTransfer(
        operation.chainDomain.domainId,
        Buffer.from(operation.recipient.scriptPubKeyHex, "hex"),
      ).opReturnData;
    },
    async afterAccepted({ operation, acceptedState, broadcastingMutation, built, nowUnixMs, snapshot }) {
      const finalStatus = getTransferStatusAfterAcceptance({
        snapshot,
        domainName: operation.normalizedDomainName,
        recipientScriptPubKeyHex: operation.recipient.scriptPubKeyHex,
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
          currentOwnerScriptPubKeyHex: operation.recipient.scriptPubKeyHex,
          nowUnixMs,
        }),
        mutation: finalMutation,
        status: finalStatus,
      };
    },
    createReuseResult({ operation, mutation, resolution, fees }) {
      return createTransferReuseResult({
        operation,
        mutation,
        resolution,
        fees,
      });
    },
    createResult({ operation, mutation, builtTxid, status, reusedExisting, fees }) {
      return createTransferResult({
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
