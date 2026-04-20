import type { MiningStateRecord, WalletStateV1 } from "../types.js";
import type { MiningCandidate } from "./engine-types.js";
import {
  miningPublishIsInMempool,
  normalizeMiningPublishState,
  normalizeMiningStateRecord,
} from "./state.js";

export function cloneMiningState(state: MiningStateRecord): MiningStateRecord {
  const normalized = normalizeMiningStateRecord(state);
  return {
    ...normalized,
    currentBip39WordIndices: normalized.currentBip39WordIndices === null ? null : [...normalized.currentBip39WordIndices],
    sharedMiningConflictOutpoint: normalized.sharedMiningConflictOutpoint === null
      ? null
      : { ...normalized.sharedMiningConflictOutpoint },
  };
}

export function defaultMiningStatePatch(
  state: WalletStateV1,
  patch: Partial<MiningStateRecord>,
): WalletStateV1 {
  return {
    ...state,
    miningState: {
      ...cloneMiningState(state.miningState),
      ...patch,
      currentPublishState: normalizeMiningPublishState(
        patch.currentPublishState ?? state.miningState.currentPublishState,
      ),
    },
  };
}

export function hasBlockingMutation(state: WalletStateV1): boolean {
  return (state.pendingMutations ?? []).some((mutation) =>
    mutation.status === "draft"
    || mutation.status === "broadcasting"
    || mutation.status === "broadcast-unknown"
    || mutation.status === "live"
    || mutation.status === "repair-required"
  );
}

export function livePublishTargetsCandidateTip(options: {
  liveState: MiningStateRecord;
  candidate: MiningCandidate;
}): boolean {
  const liveState = normalizeMiningStateRecord(options.liveState);
  return liveState.currentTxid !== null
    && liveState.currentPublishState === "in-mempool"
    && liveState.livePublishInMempool === true
    && liveState.currentReferencedBlockHashDisplay === options.candidate.referencedBlockHashDisplay
    && liveState.currentBlockTargetHeight === options.candidate.targetBlockHeight;
}

export function miningCandidateIsCurrent(options: {
  state: MiningStateRecord;
  nodeBestHash: string | null;
  nodeBestHeight: number | null;
}): boolean {
  return options.state.currentReferencedBlockHashDisplay !== null
    && options.nodeBestHash !== null
    && options.state.currentReferencedBlockHashDisplay === options.nodeBestHash
    && options.state.currentBlockTargetHeight !== null
    && options.nodeBestHeight !== null
    && options.state.currentBlockTargetHeight === (options.nodeBestHeight + 1);
}

export function resolveSharedMiningConflictOutpoint(state: MiningStateRecord): { txid: string; vout: number } | null {
  const normalizedMiningState = normalizeMiningStateRecord(state);
  if (miningPublishIsInMempool(normalizedMiningState) && normalizedMiningState.sharedMiningConflictOutpoint !== null) {
    return { ...normalizedMiningState.sharedMiningConflictOutpoint };
  }

  return null;
}
