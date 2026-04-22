import { mergeFixedWalletInputs } from "../common.js";
import {
  executeWalletMutationOperation,
  publishWalletMutation,
  resolveExistingWalletMutation,
} from "../executor.js";
import { reconcilePendingCogMutation } from "./draft.js";
import {
  buildPlanForCogOperation,
  buildCogTransaction,
} from "./plan.js";
import type {
  BuiltCogMutationTransaction,
  ClaimCogLockOptions,
  ClaimCogMutationOperation,
  CogMutationResult,
  CogMutationVariant,
  LockCogMutationOperation,
  LockCogToDomainOptions,
  ReclaimCogLockOptions,
  SendCogOperation,
  SendCogOptions,
  WalletCogRpcClient,
} from "./types.js";
import { createClaimCogVariant, createReclaimCogVariant } from "./variants/claim.js";
import { createLockCogVariant } from "./variants/lock.js";
import { createSendCogVariant } from "./variants/send.js";

export type {
  ClaimCogLockOptions,
  CogMutationResult,
  CogResolvedClaimPath,
  CogResolvedSenderSummary,
  CogResolvedSummary,
  LockCogToDomainOptions,
  ReclaimCogLockOptions,
  SendCogOptions,
} from "./types.js";

async function executeCogMutation<TOperation extends SendCogOperation | LockCogMutationOperation | ClaimCogMutationOperation>(
  options: SendCogOptions | LockCogToDomainOptions | ClaimCogLockOptions | ReclaimCogLockOptions,
  variant: CogMutationVariant<TOperation>,
): Promise<CogMutationResult> {
  const execution = await executeWalletMutationOperation<
    TOperation,
    WalletCogRpcClient,
    null,
    BuiltCogMutationTransaction,
    CogMutationResult
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
        reconcileExistingMutation: (mutation) => reconcilePendingCogMutation({
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
    async build({ operation, state, execution, replacementFixedInputs }) {
      const plan = buildPlanForCogOperation({
        state,
        allUtxos: await execution.rpc.listUnspent(execution.walletName, 1),
        sender: operation.sender,
        opReturnData: variant.createOpReturnData(operation),
        errorPrefix: variant.errorPrefix,
      });
      return buildCogTransaction({
        rpc: execution.rpc,
        walletName: execution.walletName,
        state,
        plan: {
          ...plan,
          fixedInputs: mergeFixedWalletInputs(plan.fixedInputs, replacementFixedInputs),
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
        errorPrefix: variant.errorPrefix,
      });
    },
    createResult({ operation, mutation, built, status, reusedExisting, fees }) {
      return variant.createResult({
        operation,
        mutation,
        builtTxid: built?.txid ?? null,
        status: status as CogMutationResult["status"],
        reusedExisting,
        fees,
      });
    },
  });

  return execution.result;
}

export async function sendCog(options: SendCogOptions): Promise<CogMutationResult> {
  return executeCogMutation(options, createSendCogVariant(options));
}

export async function lockCogToDomain(options: LockCogToDomainOptions): Promise<CogMutationResult> {
  return executeCogMutation(options, createLockCogVariant(options));
}

export async function claimCogLock(options: ClaimCogLockOptions): Promise<CogMutationResult> {
  return executeCogMutation(options, createClaimCogVariant(options));
}

export async function reclaimCogLock(options: ReclaimCogLockOptions): Promise<CogMutationResult> {
  return executeCogMutation(options, createReclaimCogVariant(options));
}
