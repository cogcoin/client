import { lookupDomain } from "@cogcoin/indexer/queries";

import { confirmLock } from "../confirm.js";
import {
  createCogIntentFingerprint,
  createLockCogOpReturnData,
  MAX_LOCK_DURATION_BLOCKS,
  normalizeCogDomainName,
  normalizePositiveCogAmount,
  parseHex32,
  parseTimeoutHeight,
  resolveIdentitySender,
} from "../intent.js";
import { createCogDraftMutation } from "../draft.js";
import {
  createCogResult,
  createCogReuseResult,
} from "../result.js";
import type {
  CogMutationVariant,
  LockCogMutationOperation,
  LockCogToDomainOptions,
} from "../types.js";

export function createLockCogVariant(
  options: LockCogToDomainOptions,
): CogMutationVariant<LockCogMutationOperation> {
  const amountCogtoshi = normalizePositiveCogAmount(options.amountCogtoshi, "wallet_lock_invalid_amount");
  const normalizedRecipientDomainName = normalizeCogDomainName(options.recipientDomainName);
  const condition = parseHex32(options.conditionHex, "wallet_lock_invalid_condition");
  if (condition.equals(Buffer.alloc(32))) {
    throw new Error("wallet_lock_invalid_condition");
  }

  return {
    controlLockPurpose: "wallet-lock-cog",
    preemptionReason: "wallet-cog-lock",
    errorPrefix: "wallet_lock",
    repairRequiredErrorCode: "wallet_lock_repair_required",
    resolveOperation(readContext) {
      const currentHeight = readContext.snapshot?.state.history.currentHeight ?? null;
      if (currentHeight === null) {
        throw new Error("wallet_lock_current_height_unavailable");
      }

      const timeoutHeight = parseTimeoutHeight(
        currentHeight,
        options.timeoutBlocksOrDuration,
        options.timeoutHeight ?? null,
      );
      if (timeoutHeight <= currentHeight || timeoutHeight > currentHeight + MAX_LOCK_DURATION_BLOCKS) {
        throw new Error("wallet_lock_invalid_timeout_height");
      }

      const recipientDomain = lookupDomain(readContext.snapshot!.state, normalizedRecipientDomainName);
      if (recipientDomain === null) {
        throw new Error("wallet_lock_domain_not_found");
      }
      if (!recipientDomain.anchored) {
        throw new Error("wallet_lock_domain_not_anchored");
      }
      if (readContext.snapshot!.state.consensus.nextLockId === 0xffff_ffff) {
        throw new Error("wallet_lock_id_space_exhausted");
      }

      return {
        ...resolveIdentitySender(readContext, "wallet_lock", amountCogtoshi, options.fromIdentity),
        amountCogtoshi,
        normalizedRecipientDomainName,
        recipientDomain,
        timeoutHeight,
        conditionHex: Buffer.from(condition).toString("hex"),
      };
    },
    createIntentFingerprint(operation) {
      return createCogIntentFingerprint([
        "lock",
        operation.state.walletRootId,
        operation.sender.scriptPubKeyHex,
        operation.normalizedRecipientDomainName,
        operation.amountCogtoshi,
        operation.timeoutHeight,
        operation.conditionHex,
      ]);
    },
    confirm(operation) {
      return confirmLock(
        options.prompter,
        operation.resolved,
        operation.amountCogtoshi,
        operation.normalizedRecipientDomainName,
        operation.timeoutHeight,
        options.assumeYes,
      );
    },
    createDraftMutation({ operation, existingMutation, feeSelection, intentFingerprintHex, nowUnixMs }) {
      return createCogDraftMutation({
        kind: "lock",
        sender: operation.sender,
        amountCogtoshi: operation.amountCogtoshi,
        recipientDomainName: operation.normalizedRecipientDomainName,
        timeoutHeight: operation.timeoutHeight,
        conditionHex: operation.conditionHex,
        intentFingerprintHex,
        nowUnixMs,
        feeSelection,
        existing: existingMutation,
      });
    },
    createOpReturnData(operation) {
      return createLockCogOpReturnData(operation);
    },
    createReuseResult({ operation, mutation, resolution, fees }) {
      return createCogReuseResult({
        kind: "lock",
        mutation,
        resolution,
        fees,
        amountCogtoshi: operation.amountCogtoshi,
        recipientDomainName: operation.normalizedRecipientDomainName,
        resolved: operation.resolved,
      });
    },
    createResult({ operation, mutation, builtTxid, status, reusedExisting, fees }) {
      return createCogResult({
        kind: "lock",
        mutation,
        builtTxid,
        status,
        reusedExisting,
        fees,
        amountCogtoshi: operation.amountCogtoshi,
        recipientDomainName: operation.normalizedRecipientDomainName,
        resolved: operation.resolved,
      });
    },
  };
}
