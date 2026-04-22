import {
  buildWalletMutationTransactionWithReserveFallback,
  mergeFixedWalletInputs,
  updateMutationRecord,
  type BuiltWalletMutationTransaction,
} from "../common.js";
import {
  executeWalletMutationOperation,
  publishWalletMutation,
  resolveExistingWalletMutation,
} from "../executor.js";
import { upsertPendingMutation } from "../journal.js";
import { confirmDirectAnchor, resolveFoundingMessage } from "./confirm.js";
import {
  anchorConfirmedOnSnapshot,
  createDraftAnchorMutation,
  reconcilePendingAnchorMutation,
  upsertAnchoredDomainRecord,
} from "./draft.js";
import {
  buildDirectAnchorPlan,
  createAnchorOperationFingerprint,
  normalizeAnchorDomainName,
  resolveAnchorOperation,
  type AnchorDomainOptions,
  type AnchorMutationOperation,
  type WalletAnchorRpcClient,
} from "./intent.js";
import { validateDirectAnchorDraft } from "./plan.js";
import {
  createAnchorResult,
  createAnchorReuseResult,
  type AnchorDomainResult,
} from "./result.js";

export type { AnchorDomainOptions } from "./intent.js";
export type { AnchorDomainResult } from "./result.js";

export async function anchorDomain(options: AnchorDomainOptions): Promise<AnchorDomainResult> {
  if (!options.prompter.isInteractive) {
    throw new Error("wallet_anchor_requires_tty");
  }

  const normalizedDomainName = normalizeAnchorDomainName(options.domainName);
  const execution = await executeWalletMutationOperation<
    AnchorMutationOperation,
    WalletAnchorRpcClient,
    null,
    BuiltWalletMutationTransaction,
    AnchorDomainResult
  >({
    ...options,
    controlLockPurpose: "wallet-anchor",
    preemptionReason: "wallet-anchor",
    async resolveOperation(readContext) {
      const message = await resolveFoundingMessage({
        foundingMessageText: options.foundingMessageText,
        promptForFoundingMessageWhenMissing: options.promptForFoundingMessageWhenMissing,
        prompter: options.prompter,
      });
      return resolveAnchorOperation({
        readContext,
        normalizedDomainName,
        message,
      });
    },
    createIntentFingerprint(operation) {
      return createAnchorOperationFingerprint(operation);
    },
    async resolveExistingMutation({ operation, existingMutation, execution }) {
      if (existingMutation === null) {
        return { state: operation.state, replacementFixedInputs: null, result: null };
      }

      return resolveExistingWalletMutation({
        existingMutation,
        execution,
        repairRequiredErrorCode: "wallet_anchor_repair_required",
        reconcileExistingMutation: (mutation) => reconcilePendingAnchorMutation({
          operation,
          mutation,
          provider: execution.provider,
          nowUnixMs: execution.nowUnixMs,
          paths: execution.paths,
          rpc: execution.rpc,
          walletName: execution.walletName,
          context: execution.readContext,
        }),
        createReuseResult: ({ mutation, resolution, fees }) => createAnchorReuseResult({
          operation,
          mutation,
          resolution,
          fees,
        }),
      });
    },
    confirm({ operation }) {
      return confirmDirectAnchor(options.prompter, {
        domainName: operation.normalizedDomainName,
        walletAddress: operation.state.funding.address,
        foundingMessageText: operation.message.text,
      });
    },
    createDraftMutation({ operation, existingMutation, execution, intentFingerprintHex }) {
      return {
        mutation: createDraftAnchorMutation({
          state: operation.state,
          domainName: operation.normalizedDomainName,
          intentFingerprintHex,
          nowUnixMs: execution.nowUnixMs,
          feeSelection: execution.feeSelection,
          existing: existingMutation ?? null,
        }),
        prepared: null,
      };
    },
    async build({ operation, state, execution, replacementFixedInputs }) {
      const directAnchorPlan = buildDirectAnchorPlan({
        state,
        allUtxos: await execution.rpc.listUnspent(execution.walletName, 1),
        domainId: operation.chainDomain.domainId,
        foundingMessagePayloadHex: operation.message.payloadHex,
      });
      return buildWalletMutationTransactionWithReserveFallback({
        rpc: execution.rpc,
        walletName: execution.walletName,
        state,
        plan: {
          ...directAnchorPlan,
          fixedInputs: mergeFixedWalletInputs(directAnchorPlan.fixedInputs, replacementFixedInputs),
        },
        validateFundedDraft: validateDirectAnchorDraft,
        finalizeErrorCode: "wallet_anchor_finalize_failed",
        mempoolRejectPrefix: "wallet_anchor_mempool_rejected",
        feeRate: execution.feeSelection.feeRateSatVb,
      });
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
        errorPrefix: "wallet_anchor",
        async afterAccepted({ state: acceptedState, broadcastingMutation, built, nowUnixMs }) {
          const finalStatus = anchorConfirmedOnSnapshot({
            snapshot: execution.readContext.snapshot!,
            state: acceptedState,
            domainName: operation.normalizedDomainName,
          }) ? "confirmed" : "live";
          const finalMutation = updateMutationRecord(broadcastingMutation, finalStatus, nowUnixMs, {
            attemptedTxid: built.txid,
            attemptedWtxid: built.wtxid,
            temporaryBuilderLockedOutpoints: [],
          });
          return {
            state: upsertAnchoredDomainRecord({
              state: upsertPendingMutation(acceptedState, finalMutation),
              domainName: operation.normalizedDomainName,
              domainId: operation.chainDomain.domainId,
              foundingMessageText: operation.message.text,
            }),
            mutation: finalMutation,
            status: finalStatus,
          };
        },
      });
    },
    createResult({ operation, mutation, built, status, reusedExisting, fees }) {
      return createAnchorResult({
        operation,
        mutation,
        builtTxid: built?.txid ?? null,
        status: status as AnchorDomainResult["status"],
        reusedExisting,
        fees,
      });
    },
  });

  return execution.result;
}
