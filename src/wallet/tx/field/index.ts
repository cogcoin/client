import {
  mergeFixedWalletInputs,
  type BuiltWalletMutationTransaction,
} from "../common.js";
import {
  executeWalletMutationOperation,
  publishWalletMutation,
  resolveExistingWalletMutation,
} from "../executor.js";
import {
  getObservedFieldState,
  reconcilePendingFieldMutation,
} from "./draft.js";
import {
  createFieldIntentFingerprint,
  normalizeFieldDomainName,
  normalizeFieldNameInput,
  resolveAnchoredFieldOperation,
} from "./intent.js";
import {
  buildAnchoredFieldPlan,
  buildFieldTransaction,
} from "./plan.js";
import {
  createFieldResult,
  createFieldReuseResult,
} from "./result.js";
import type {
  ClearFieldOptions,
  CreateFieldOptions,
  FieldMutationResult,
  FieldMutationVariant,
  FieldRpcClient,
  SetFieldOptions,
  StandaloneFieldMutationOperation,
} from "./types.js";
import { createClearFieldVariant } from "./variants/clear.js";
import { createFieldCreateVariant } from "./variants/create.js";
import { createSetFieldVariant } from "./variants/set.js";

export type {
  ClearFieldOptions,
  CreateFieldOptions,
  FieldMutationResult,
  FieldResolvedEffect,
  FieldResolvedPath,
  FieldResolvedSenderSummary,
  FieldResolvedSummary,
  FieldResolvedValueSummary,
  FieldValueInputSource,
  SetFieldOptions,
} from "./types.js";

async function submitStandaloneFieldMutation(
  options: CreateFieldOptions | SetFieldOptions | ClearFieldOptions,
  variant: FieldMutationVariant,
): Promise<FieldMutationResult> {
  if (!options.prompter.isInteractive && options.assumeYes !== true) {
    throw new Error(`${variant.errorPrefix}_requires_tty`);
  }

  const execution = await executeWalletMutationOperation<
    StandaloneFieldMutationOperation,
    FieldRpcClient,
    { opReturnData: Uint8Array },
    BuiltWalletMutationTransaction,
    FieldMutationResult
  >({
    ...options,
    controlLockPurpose: variant.errorPrefix,
    preemptionReason: variant.errorPrefix,
    resolveOperation(readContext) {
      const normalizedDomainName = normalizeFieldDomainName(options.domainName);
      const normalizedFieldName = normalizeFieldNameInput(options.fieldName);
      const operation = resolveAnchoredFieldOperation(
        readContext as StandaloneFieldMutationOperation["readContext"],
        normalizedDomainName,
        variant.errorPrefix,
      );
      return {
        ...operation,
        normalizedDomainName,
        normalizedFieldName,
        existingObservedField: getObservedFieldState(readContext, normalizedDomainName, normalizedFieldName),
      };
    },
    createIntentFingerprint(operation) {
      return createFieldIntentFingerprint([
        variant.kind,
        operation.state.walletRootId,
        operation.normalizedDomainName,
        operation.normalizedFieldName,
      ]);
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
        repairRequiredErrorCode: `${variant.errorPrefix}_repair_required`,
        reconcileExistingMutation: (mutation) => reconcilePendingFieldMutation({
          state: operation.state,
          mutation,
          provider: execution.provider,
          nowUnixMs: execution.nowUnixMs,
          paths: execution.paths,
          rpc: execution.rpc,
          walletName: execution.walletName,
          context: execution.readContext,
        }),
        createReuseResult: ({ mutation, resolution, fees }) => createFieldReuseResult({
          kind: variant.kind,
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
    async createDraftMutation({ operation, existingMutation, execution }) {
      const prepared = await variant.createMutation({
        operation,
        existing: existingMutation,
        feeSelection: execution.feeSelection,
        nowUnixMs: execution.nowUnixMs,
      });
      return {
        mutation: prepared.mutation,
        prepared: {
          opReturnData: prepared.opReturnData,
        },
      };
    },
    async build({ operation, state, execution, replacementFixedInputs, prepared }) {
      const fieldPlan = buildAnchoredFieldPlan({
        state,
        allUtxos: await execution.rpc.listUnspent(execution.walletName, 1),
        sender: operation.sender,
        opReturnData: prepared.opReturnData,
        errorPrefix: variant.errorPrefix,
      });
      return buildFieldTransaction({
        rpc: execution.rpc,
        walletName: execution.walletName,
        state,
        plan: {
          ...fieldPlan,
          fixedInputs: mergeFixedWalletInputs(fieldPlan.fixedInputs, replacementFixedInputs),
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
      return createFieldResult({
        kind: variant.kind,
        operation,
        mutation,
        builtTxid: built?.txid ?? null,
        status: status as FieldMutationResult["status"],
        reusedExisting,
        fees,
      });
    },
  });

  return execution.result;
}

export async function createField(
  options: CreateFieldOptions,
): Promise<FieldMutationResult> {
  return submitStandaloneFieldMutation(options, createFieldCreateVariant(options));
}

export async function setField(
  options: SetFieldOptions,
): Promise<FieldMutationResult> {
  return submitStandaloneFieldMutation(options, await createSetFieldVariant(options));
}

export async function clearField(
  options: ClearFieldOptions,
): Promise<FieldMutationResult> {
  return submitStandaloneFieldMutation(options, createClearFieldVariant(options));
}
