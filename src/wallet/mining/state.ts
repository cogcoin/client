import type { MiningStateRecord } from "../types.js";

export type MiningFamilyStatus = MiningStateRecord["state"];
export type MiningPublishState = MiningStateRecord["currentPublishState"];

export function normalizeMiningFamilyStatus(raw: string | null | undefined): MiningFamilyStatus {
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

export function normalizeMiningStateRecord(state: MiningStateRecord): MiningStateRecord {
  return {
    ...state,
    state: normalizeMiningFamilyStatus(state.state),
    currentPublishState: normalizeMiningPublishState(state.currentPublishState),
  };
}

export function clearMiningFamilyState(state: MiningStateRecord): MiningStateRecord {
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
    liveMiningFamilyInMempool: false,
    currentPublishDecision: null,
    replacementCount: 0,
    sharedMiningConflictOutpoint: null,
  };
}

export function miningFamilyMayStillExist(state: MiningStateRecord): boolean {
  const normalized = normalizeMiningStateRecord(state);
  return normalized.currentTxid !== null
    && normalized.currentPublishState !== "none";
}

export function miningFamilyIsInMempool(state: MiningStateRecord): boolean {
  return normalizeMiningStateRecord(state).currentPublishState === "in-mempool";
}
