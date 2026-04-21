import type { MiningStateRecord, WalletStateV1 } from "../types.js";
import type { MiningCandidate } from "./engine-types.js";
import type { MiningFollowVisualizerState, MiningSentenceBoardEntry } from "./visualizer.js";
import { createEmptyMiningFollowVisualizerState } from "./visualizer.js";
import { MiningProviderRequestError } from "./sentences.js";
import { clearMiningGateCache } from "./competitiveness.js";
import {
  MINING_NETWORK_SETTLE_WINDOW_MS,
  MINING_PROVIDER_BACKOFF_BASE_MS,
  MINING_PROVIDER_BACKOFF_MAX_MS,
  MINING_TIP_SETTLE_WINDOW_MS,
} from "./constants.js";
import {
  miningPublishIsInMempool,
  normalizeMiningPublishState,
  normalizeMiningStateRecord,
} from "./state.js";

export interface MiningRuntimeLoopState {
  attemptedTipKey: string | null;
  currentTipKey: string | null;
  selectedCandidateTipKey: string | null;
  selectedCandidate: MiningCandidate | null;
  ui: MiningFollowVisualizerState;
  waitingNote: string | null;
  providerWaitState: "backoff" | "rate-limited" | "auth-error" | "not-found" | null;
  providerWaitLastError: string | null;
  providerWaitNextRetryAtUnixMs: number | null;
  providerTransientFailureCount: number;
  bitcoinRecoveryFirstFailureAtUnixMs: number | null;
  bitcoinRecoveryFirstUnreachableAtUnixMs: number | null;
  bitcoinRecoveryLastRestartAttemptAtUnixMs: number | null;
  bitcoinRecoveryServiceInstanceId: string | null;
  bitcoinRecoveryProcessId: number | null;
  reconnectSettledUntilUnixMs: number | null;
  tipSettledUntilUnixMs: number | null;
}

export function createMiningRuntimeLoopState(): MiningRuntimeLoopState {
  return {
    attemptedTipKey: null,
    currentTipKey: null,
    selectedCandidateTipKey: null,
    selectedCandidate: null,
    ui: createEmptyMiningFollowVisualizerState(),
    waitingNote: null,
    providerWaitState: null,
    providerWaitLastError: null,
    providerWaitNextRetryAtUnixMs: null,
    providerTransientFailureCount: 0,
    bitcoinRecoveryFirstFailureAtUnixMs: null,
    bitcoinRecoveryFirstUnreachableAtUnixMs: null,
    bitcoinRecoveryLastRestartAttemptAtUnixMs: null,
    bitcoinRecoveryServiceInstanceId: null,
    bitcoinRecoveryProcessId: null,
    reconnectSettledUntilUnixMs: null,
    tipSettledUntilUnixMs: null,
  };
}

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

function resolveMiningProviderBackoffDelayMs(consecutiveFailureCount: number): number {
  const exponent = Math.max(consecutiveFailureCount - 1, 0);
  return Math.min(MINING_PROVIDER_BACKOFF_BASE_MS * (2 ** exponent), MINING_PROVIDER_BACKOFF_MAX_MS);
}

export function clearMiningProviderWait(
  loopState: MiningRuntimeLoopState,
  resetTransientFailureCount = true,
): void {
  loopState.providerWaitState = null;
  loopState.providerWaitLastError = null;
  loopState.providerWaitNextRetryAtUnixMs = null;
  if (resetTransientFailureCount) {
    loopState.providerTransientFailureCount = 0;
  }
}

export function recordTransientMiningProviderWait(options: {
  loopState: MiningRuntimeLoopState;
  error: MiningProviderRequestError;
  nowUnixMs: number;
}): void {
  options.loopState.providerTransientFailureCount += 1;
  options.loopState.providerWaitState = options.error.providerState === "rate-limited"
    ? "rate-limited"
    : "backoff";
  options.loopState.providerWaitLastError = options.error.message;
  options.loopState.providerWaitNextRetryAtUnixMs = options.nowUnixMs
    + resolveMiningProviderBackoffDelayMs(options.loopState.providerTransientFailureCount);
}

export function recordTerminalMiningProviderWait(options: {
  loopState: MiningRuntimeLoopState;
  error: MiningProviderRequestError;
}): void {
  clearMiningProviderWait(options.loopState);
  if (options.error.providerState !== "auth-error" && options.error.providerState !== "not-found") {
    throw new Error("mining_provider_wait_state_invalid");
  }
  options.loopState.providerWaitState = options.error.providerState;
  options.loopState.providerWaitLastError = options.error.message;
}

export function isTransientMiningProviderError(error: MiningProviderRequestError): boolean {
  return error.providerState === "unavailable" || error.providerState === "rate-limited";
}

export function expireMiningSettleWindows(loopState: MiningRuntimeLoopState, nowUnixMs: number): void {
  if (
    loopState.reconnectSettledUntilUnixMs !== null
    && loopState.reconnectSettledUntilUnixMs <= nowUnixMs
  ) {
    loopState.reconnectSettledUntilUnixMs = null;
  }

  if (
    loopState.tipSettledUntilUnixMs !== null
    && loopState.tipSettledUntilUnixMs <= nowUnixMs
  ) {
    loopState.tipSettledUntilUnixMs = null;
  }
}

export function setMiningReconnectSettleWindow(loopState: MiningRuntimeLoopState, nowUnixMs: number): void {
  loopState.reconnectSettledUntilUnixMs = nowUnixMs + MINING_NETWORK_SETTLE_WINDOW_MS;
}

export function setMiningTipSettleWindow(loopState: MiningRuntimeLoopState, nowUnixMs: number): void {
  loopState.tipSettledUntilUnixMs = nowUnixMs + MINING_TIP_SETTLE_WINDOW_MS;
}

export function buildMiningSettleWindowStatusOverrides(
  loopState: MiningRuntimeLoopState,
  nowUnixMs: number,
): {
  reconnectSettledUntilUnixMs: number | null;
  tipSettledUntilUnixMs: number | null;
} {
  expireMiningSettleWindows(loopState, nowUnixMs);
  return {
    reconnectSettledUntilUnixMs: loopState.reconnectSettledUntilUnixMs,
    tipSettledUntilUnixMs: loopState.tipSettledUntilUnixMs,
  };
}

export function buildMiningTipKey(bestBlockHash: string | null, targetBlockHeight: number | null): string | null {
  if (bestBlockHash === null || targetBlockHeight === null) {
    return null;
  }

  return `${bestBlockHash}:${targetBlockHeight}`;
}

function cloneSettledBoardEntries(
  entries: readonly MiningSentenceBoardEntry[],
): MiningSentenceBoardEntry[] {
  return entries.map((entry) => ({
    ...entry,
    requiredWords: [...entry.requiredWords],
  }));
}

export function resetMiningUiForTip(
  loopState: MiningRuntimeLoopState,
  _targetBlockHeight: number | null,
): void {
  const preservedTxid = loopState.ui.latestTxid;
  const preservedFundingAddress = loopState.ui.fundingAddress;
  const preservedSettledBlockHeight = loopState.ui.settledBlockHeight;
  const preservedSettledBoardEntries = cloneSettledBoardEntries(loopState.ui.settledBoardEntries);

  loopState.ui = {
    ...createEmptyMiningFollowVisualizerState(),
    fundingAddress: preservedFundingAddress,
    latestTxid: preservedTxid,
    settledBlockHeight: preservedSettledBlockHeight,
    settledBoardEntries: preservedSettledBoardEntries,
  };
  loopState.selectedCandidateTipKey = null;
  loopState.selectedCandidate = null;
  loopState.waitingNote = null;
}

function resolveProvisionalBroadcastTxidForCandidate(options: {
  candidate: MiningCandidate;
  liveState: MiningStateRecord | null | undefined;
}): string | null {
  if (options.liveState === null || options.liveState === undefined) {
    return null;
  }

  const liveState = normalizeMiningStateRecord(options.liveState);
  if (
    liveState.currentTxid === null
    || liveState.currentPublishState !== "in-mempool"
    || liveState.livePublishInMempool !== true
  ) {
    return null;
  }

  if (
    liveState.currentDomain !== options.candidate.domainName
    || liveState.currentDomainId !== options.candidate.domainId
    || liveState.currentSentence !== options.candidate.sentence
    || liveState.currentBlockTargetHeight !== options.candidate.targetBlockHeight
    || liveState.currentReferencedBlockHashDisplay !== options.candidate.referencedBlockHashDisplay
  ) {
    return null;
  }

  return liveState.currentTxid;
}

export function setMiningUiCandidate(
  loopState: MiningRuntimeLoopState,
  candidate: MiningCandidate,
  liveState?: MiningStateRecord | null,
): void {
  loopState.ui.latestSentence = candidate.sentence;
  loopState.ui.provisionalRequiredWords = [...candidate.bip39Words];
  loopState.ui.provisionalEntry = {
    domainName: candidate.domainName,
    sentence: candidate.sentence,
  };
  loopState.ui.provisionalBroadcastTxid = resolveProvisionalBroadcastTxidForCandidate({
    candidate,
    liveState,
  });
}

export function getSelectedCandidateForTip(
  loopState: MiningRuntimeLoopState,
  tipKey: string | null,
): MiningCandidate | null {
  if (tipKey === null || loopState.selectedCandidateTipKey !== tipKey) {
    return null;
  }

  return loopState.selectedCandidate;
}

export function cacheSelectedCandidateForTip(
  loopState: MiningRuntimeLoopState,
  tipKey: string | null,
  candidate: MiningCandidate,
  liveState?: MiningStateRecord | null,
): void {
  loopState.selectedCandidateTipKey = tipKey;
  loopState.selectedCandidate = candidate;
  setMiningUiCandidate(loopState, candidate, liveState);
}

export function clearSelectedCandidate(loopState: MiningRuntimeLoopState): void {
  loopState.selectedCandidateTipKey = null;
  loopState.selectedCandidate = null;
}

export function clearMiningUiTransientCandidate(loopState: MiningRuntimeLoopState): void {
  loopState.ui.provisionalRequiredWords = [];
  loopState.ui.provisionalEntry = {
    domainName: null,
    sentence: null,
  };
  loopState.ui.provisionalBroadcastTxid = null;
  loopState.ui.latestSentence = null;
}

export function discardMiningLoopTransientWork(
  loopState: MiningRuntimeLoopState,
  walletRootId: string | null | undefined,
): void {
  clearMiningGateCache(walletRootId);
  clearSelectedCandidate(loopState);
  clearMiningUiTransientCandidate(loopState);
  loopState.waitingNote = null;
  clearMiningProviderWait(loopState);
}
