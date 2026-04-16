import type { MiningStateRecord } from "../types.js";

type LegacyMiningStateRecord = MiningStateRecord & {
  livePublishInMempool?: boolean | null;
  liveMiningFamilyInMempool?: boolean | null;
};

export type MiningLifecycleStatus = MiningStateRecord["state"];
export type MiningPublishState = MiningStateRecord["currentPublishState"];

export function normalizeMiningLifecycleStatus(raw: string | null | undefined): MiningLifecycleStatus {
  switch (raw) {
    case "live":
    case "paused":
    case "paused-stale":
    case "repair-required":
      return raw;
    case "waiting-bitcoin-network":
    case "waiting-indexer":
    case "waiting-provider":
    case "resuming":
      return "paused";
    case "idle":
    default:
      return "idle";
  }
}

export function normalizeMiningPublishState(raw: string | null | undefined): MiningPublishState {
  switch (raw) {
    case "broadcasting":
    case "broadcast-unknown":
    case "in-mempool":
      return raw;
    case "live":
      return "in-mempool";
    case "draft":
    case "idle":
    case "none":
    default:
      return "none";
  }
}

export function normalizeMiningStateRecord(state: LegacyMiningStateRecord): MiningStateRecord {
  return {
    ...state,
    state: normalizeMiningLifecycleStatus(state.state),
    currentPublishState: normalizeMiningPublishState(state.currentPublishState),
    livePublishInMempool: state.livePublishInMempool ?? state.liveMiningFamilyInMempool ?? false,
  };
}

export function clearMiningPublishState(state: MiningStateRecord): MiningStateRecord {
  return {
    ...normalizeMiningStateRecord(state),
    state: "idle",
    pauseReason: null,
    currentPublishState: "none",
    currentDomain: null,
    currentDomainId: null,
    currentDomainIndex: null,
    currentSenderScriptPubKeyHex: null,
    currentTxid: null,
    currentWtxid: null,
    currentFeeRateSatVb: null,
    currentAbsoluteFeeSats: null,
    currentScore: null,
    currentSentence: null,
    currentEncodedSentenceBytesHex: null,
    currentBip39WordIndices: null,
    currentBlendSeedHex: null,
    currentBlockTargetHeight: null,
    currentReferencedBlockHashDisplay: null,
    currentIntentFingerprintHex: null,
    livePublishInMempool: false,
    currentPublishDecision: null,
    replacementCount: 0,
    sharedMiningConflictOutpoint: null,
  };
}

export function miningPublishMayStillExist(state: MiningStateRecord): boolean {
  const normalized = normalizeMiningStateRecord(state);
  return normalized.currentTxid !== null
    && normalized.currentPublishState !== "none";
}

export function miningPublishIsInMempool(state: MiningStateRecord): boolean {
  return normalizeMiningStateRecord(state).currentPublishState === "in-mempool";
}
