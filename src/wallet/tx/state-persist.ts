import type { RpcLockedUnspent } from "../../bitcoind/types.js";
import { saveWalletState } from "../state/storage.js";
import {
  createWalletSecretReference,
  type WalletSecretProvider,
} from "../state/provider.js";
import type {
  OutpointRecord,
  PendingMutationRecord,
  PendingMutationStatus,
  WalletStateV1,
} from "../types.js";
import type { WalletRuntimePaths } from "../runtime.js";
import { outpointKey } from "./primitives.js";
import type { WalletMutationFeeSelectionSource } from "./fee.js";
import type { WalletMutationRpcClient } from "./types.js";

export async function saveWalletStatePreservingUnlock(options: {
  state: WalletStateV1;
  provider: WalletSecretProvider;
  nowUnixMs?: number;
  paths: WalletRuntimePaths;
}): Promise<void> {
  const secretReference = createWalletSecretReference(options.state.walletRootId);
  await saveWalletState(
    {
      primaryPath: options.paths.walletStatePath,
      backupPath: options.paths.walletStateBackupPath,
    },
    options.state,
    {
      provider: options.provider,
      secretReference,
    },
  );
}

export function updateMutationRecord(
  mutation: PendingMutationRecord,
  status: PendingMutationStatus,
  nowUnixMs: number,
  options: {
    attemptedTxid?: string | null;
    attemptedWtxid?: string | null;
    temporaryBuilderLockedOutpoints?: OutpointRecord[];
    selectedFeeRateSatVb?: number | null;
    feeSelectionSource?: WalletMutationFeeSelectionSource | null;
  } = {},
): PendingMutationRecord {
  return {
    ...mutation,
    status,
    lastUpdatedAtUnixMs: nowUnixMs,
    attemptedTxid: options.attemptedTxid ?? mutation.attemptedTxid,
    attemptedWtxid: options.attemptedWtxid ?? mutation.attemptedWtxid,
    temporaryBuilderLockedOutpoints: options.temporaryBuilderLockedOutpoints ?? mutation.temporaryBuilderLockedOutpoints,
    selectedFeeRateSatVb: options.selectedFeeRateSatVb ?? mutation.selectedFeeRateSatVb,
    feeSelectionSource: options.feeSelectionSource ?? mutation.feeSelectionSource,
  };
}

export async function unlockTemporaryBuilderLocks(
  rpc: Pick<WalletMutationRpcClient, "lockUnspent">,
  walletName: string,
  outpoints: OutpointRecord[],
): Promise<void> {
  if (outpoints.length === 0 || rpc.lockUnspent === undefined) {
    return;
  }

  await rpc.lockUnspent(walletName, true, outpoints).catch(() => undefined);
}

export function diffTemporaryLockedOutpoints(
  before: RpcLockedUnspent[],
  after: RpcLockedUnspent[],
): OutpointRecord[] {
  const beforeKeys = new Set(before.map((entry) => outpointKey(entry)));
  return after
    .filter((entry) => !beforeKeys.has(outpointKey(entry)))
    .map((entry) => ({
      txid: entry.txid,
      vout: entry.vout,
    }));
}

export async function persistWalletMutationState(options: {
  state: WalletStateV1;
  provider: WalletSecretProvider;
  nowUnixMs: number;
  paths: WalletRuntimePaths;
}): Promise<WalletStateV1> {
  const nextState = {
    ...options.state,
    stateRevision: options.state.stateRevision + 1,
    lastWrittenAtUnixMs: options.nowUnixMs,
  };
  await saveWalletStatePreservingUnlock({
    state: nextState,
    provider: options.provider,
    nowUnixMs: options.nowUnixMs,
    paths: options.paths,
  });
  return nextState;
}
