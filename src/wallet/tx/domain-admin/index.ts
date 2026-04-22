import { mergeFixedWalletInputs } from "../common.js";
import {
  executeWalletMutationOperation,
  publishWalletMutation,
  resolveExistingWalletMutation,
} from "../executor.js";
import {
  createDomainAdminDraftMutation,
  reconcilePendingAdminMutation,
} from "./draft.js";
import {
  createResolvedDomainAdminSenderSummary,
  createDomainAdminIntentFingerprint,
  normalizeDomainAdminDomainName,
  resolveAnchoredDomainOperation,
} from "./intent.js";
import {
  buildPlanForDomainAdminOperation,
  buildDomainAdminTransaction,
} from "./plan.js";
import {
  createDomainAdminResult,
  createDomainAdminReuseResult,
} from "./result.js";
import type {
  BuiltDomainAdminTransaction,
  ClearDomainDelegateOptions,
  ClearDomainEndpointOptions,
  ClearDomainMinerOptions,
  DomainAdminMutationResult,
  DomainAdminRpcClient,
  DomainAdminVariant,
  SetDomainCanonicalOptions,
  SetDomainDelegateOptions,
  SetDomainEndpointOptions,
  SetDomainMinerOptions,
  StandaloneDomainAdminOperation,
} from "./types.js";
import { createCanonicalVariant } from "./variants/canonical.js";
import {
  createClearDelegateVariant,
  createSetDelegateVariant,
} from "./variants/delegate.js";
import {
  createClearEndpointVariant,
  createSetEndpointVariant,
} from "./variants/endpoint.js";
import {
  createClearMinerVariant,
  createSetMinerVariant,
} from "./variants/miner.js";

export type {
  ClearDomainDelegateOptions,
  ClearDomainEndpointOptions,
  ClearDomainMinerOptions,
  DomainAdminMutationResult,
  DomainAdminResolvedEffect,
  DomainAdminResolvedSenderSummary,
  DomainAdminResolvedSummary,
  DomainAdminResolvedTargetSummary,
  SetDomainCanonicalOptions,
  SetDomainDelegateOptions,
  SetDomainEndpointOptions,
  SetDomainMinerOptions,
} from "./types.js";

async function submitDomainAdminMutation(
  options: (
    | SetDomainEndpointOptions
    | ClearDomainEndpointOptions
    | SetDomainDelegateOptions
    | ClearDomainDelegateOptions
    | SetDomainMinerOptions
    | ClearDomainMinerOptions
    | SetDomainCanonicalOptions
  ),
  variant: DomainAdminVariant,
): Promise<DomainAdminMutationResult> {
  const execution = await executeWalletMutationOperation<
    StandaloneDomainAdminOperation,
    DomainAdminRpcClient,
    null,
    BuiltDomainAdminTransaction,
    DomainAdminMutationResult
  >({
    ...options,
    controlLockPurpose: variant.errorPrefix,
    preemptionReason: variant.errorPrefix,
    async resolveOperation(readContext) {
      const normalizedDomainName = normalizeDomainAdminDomainName(options.domainName);
      const operation = resolveAnchoredDomainOperation(
        readContext as StandaloneDomainAdminOperation["readContext"],
        normalizedDomainName,
        variant.errorPrefix,
        { requireRoot: variant.requireRoot },
      );
      return {
        ...operation,
        normalizedDomainName,
        resolvedSender: createResolvedDomainAdminSenderSummary(operation.sender, operation.senderSelector),
        payload: await variant.createPayload(operation),
      };
    },
    createIntentFingerprint(operation) {
      return createDomainAdminIntentFingerprint([
        variant.kind,
        operation.state.walletRootId,
        ...variant.intentParts(operation),
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
        reconcileExistingMutation: (mutation) => reconcilePendingAdminMutation({
          state: operation.state,
          mutation,
          provider: execution.provider,
          nowUnixMs: execution.nowUnixMs,
          paths: execution.paths,
          rpc: execution.rpc,
          walletName: execution.walletName,
          context: execution.readContext,
        }),
        createReuseResult: ({ mutation, resolution, fees }) => createDomainAdminReuseResult({
          variant,
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
        mutation: createDomainAdminDraftMutation({
          kind: variant.kind,
          domainName: operation.normalizedDomainName,
          sender: operation.sender,
          intentFingerprintHex,
          nowUnixMs: execution.nowUnixMs,
          feeSelection: execution.feeSelection,
          recipientScriptPubKeyHex: operation.payload.recipientScriptPubKeyHex ?? null,
          endpointValueHex: operation.payload.endpointValueHex ?? null,
          existing: existingMutation,
        }),
        prepared: null,
      };
    },
    async build({ operation, state, execution, replacementFixedInputs }) {
      const adminPlan = buildPlanForDomainAdminOperation({
        state,
        allUtxos: await execution.rpc.listUnspent(execution.walletName, 1),
        sender: operation.sender,
        opReturnData: operation.payload.opReturnData,
        errorPrefix: variant.errorPrefix,
      });
      return buildDomainAdminTransaction({
        rpc: execution.rpc,
        walletName: execution.walletName,
        state,
        plan: {
          ...adminPlan,
          fixedInputs: mergeFixedWalletInputs(adminPlan.fixedInputs, replacementFixedInputs),
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
      return createDomainAdminResult({
        variant,
        operation,
        mutation,
        builtTxid: built?.txid ?? null,
        status: status as DomainAdminMutationResult["status"],
        reusedExisting,
        fees,
      });
    },
  });

  return execution.result;
}

export async function setDomainEndpoint(
  options: SetDomainEndpointOptions,
): Promise<DomainAdminMutationResult> {
  return submitDomainAdminMutation(options, await createSetEndpointVariant(options));
}

export async function clearDomainEndpoint(
  options: ClearDomainEndpointOptions,
): Promise<DomainAdminMutationResult> {
  return submitDomainAdminMutation(options, createClearEndpointVariant(options));
}

export async function setDomainDelegate(
  options: SetDomainDelegateOptions,
): Promise<DomainAdminMutationResult> {
  return submitDomainAdminMutation(options, createSetDelegateVariant(options));
}

export async function clearDomainDelegate(
  options: ClearDomainDelegateOptions,
): Promise<DomainAdminMutationResult> {
  return submitDomainAdminMutation(options, createClearDelegateVariant(options));
}

export async function setDomainMiner(
  options: SetDomainMinerOptions,
): Promise<DomainAdminMutationResult> {
  return submitDomainAdminMutation(options, createSetMinerVariant(options));
}

export async function clearDomainMiner(
  options: ClearDomainMinerOptions,
): Promise<DomainAdminMutationResult> {
  return submitDomainAdminMutation(options, createClearMinerVariant(options));
}

export async function setDomainCanonical(
  options: SetDomainCanonicalOptions,
): Promise<DomainAdminMutationResult> {
  return submitDomainAdminMutation(options, createCanonicalVariant(options));
}
