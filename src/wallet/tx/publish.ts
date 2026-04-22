import type { WalletSecretProvider } from "../state/provider.js";
import type {
  PendingMutationRecord,
  PendingMutationStatus,
  WalletStateV1,
} from "../types.js";
import type { WalletRuntimePaths } from "../runtime.js";
import { isAlreadyAcceptedError, isBroadcastUnknownError } from "./common.js";
import { upsertPendingMutation } from "./journal.js";
import { persistWalletMutationState, unlockTemporaryBuilderLocks, updateMutationRecord } from "./state-persist.js";
import type { BuiltWalletMutationTransaction, WalletMutationRpcClient } from "./types.js";

export interface WalletMutationPublishResult {
  state: WalletStateV1;
  mutation: PendingMutationRecord;
  status: PendingMutationStatus;
}

export interface WalletMutationPublishRpcClient extends Pick<
  WalletMutationRpcClient,
  "lockUnspent"
> {
  getBlockchainInfo(): Promise<{ blocks: number }>;
  sendRawTransaction(hex: string): Promise<string>;
}

export async function publishWalletMutation<
  TRpc extends WalletMutationPublishRpcClient,
>(options: {
  rpc: TRpc;
  walletName: string;
  snapshotHeight: number | null;
  built: BuiltWalletMutationTransaction;
  mutation: PendingMutationRecord;
  state: WalletStateV1;
  provider: WalletSecretProvider;
  nowUnixMs: number;
  paths: WalletRuntimePaths;
  errorPrefix: string;
  afterAccepted?(options: {
    state: WalletStateV1;
    broadcastingMutation: PendingMutationRecord;
    built: BuiltWalletMutationTransaction;
    nowUnixMs: number;
  }): Promise<{
    state: WalletStateV1;
    mutation: PendingMutationRecord;
    status: PendingMutationStatus;
  }>;
}): Promise<WalletMutationPublishResult> {
  let nextState = options.state;
  const broadcastingMutation = updateMutationRecord(options.mutation, "broadcasting", options.nowUnixMs, {
    attemptedTxid: options.built.txid,
    attemptedWtxid: options.built.wtxid,
    temporaryBuilderLockedOutpoints: options.built.temporaryBuilderLockedOutpoints,
  });
  nextState = await persistWalletMutationState({
    state: upsertPendingMutation(nextState, broadcastingMutation),
    provider: options.provider,
    nowUnixMs: options.nowUnixMs,
    paths: options.paths,
  });

  if (
    options.snapshotHeight !== null
    && options.snapshotHeight !== (await options.rpc.getBlockchainInfo()).blocks
  ) {
    await unlockTemporaryBuilderLocks(
      options.rpc,
      options.walletName,
      options.built.temporaryBuilderLockedOutpoints,
    );
    throw new Error(`${options.errorPrefix}_tip_mismatch`);
  }

  try {
    await options.rpc.sendRawTransaction(options.built.rawHex);
  } catch (error) {
    if (!isAlreadyAcceptedError(error)) {
      if (isBroadcastUnknownError(error)) {
        const unknownMutation = updateMutationRecord(
          broadcastingMutation,
          "broadcast-unknown",
          options.nowUnixMs,
          {
            attemptedTxid: options.built.txid,
            attemptedWtxid: options.built.wtxid,
            temporaryBuilderLockedOutpoints: options.built.temporaryBuilderLockedOutpoints,
          },
        );
        nextState = await persistWalletMutationState({
          state: upsertPendingMutation(nextState, unknownMutation),
          provider: options.provider,
          nowUnixMs: options.nowUnixMs,
          paths: options.paths,
        });
        throw new Error(`${options.errorPrefix}_broadcast_unknown`);
      }

      await unlockTemporaryBuilderLocks(
        options.rpc,
        options.walletName,
        options.built.temporaryBuilderLockedOutpoints,
      );
      const canceledMutation = updateMutationRecord(
        broadcastingMutation,
        "canceled",
        options.nowUnixMs,
        {
          attemptedTxid: options.built.txid,
          attemptedWtxid: options.built.wtxid,
          temporaryBuilderLockedOutpoints: [],
        },
      );
      nextState = await persistWalletMutationState({
        state: upsertPendingMutation(nextState, canceledMutation),
        provider: options.provider,
        nowUnixMs: options.nowUnixMs,
        paths: options.paths,
      });
      throw error;
    }
  }

  await unlockTemporaryBuilderLocks(
    options.rpc,
    options.walletName,
    options.built.temporaryBuilderLockedOutpoints,
  );

  const accepted = options.afterAccepted === undefined
    ? {
      state: upsertPendingMutation(
        nextState,
        updateMutationRecord(broadcastingMutation, "live", options.nowUnixMs, {
          attemptedTxid: options.built.txid,
          attemptedWtxid: options.built.wtxid,
          temporaryBuilderLockedOutpoints: [],
        }),
      ),
      mutation: updateMutationRecord(broadcastingMutation, "live", options.nowUnixMs, {
        attemptedTxid: options.built.txid,
        attemptedWtxid: options.built.wtxid,
        temporaryBuilderLockedOutpoints: [],
      }),
      status: "live" as const,
    }
    : await options.afterAccepted({
      state: nextState,
      broadcastingMutation,
      built: options.built,
      nowUnixMs: options.nowUnixMs,
    });

  const persistedState = await persistWalletMutationState({
    state: accepted.state,
    provider: options.provider,
    nowUnixMs: options.nowUnixMs,
    paths: options.paths,
  });

  return {
    state: persistedState,
    mutation: accepted.mutation,
    status: accepted.status,
  };
}
