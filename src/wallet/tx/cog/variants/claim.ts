import { confirmClaim } from "../confirm.js";
import {
  createClaimCogOpReturnData,
  createCogIntentFingerprint,
  resolveClaimSender,
  ZERO_PREIMAGE_HEX,
} from "../intent.js";
import { createCogDraftMutation } from "../draft.js";
import {
  createCogResult,
  createCogReuseResult,
} from "../result.js";
import type {
  ClaimCogLockOptions,
  ClaimCogMutationOperation,
  CogMutationVariant,
  ReclaimCogLockOptions,
} from "../types.js";

function createClaimLikeVariant(
  options: ClaimCogLockOptions,
  reclaim: boolean,
): CogMutationVariant<ClaimCogMutationOperation> {
  const preimageHex = reclaim ? ZERO_PREIMAGE_HEX : options.preimageHex;
  const errorPrefix = reclaim ? "wallet_reclaim" : "wallet_claim";

  return {
    controlLockPurpose: reclaim ? "wallet-reclaim" : "wallet-claim",
    preemptionReason: reclaim ? "wallet-reclaim" : "wallet-claim",
    errorPrefix,
    repairRequiredErrorCode: `${errorPrefix}_repair_required`,
    resolveOperation(readContext) {
      return {
        ...resolveClaimSender(readContext, options.lockId, preimageHex, reclaim),
        preimageHex,
        errorPrefix,
      };
    },
    createIntentFingerprint(operation) {
      return createCogIntentFingerprint([
        reclaim ? "reclaim" : "claim",
        operation.state.walletRootId,
        operation.sender.scriptPubKeyHex,
        operation.lockId,
        operation.preimageHex,
      ]);
    },
    confirm(operation) {
      return confirmClaim(options.prompter, {
        kind: reclaim ? "reclaim" : "claim",
        lockId: operation.lockId,
        recipientDomainName: operation.recipientDomainName,
        amountCogtoshi: operation.amountCogtoshi,
        resolved: operation.resolved,
        assumeYes: options.assumeYes,
      });
    },
    createDraftMutation({ operation, existingMutation, feeSelection, intentFingerprintHex, nowUnixMs }) {
      return createCogDraftMutation({
        kind: "claim",
        sender: operation.sender,
        amountCogtoshi: operation.amountCogtoshi,
        recipientDomainName: operation.recipientDomainName,
        lockId: operation.lockId,
        preimageHex: operation.preimageHex,
        intentFingerprintHex,
        nowUnixMs,
        feeSelection,
        existing: existingMutation,
      });
    },
    createOpReturnData(operation) {
      return createClaimCogOpReturnData(operation);
    },
    createReuseResult({ operation, mutation, resolution, fees }) {
      return createCogReuseResult({
        kind: "claim",
        mutation,
        resolution,
        fees,
        amountCogtoshi: operation.amountCogtoshi,
        recipientDomainName: operation.recipientDomainName,
        lockId: operation.lockId,
        resolved: operation.resolved,
      });
    },
    createResult({ operation, mutation, builtTxid, status, reusedExisting, fees }) {
      return createCogResult({
        kind: "claim",
        mutation,
        builtTxid,
        status,
        reusedExisting,
        fees,
        amountCogtoshi: operation.amountCogtoshi,
        recipientDomainName: operation.recipientDomainName,
        lockId: operation.lockId,
        resolved: operation.resolved,
      });
    },
  };
}

export function createClaimCogVariant(
  options: ClaimCogLockOptions,
): CogMutationVariant<ClaimCogMutationOperation> {
  return createClaimLikeVariant(options, false);
}

export function createReclaimCogVariant(
  options: ReclaimCogLockOptions,
): CogMutationVariant<ClaimCogMutationOperation> {
  return createClaimLikeVariant({
    ...options,
    preimageHex: ZERO_PREIMAGE_HEX,
  }, true);
}
