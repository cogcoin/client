import { attachOrStartManagedBitcoindService } from "../../bitcoind/service.js";
import { createRpcClient } from "../../bitcoind/node.js";
import { acquireFileLock } from "../fs/lock.js";
import {
  openWalletReadContext,
  type WalletReadContext,
} from "../read/index.js";
import {
  resolveWalletRuntimePathsForTesting,
  type WalletRuntimePaths,
} from "../runtime.js";
import {
  createDefaultWalletSecretProvider,
  type WalletSecretProvider,
} from "../state/provider.js";
import type {
  PendingMutationRecord,
  PendingMutationStatus,
  WalletStateV1,
} from "../types.js";
import {
  createBuiltWalletMutationFeeSummary,
  resolveWalletMutationFeeSelection,
  type WalletMutationFeeSelection,
  type WalletMutationFeeSummary,
} from "./fee.js";
import { pauseMiningForWalletMutation } from "./mining-preemption.js";
import type { WalletMutationPublishResult } from "./publish.js";
import { resolvePendingMutationReuseDecision } from "./reconcile.js";
import { persistWalletMutationState, unlockTemporaryBuilderLocks } from "./state-persist.js";
import type {
  BuiltWalletMutationTransaction,
  FixedWalletInput,
  WalletMutationRpcClient,
} from "./types.js";
import {
  findPendingMutationByIntent,
  upsertPendingMutation,
} from "./journal.js";

export interface WalletMutationExecutionContext<
  TRpc extends WalletMutationRpcClient,
> {
  provider: WalletSecretProvider;
  nowUnixMs: number;
  paths: WalletRuntimePaths;
  readContext: WalletReadContext;
  rpc: TRpc;
  walletName: string;
  feeSelection: WalletMutationFeeSelection;
}

export interface WalletMutationExecutionResult<
  TResult,
  TBuilt extends BuiltWalletMutationTransaction = BuiltWalletMutationTransaction,
> {
  result: TResult;
  state: WalletStateV1;
  mutation: PendingMutationRecord | null;
  built: TBuilt | null;
  reusedExisting: boolean;
}

export interface WalletMutationReconcileResult {
  state: WalletStateV1;
  mutation: PendingMutationRecord;
  resolution: "confirmed" | "live" | "repair-required" | "not-seen" | "continue";
}

export interface WalletMutationRuntimeOptions<
  TRpc extends WalletMutationRpcClient,
> {
  dataDir: string;
  databasePath: string;
  provider?: WalletSecretProvider;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
  feeRateSatVb?: number | null;
  openReadContext?: typeof openWalletReadContext;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => TRpc;
}

export interface WalletMutationOperationSpec<
  TOperation extends { state: WalletStateV1 },
  TRpc extends WalletMutationRpcClient,
  TPrepared,
  TBuilt extends BuiltWalletMutationTransaction,
  TResult,
> {
  controlLockPurpose: string;
  preemptionReason: string;
  resolveOperation(readContext: WalletReadContext): Promise<TOperation> | TOperation;
  createIntentFingerprint(operation: TOperation): string;
  resolveExistingMutation?(options: {
    operation: TOperation;
    existingMutation: PendingMutationRecord | null;
    execution: WalletMutationExecutionContext<TRpc>;
  }): Promise<{
    state: WalletStateV1;
    replacementFixedInputs: FixedWalletInput[] | null;
    result: TResult | null;
  }>;
  confirm(options: {
    operation: TOperation;
    existingMutation: PendingMutationRecord | null;
    execution: WalletMutationExecutionContext<TRpc>;
  }): Promise<void>;
  createDraftMutation(options: {
    operation: TOperation;
    existingMutation: PendingMutationRecord | null;
    execution: WalletMutationExecutionContext<TRpc>;
    intentFingerprintHex: string;
  }): Promise<{
    mutation: PendingMutationRecord;
    prepared: TPrepared;
  }> | {
    mutation: PendingMutationRecord;
    prepared: TPrepared;
  };
  prepareBuildState?(options: {
    operation: TOperation;
    state: WalletStateV1;
    execution: WalletMutationExecutionContext<TRpc>;
    existingMutation: PendingMutationRecord | null;
    prepared: TPrepared;
  }): Promise<WalletStateV1>;
  build(options: {
    operation: TOperation;
    state: WalletStateV1;
    execution: WalletMutationExecutionContext<TRpc>;
    replacementFixedInputs: FixedWalletInput[] | null;
    existingMutation: PendingMutationRecord | null;
    prepared: TPrepared;
  }): Promise<TBuilt>;
  beforePublish?(options: {
    operation: TOperation;
    state: WalletStateV1;
    execution: WalletMutationExecutionContext<TRpc>;
    built: TBuilt;
    mutation: PendingMutationRecord;
    prepared: TPrepared;
  }): Promise<void>;
  publish(options: {
    operation: TOperation;
    state: WalletStateV1;
    execution: WalletMutationExecutionContext<TRpc>;
    built: TBuilt;
    mutation: PendingMutationRecord;
    prepared: TPrepared;
  }): Promise<WalletMutationPublishResult>;
  createResult(options: {
    operation: TOperation;
    state: WalletStateV1;
    mutation: PendingMutationRecord;
    execution: WalletMutationExecutionContext<TRpc>;
    built: TBuilt | null;
    status: PendingMutationStatus;
    reusedExisting: boolean;
    fees: WalletMutationFeeSummary;
    prepared: TPrepared | null;
  }): TResult;
}

export async function resolveExistingWalletMutation<
  TRpc extends Pick<
    WalletMutationRpcClient,
    "getMempoolEntry" | "getTransaction" | "getRawTransaction"
  >,
  TResult,
>(options: {
  existingMutation: PendingMutationRecord | null;
  execution: {
    rpc: TRpc;
    walletName: string;
    feeSelection: WalletMutationFeeSelection;
  };
  repairRequiredErrorCode: string;
  reconcileExistingMutation(existingMutation: PendingMutationRecord): Promise<WalletMutationReconcileResult>;
  createReuseResult(options: {
    mutation: PendingMutationRecord;
    resolution: "confirmed" | "live";
    fees: WalletMutationFeeSummary;
  }): TResult;
}): Promise<{
  state: WalletStateV1;
  replacementFixedInputs: FixedWalletInput[] | null;
  result: TResult | null;
}> {
  if (options.existingMutation === null) {
    throw new Error("wallet_mutation_existing_required");
  }

  const reconciled = await options.reconcileExistingMutation(options.existingMutation);
  if (reconciled.resolution === "repair-required") {
    throw new Error(options.repairRequiredErrorCode);
  }

  if (reconciled.resolution !== "confirmed" && reconciled.resolution !== "live") {
    return {
      state: reconciled.state,
      replacementFixedInputs: null,
      result: null,
    };
  }

  const reuse = await resolvePendingMutationReuseDecision({
    rpc: options.execution.rpc,
    walletName: options.execution.walletName,
    mutation: reconciled.mutation,
    nextFeeSelection: options.execution.feeSelection,
  });
  if (reuse.reuseExisting) {
    return {
      state: reconciled.state,
      replacementFixedInputs: null,
      result: options.createReuseResult({
        mutation: reconciled.mutation,
        resolution: reconciled.resolution,
        fees: reuse.fees,
      }),
    };
  }

  return {
    state: reconciled.state,
    replacementFixedInputs: reuse.replacementFixedInputs,
    result: null,
  };
}

export { persistWalletMutationState } from "./state-persist.js";
export { publishWalletMutation } from "./publish.js";
export type {
  WalletMutationPublishResult,
  WalletMutationPublishRpcClient,
} from "./publish.js";

export async function executeWalletMutationOperation<
  TOperation extends { state: WalletStateV1 },
  TRpc extends WalletMutationRpcClient,
  TPrepared,
  TBuilt extends BuiltWalletMutationTransaction,
  TResult,
>(
  options: WalletMutationRuntimeOptions<TRpc>
  & WalletMutationOperationSpec<TOperation, TRpc, TPrepared, TBuilt, TResult>,
): Promise<WalletMutationExecutionResult<TResult, TBuilt>> {
  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const controlLock = await acquireFileLock(paths.walletControlLockPath, {
    purpose: options.controlLockPurpose,
    walletRootId: null,
  });

  try {
    const miningPreemption = await pauseMiningForWalletMutation({
      paths,
      reason: options.preemptionReason,
    });
    const readContext = await (options.openReadContext ?? openWalletReadContext)({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      secretProvider: provider,
      walletControlLockHeld: true,
      paths,
    });

    try {
      const operation = await options.resolveOperation(readContext);
      const node = await (options.attachService ?? attachOrStartManagedBitcoindService)({
        dataDir: options.dataDir,
        chain: "main",
        startHeight: 0,
        walletRootId: operation.state.walletRootId,
      });
      const rpc = (options.rpcFactory ?? (createRpcClient as unknown as (
        config: Parameters<typeof createRpcClient>[0],
      ) => TRpc))(node.rpc);
      const execution: WalletMutationExecutionContext<TRpc> = {
        provider,
        nowUnixMs,
        paths,
        readContext,
        rpc,
        walletName: operation.state.managedCoreWallet.walletName,
        feeSelection: await resolveWalletMutationFeeSelection({
          rpc,
          feeRateSatVb: options.feeRateSatVb ?? null,
        }),
      };
      const intentFingerprintHex = options.createIntentFingerprint(operation);
      const existingMutation = findPendingMutationByIntent(operation.state, intentFingerprintHex);
      let workingState = operation.state;
      let replacementFixedInputs: FixedWalletInput[] | null = null;

      if (options.resolveExistingMutation !== undefined) {
        const existingResolution = await options.resolveExistingMutation({
          operation,
          existingMutation,
          execution,
        });
        workingState = existingResolution.state;
        replacementFixedInputs = existingResolution.replacementFixedInputs;
        if (existingResolution.result !== null && existingMutation !== null) {
          return {
            result: existingResolution.result,
            state: workingState,
            mutation: existingMutation,
            built: null,
            reusedExisting: true,
          };
        }
      }

      await options.confirm({
        operation,
        existingMutation,
        execution,
      });

      const draft = await options.createDraftMutation({
        operation,
        existingMutation,
        execution,
        intentFingerprintHex,
      });

      let nextState = upsertPendingMutation(
        workingState,
        draft.mutation,
      );
      nextState = await persistWalletMutationState({
        state: nextState,
        provider,
        nowUnixMs,
        paths,
      });

      if (options.prepareBuildState !== undefined) {
        nextState = await options.prepareBuildState({
          operation,
          state: nextState,
          execution,
          existingMutation,
          prepared: draft.prepared,
        });
      }

      const currentMutation = nextState.pendingMutations?.find(
        (mutation) => mutation.intentFingerprintHex === intentFingerprintHex,
      );
      if (currentMutation === undefined) {
        throw new Error("wallet_mutation_draft_missing");
      }

      const built = await options.build({
        operation,
        state: nextState,
        execution,
        replacementFixedInputs,
        existingMutation,
        prepared: draft.prepared,
      });

      if (options.beforePublish !== undefined) {
        try {
          await options.beforePublish({
            operation,
            state: nextState,
            execution,
            built,
            mutation: currentMutation,
            prepared: draft.prepared,
          });
        } catch (error) {
          await unlockTemporaryBuilderLocks(
            execution.rpc,
            execution.walletName,
            built.temporaryBuilderLockedOutpoints,
          );
          throw error;
        }
      }

      const published = await options.publish({
        operation,
        state: nextState,
        execution,
        built,
        mutation: currentMutation,
        prepared: draft.prepared,
      });

      const result = options.createResult({
        operation,
        state: published.state,
        mutation: published.mutation,
        execution,
        built,
        status: published.status,
        reusedExisting: false,
        fees: createBuiltWalletMutationFeeSummary({
          selection: execution.feeSelection,
          built,
        }),
        prepared: draft.prepared,
      });
      return {
        result,
        state: published.state,
        mutation: published.mutation,
        built,
        reusedExisting: false,
      };
    } finally {
      await readContext.close();
      await miningPreemption.release();
    }
  } finally {
    await controlLock.release();
  }
}
