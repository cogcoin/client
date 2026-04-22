import {
  mergeFixedWalletInputs,
} from "../common.js";
import {
  executeWalletMutationOperation,
  publishWalletMutation,
  resolveExistingWalletMutation,
} from "../executor.js";
import {
  confirmReputationMutation,
} from "./confirm.js";
import {
  createReputationDraftMutation,
  reconcilePendingReputationMutation,
} from "./draft.js";
import {
  createReputationOpReturnData,
  createStandaloneReputationFingerprint,
  resolveStandaloneReputationOperation,
} from "./intent.js";
import {
  buildPlanForReputationOperation,
  buildReputationTransaction,
} from "./plan.js";
import {
  createReputationResult,
  createReputationReuseResult,
} from "./result.js";
import type {
  BuiltReputationTransaction,
  GiveReputationOptions,
  ReputationMutationKind,
  ReputationMutationResult,
  ReputationRpcClient,
  RevokeReputationOptions,
  StandaloneReputationOperation,
} from "./types.js";

export type {
  GiveReputationOptions,
  ReputationMutationResult,
  ReputationResolvedEffect,
  ReputationResolvedReviewSummary,
  ReputationResolvedSenderSummary,
  ReputationResolvedSummary,
  RevokeReputationOptions,
} from "./types.js";

async function submitReputationMutation(options: (
  GiveReputationOptions | RevokeReputationOptions
) & {
  kind: ReputationMutationKind;
  errorPrefix: string;
}): Promise<ReputationMutationResult> {
  if (!options.prompter.isInteractive && options.assumeYes !== true) {
    throw new Error(`${options.errorPrefix}_requires_tty`);
  }

  if (options.amountCogtoshi <= 0n) {
    throw new Error(`${options.errorPrefix}_invalid_amount`);
  }

  const execution = await executeWalletMutationOperation<
    StandaloneReputationOperation,
    ReputationRpcClient,
    null,
    BuiltReputationTransaction,
    ReputationMutationResult
  >({
    ...options,
    controlLockPurpose: options.errorPrefix,
    preemptionReason: options.errorPrefix,
    async resolveOperation(readContext) {
      return resolveStandaloneReputationOperation({
        readContext: readContext as StandaloneReputationOperation["readContext"],
        sourceDomainName: options.sourceDomainName,
        targetDomainName: options.targetDomainName,
        amountCogtoshi: options.amountCogtoshi,
        reviewText: options.reviewText,
        kind: options.kind,
        errorPrefix: options.errorPrefix,
      });
    },
    createIntentFingerprint(operation) {
      return createStandaloneReputationFingerprint({
        kind: options.kind,
        operation,
        amountCogtoshi: options.amountCogtoshi,
      });
    },
    async resolveExistingMutation({ operation, existingMutation, execution }) {
      if (existingMutation === null) {
        return {
          state: operation.state,
          replacementFixedInputs: null,
          result: null,
        };
      }

      return resolveExistingWalletMutation({
        existingMutation,
        execution,
        repairRequiredErrorCode: `${options.errorPrefix}_repair_required`,
        reconcileExistingMutation: (mutation) => reconcilePendingReputationMutation({
          state: operation.state,
          mutation,
          provider: execution.provider,
          nowUnixMs: execution.nowUnixMs,
          paths: execution.paths,
          rpc: execution.rpc,
          walletName: execution.walletName,
          context: execution.readContext,
        }),
        createReuseResult: ({ mutation, resolution, fees }) => createReputationReuseResult({
          kind: options.kind,
          operation,
          amountCogtoshi: options.amountCogtoshi,
          mutation,
          resolution,
          fees,
        }),
      });
    },
    async confirm({ operation }) {
      await confirmReputationMutation(options.prompter, {
        kind: options.kind === "rep-give" ? "give" : "revoke",
        sourceDomainName: operation.normalizedSourceDomainName,
        targetDomainName: operation.normalizedTargetDomainName,
        amountCogtoshi: options.amountCogtoshi,
        reviewText: operation.review.text,
        resolved: operation.resolved,
        assumeYes: options.assumeYes,
      });
    },
    createDraftMutation({ operation, existingMutation, execution, intentFingerprintHex }) {
      return {
        mutation: createReputationDraftMutation({
          kind: options.kind,
          sourceDomainName: operation.normalizedSourceDomainName,
          targetDomainName: operation.normalizedTargetDomainName,
          amountCogtoshi: options.amountCogtoshi,
          sender: operation.sender,
          intentFingerprintHex,
          nowUnixMs: execution.nowUnixMs,
          reviewPayloadHex: operation.review.payloadHex,
          feeSelection: execution.feeSelection,
          existing: existingMutation,
        }),
        prepared: null,
      };
    },
    async build({ operation, state, execution, replacementFixedInputs }) {
      const reputationPlan = buildPlanForReputationOperation({
        state,
        allUtxos: await execution.rpc.listUnspent(execution.walletName, 1),
        sender: operation.sender,
        opReturnData: createReputationOpReturnData({
          kind: options.kind,
          operation,
          amountCogtoshi: options.amountCogtoshi,
        }),
        errorPrefix: options.errorPrefix,
      });

      return buildReputationTransaction({
        rpc: execution.rpc,
        walletName: execution.walletName,
        state,
        plan: {
          ...reputationPlan,
          fixedInputs: mergeFixedWalletInputs(reputationPlan.fixedInputs, replacementFixedInputs),
        },
        feeRateSatVb: execution.feeSelection.feeRateSatVb,
      });
    },
    publish({ state, execution, built, mutation }) {
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
        errorPrefix: options.errorPrefix,
      });
    },
    createResult({ operation, mutation, built, status, reusedExisting, fees }) {
      return createReputationResult({
        kind: options.kind,
        operation,
        amountCogtoshi: options.amountCogtoshi,
        mutation,
        builtTxid: built?.txid ?? null,
        status: status as ReputationMutationResult["status"],
        reusedExisting,
        fees,
      });
    },
  });

  return execution.result;
}

export async function giveReputation(
  options: GiveReputationOptions,
): Promise<ReputationMutationResult> {
  return submitReputationMutation({
    ...options,
    kind: "rep-give",
    errorPrefix: "wallet_rep_give",
  });
}

export async function revokeReputation(
  options: RevokeReputationOptions,
): Promise<ReputationMutationResult> {
  return submitReputationMutation({
    ...options,
    kind: "rep-revoke",
    errorPrefix: "wallet_rep_revoke",
  });
}
