import { normalizeBtcTarget } from "../../targets.js";
import { confirmSend } from "../confirm.js";
import {
  createCogIntentFingerprint,
  createSendCogOpReturnData,
  normalizePositiveCogAmount,
  resolveIdentitySender,
} from "../intent.js";
import { createCogDraftMutation } from "../draft.js";
import {
  createCogResult,
  createCogReuseResult,
} from "../result.js";
import type {
  CogMutationVariant,
  SendCogOperation,
  SendCogOptions,
} from "../types.js";

export function createSendCogVariant(
  options: SendCogOptions,
): CogMutationVariant<SendCogOperation> {
  const amountCogtoshi = normalizePositiveCogAmount(options.amountCogtoshi, "wallet_send_invalid_amount");
  const recipient = normalizeBtcTarget(options.target);

  return {
    controlLockPurpose: "wallet-send",
    preemptionReason: "wallet-send",
    errorPrefix: "wallet_send",
    repairRequiredErrorCode: "wallet_send_repair_required",
    resolveOperation(readContext) {
      const operation = resolveIdentitySender(readContext, "wallet_send", amountCogtoshi, options.fromIdentity);
      if (operation.sender.scriptPubKeyHex === recipient.scriptPubKeyHex) {
        throw new Error("wallet_send_self_transfer");
      }
      return {
        ...operation,
        amountCogtoshi,
        recipient,
      };
    },
    createIntentFingerprint(operation) {
      return createCogIntentFingerprint([
        "send",
        operation.state.walletRootId,
        operation.sender.scriptPubKeyHex,
        operation.recipient.scriptPubKeyHex,
        operation.amountCogtoshi,
      ]);
    },
    confirm(operation) {
      return confirmSend(
        options.prompter,
        operation.resolved,
        options.target,
        operation.recipient,
        operation.amountCogtoshi,
        options.assumeYes,
      );
    },
    createDraftMutation({ operation, existingMutation, feeSelection, intentFingerprintHex, nowUnixMs }) {
      return createCogDraftMutation({
        kind: "send",
        sender: operation.sender,
        recipientScriptPubKeyHex: operation.recipient.scriptPubKeyHex,
        amountCogtoshi: operation.amountCogtoshi,
        intentFingerprintHex,
        nowUnixMs,
        feeSelection,
        existing: existingMutation,
      });
    },
    createOpReturnData(operation) {
      return createSendCogOpReturnData(operation);
    },
    createReuseResult({ operation, mutation, resolution, fees }) {
      return createCogReuseResult({
        kind: "send",
        mutation,
        resolution,
        fees,
        amountCogtoshi: operation.amountCogtoshi,
        recipientScriptPubKeyHex: operation.recipient.scriptPubKeyHex,
        resolved: operation.resolved,
      });
    },
    createResult({ operation, mutation, builtTxid, status, reusedExisting, fees }) {
      return createCogResult({
        kind: "send",
        mutation,
        builtTxid,
        status,
        reusedExisting,
        fees,
        amountCogtoshi: operation.amountCogtoshi,
        recipientScriptPubKeyHex: operation.recipient.scriptPubKeyHex,
        resolved: operation.resolved,
      });
    },
  };
}
