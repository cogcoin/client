import { performance } from "node:perf_hooks";

import { assaySentences } from "@cogcoin/scoring";
import { acquireFileLock } from "../fs/lock.js";
import { openWalletReadContext, type WalletReadContext } from "../read/index.js";
import type { WalletRuntimePaths } from "../runtime.js";
import type { WalletSecretProvider } from "../state/provider.js";
import { createMiningEventRecord } from "./events.js";
import { resolveReadContextCoreTip } from "./engine-types.js";
import { resolveCorePublishStateNote } from "./publishability.js";
import type {
  CompetitivenessDecision,
  MiningCandidate,
  MiningCooperativeYield,
  MiningCycleGateSnapshot,
  MiningCycleState,
  MiningRpcClient,
  ReadyMiningReadContext,
} from "./engine-types.js";
import type { MiningEventRecord, MiningRuntimeStatusV1 } from "./types.js";
import {
  ensureIndexerTruthIsCurrent,
  generateCandidatesForDomains,
  getIndexerTruthKey,
  resolveEligibleAnchoredRoots,
  chooseBestLocalCandidate,
} from "./candidate.js";
import {
  clearMiningGateCache,
  isMiningScoringAttemptStaleError,
  MiningScoringAttemptStaleError,
  runCompetitivenessGate,
  type MiningGateEvaluationStage,
  type MiningScoringFreshnessCheckpoint,
} from "./competitiveness.js";
import {
  createInsufficientFundsMiningPublishErrorMessage,
  createInsufficientFundsMiningPublishWaitingNote,
  publishCandidate,
  probeMiningFundingAvailability,
} from "./publish.js";
import {
  cacheSelectedCandidateForTip,
  clearMiningProviderWait,
  clearSelectedCandidate,
  getSelectedCandidateForTip,
  isTransientMiningProviderError,
  recordTerminalMiningProviderWait,
  recordTransientMiningProviderWait,
  setMiningUiCandidate,
  type MiningRuntimeLoopState,
} from "./engine-state.js";
import { MiningProviderRequestError } from "./sentences.js";
import { isInsufficientFundsError } from "../tx/common.js";
import { attachOrStartManagedBitcoindService } from "../../bitcoind/service.js";
import { createRpcClient } from "../../bitcoind/node.js";
import {
  buildPrePublishStatusOverrides,
  resolveWaitingProviderNote,
  type MiningRuntimeStatusOverrides,
} from "./projection.js";
import type { MiningMempoolIndexGateOptions } from "./mempool-index.js";
import { isMiningStopRequestedError } from "./stop.js";

interface RuntimeMiningCycleState extends MiningCycleState {
  generatedCandidates: MiningCandidate[] | null;
  gateCheckedAtUnixMs: number | null;
}

export interface MiningPhaseMachineResult {
  restartImmediately: boolean;
  restartNote?: string | null;
}

function continueMiningNormally(): MiningPhaseMachineResult {
  return {
    restartImmediately: false,
  };
}

function restartMiningImmediately(note?: string | null): MiningPhaseMachineResult {
  return {
    restartImmediately: true,
    restartNote: note,
  };
}

function createInitialState(options: {
  targetBlockHeight: number | null;
  tipKey: string | null;
  loopState: MiningRuntimeLoopState;
}): RuntimeMiningCycleState {
  return {
    phase: "idle",
    targetBlockHeight: options.targetBlockHeight,
    tipKey: options.tipKey,
    selectedCandidate: getSelectedCandidateForTip(options.loopState, options.tipKey),
    generatedCandidates: null,
    gateCheckedAtUnixMs: null,
    gateSnapshot: {
      higherRankedCompetitorDomainCount: 0,
      dedupedCompetitorDomainCount: 0,
      mempoolSequenceCacheStatus: null,
      lastMempoolSequence: null,
    },
  };
}

function formatGateReasonSuffix(reason: CompetitivenessDecision["indeterminateReason"]): string {
  return reason === null ? "" : ` (${reason})`;
}

function formatGateDiagnosticsSummary(
  diagnostics: CompetitivenessDecision["diagnostics"] | null,
): string {
  if (diagnostics === null) {
    return "";
  }

  const parts = [
    diagnostics.visibleMempoolTxCount === null ? null : `visible=${diagnostics.visibleMempoolTxCount}`,
    diagnostics.indexedContextCount === null ? null : `indexed=${diagnostics.indexedContextCount}`,
    diagnostics.negativeTxCount === null ? null : `negative=${diagnostics.negativeTxCount}`,
    diagnostics.unknownTxCount === null ? null : `unknown=${diagnostics.unknownTxCount}`,
    diagnostics.hydratedTxCount === null ? null : `hydrated=${diagnostics.hydratedTxCount}`,
    diagnostics.mempoolEntryCount === null ? null : `entries=${diagnostics.mempoolEntryCount}`,
    diagnostics.missingEntryCount === null ? null : `missingEntries=${diagnostics.missingEntryCount}`,
    diagnostics.candidateRank === null ? null : `candidateRank=${diagnostics.candidateRank}`,
    diagnostics.higherRankedCompetitorDomainCount === null ? null : `higherDomains=${diagnostics.higherRankedCompetitorDomainCount}`,
    diagnostics.dedupedCompetitorDomainCount === null ? null : `competitorDomains=${diagnostics.dedupedCompetitorDomainCount}`,
    diagnostics.cacheStatus === null ? null : `cache=${diagnostics.cacheStatus}`,
    diagnostics.mempoolSequence === null ? null : `sequence=${diagnostics.mempoolSequence}`,
  ].filter((part): part is string => part !== null);

  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

function buildPublishGateStatusOverrides(
  state: RuntimeMiningCycleState,
): MiningRuntimeStatusOverrides {
  if (state.gateCheckedAtUnixMs === null) {
    return {
      sameDomainCompetitorSuppressed: null,
      higherRankedCompetitorDomainCount: null,
      dedupedCompetitorDomainCount: null,
      competitivenessGateIndeterminate: null,
      competitivenessGateReason: null,
      competitivenessGateDiagnostics: null,
      mempoolSequenceCacheStatus: null,
      lastMempoolSequence: null,
      lastCompetitivenessGateAtUnixMs: null,
    };
  }

  return {
    sameDomainCompetitorSuppressed: false,
    higherRankedCompetitorDomainCount: state.gateSnapshot.higherRankedCompetitorDomainCount,
    dedupedCompetitorDomainCount: state.gateSnapshot.dedupedCompetitorDomainCount,
    competitivenessGateIndeterminate: false,
    competitivenessGateReason: null,
    competitivenessGateDiagnostics: null,
    mempoolSequenceCacheStatus: state.gateSnapshot.mempoolSequenceCacheStatus,
    lastMempoolSequence: state.gateSnapshot.lastMempoolSequence,
    lastCompetitivenessGateAtUnixMs: state.gateCheckedAtUnixMs,
  };
}

async function appendTimingEvent(
  appendEvent: (event: MiningEventRecord) => Promise<void>,
  kind: string,
  message: string,
  options: Partial<MiningEventRecord>,
): Promise<void> {
  try {
    await appendEvent(createMiningEventRecord(kind, message, options));
  } catch {
    // Timing telemetry must not alter the mining decision path.
  }
}

function formatMiningAttemptBlock(targetBlockHeight: number | null): string {
  return targetBlockHeight === null ? "the selected block" : `block #${targetBlockHeight}`;
}

function buildMiningAttemptStatusOverrides(
  readContext: ReadyMiningReadContext,
  candidate: Pick<MiningCandidate, "targetBlockHeight" | "referencedBlockHashDisplay" | "provenance"> | null,
  fallbackTargetBlockHeight: number | null,
): Pick<MiningRuntimeStatusOverrides, "attemptTargetBlockHeight" | "attemptReferencedBlockHashDisplay" | "attemptIndexerSnapshotSeq"> {
  const coreTip = resolveReadContextCoreTip(readContext);
  return {
    attemptTargetBlockHeight: candidate?.targetBlockHeight ?? fallbackTargetBlockHeight,
    attemptReferencedBlockHashDisplay: candidate?.referencedBlockHashDisplay ?? coreTip.hash,
    attemptIndexerSnapshotSeq: candidate?.provenance?.indexerSnapshotSeq ?? readContext.indexer.snapshotSeq ?? null,
  };
}

export async function runMiningPhaseMachine(options: {
  dataDir: string;
  databasePath: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  runMode: "foreground" | "background";
  backgroundWorkerRunId: string | null;
  readContext: ReadyMiningReadContext;
  rpc: MiningRpcClient;
  targetBlockHeight: number | null;
  tipKey: string | null;
  corePublishState: MiningRuntimeStatusV1["corePublishState"];
  loopState: MiningRuntimeLoopState;
  openReadContext: typeof openWalletReadContext;
  attachService: typeof attachOrStartManagedBitcoindService;
  rpcFactory: (config: Parameters<typeof createRpcClient>[0]) => MiningRpcClient;
  fetchImpl?: typeof fetch;
  stopSignal?: AbortSignal;
  generateCandidatesForDomainsImpl?: typeof generateCandidatesForDomains;
  runCompetitivenessGateImpl?: typeof runCompetitivenessGate;
  assaySentencesImpl?: typeof assaySentences;
  cooperativeYieldImpl?: MiningCooperativeYield;
  cooperativeYieldEvery?: number;
  mempoolCheck: boolean;
  mempoolIndex?: MiningMempoolIndexGateOptions;
  nowImpl?: () => number;
  saveCycleStatus: (
    readContext: WalletReadContext,
    overrides: MiningRuntimeStatusOverrides,
  ) => Promise<MiningRuntimeStatusV1>;
  saveLiveCycleStatus?: (
    overrides: MiningRuntimeStatusOverrides,
  ) => Promise<MiningRuntimeStatusV1 | null>;
  appendEvent: (event: MiningEventRecord) => Promise<void>;
  throwIfStopping?: () => void;
  throwIfSuspendDetected?: () => void;
}): Promise<MiningPhaseMachineResult> {
  const now = options.nowImpl ?? Date.now;
  const generateCandidatesImpl = options.generateCandidatesForDomainsImpl ?? generateCandidatesForDomains;
  const runGateImpl = options.runCompetitivenessGateImpl ?? runCompetitivenessGate;
  const state = createInitialState({
    targetBlockHeight: options.targetBlockHeight,
    tipKey: options.tipKey,
    loopState: options.loopState,
  });

  const indexerTruthKey = getIndexerTruthKey(options.readContext);
  const walletRootId = options.readContext.localState.walletRootId;
  const clearTransientRestartWork = () => {
    clearMiningProviderWait(options.loopState);
    clearSelectedCandidate(options.loopState);
    options.loopState.waitingNote = null;
  };
  const ensureCurrentIndexerTruthOrStopCycle = async (): Promise<MiningPhaseMachineResult | null> => {
    try {
      await ensureIndexerTruthIsCurrent({
        dataDir: options.readContext.dataDir,
        truthKey: indexerTruthKey,
      });
      return null;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "mining_generation_stale_indexer_truth") {
        throw error;
      }

      clearTransientRestartWork();
      clearMiningGateCache(walletRootId);
      await options.appendEvent(createMiningEventRecord(
        "generation-restarted-indexer-truth",
        "Detected updated coherent indexer truth during mining; restarting immediately.",
        {
          level: "warn",
          targetBlockHeight: state.targetBlockHeight,
          referencedBlockHashDisplay: resolveReadContextCoreTip(options.readContext).hash,
          runId: options.backgroundWorkerRunId,
        },
      ));
      return restartMiningImmediately();
    }
  };
  const saveAttemptStatus = async (
    candidate: Pick<MiningCandidate, "targetBlockHeight" | "referencedBlockHashDisplay" | "provenance"> | null,
    overrides: MiningRuntimeStatusOverrides,
  ): Promise<void> => {
    const attemptOverrides = buildMiningAttemptStatusOverrides(options.readContext, candidate, state.targetBlockHeight);
    if (options.saveLiveCycleStatus !== undefined) {
      const saved = await options.saveLiveCycleStatus({
        ...attemptOverrides,
        ...overrides,
      });
      if (saved !== null) {
        return;
      }
    }

    await options.saveCycleStatus(options.readContext, {
      ...attemptOverrides,
      ...overrides,
    });
  };
  const createScoringFreshnessGuard = (candidate: MiningCandidate) => {
    let lastCheckedAtMs = Number.NEGATIVE_INFINITY;
    return async (
      checkpoint: MiningScoringFreshnessCheckpoint,
      guardOptions: { force?: boolean } = {},
    ): Promise<void> => {
      const nowMs = performance.now();
      if (guardOptions.force !== true && (nowMs - lastCheckedAtMs) < 1_000) {
        return;
      }

      lastCheckedAtMs = nowMs;
      const coreTip = await options.rpc.getBlockchainInfo();
      if (
        coreTip.blocks + 1 !== candidate.targetBlockHeight
        || coreTip.bestblockhash !== candidate.referencedBlockHashDisplay
      ) {
        throw new MiningScoringAttemptStaleError({
          candidateTargetBlockHeight: candidate.targetBlockHeight,
          candidateReferencedBlockHashDisplay: candidate.referencedBlockHashDisplay,
          observedBestHeight: coreTip.blocks,
          observedBestHash: coreTip.bestblockhash,
          checkpoint,
        });
      }
    };
  };
  const throwIfInterrupted = () => {
    options.throwIfSuspendDetected?.();
    options.throwIfStopping?.();
  };

  while (true) {
    throwIfInterrupted();
    switch (state.phase) {
      case "idle": {
        if (options.corePublishState !== "healthy") {
          clearMiningProviderWait(options.loopState);
          await options.saveCycleStatus(options.readContext, {
            runMode: options.runMode,
            currentPhase: "waiting-bitcoin-network",
            corePublishState: options.corePublishState,
            readinessBlocker: "bitcoin-core",
            note: resolveCorePublishStateNote(options.corePublishState)
              ?? "Mining is waiting for the local Bitcoin node to become publishable.",
          });
          return continueMiningNormally();
        }

        if (options.readContext.indexer.health !== "synced" || options.readContext.nodeHealth !== "synced") {
          clearMiningProviderWait(options.loopState);
          await options.saveCycleStatus(options.readContext, {
            runMode: options.runMode,
            currentPhase: options.readContext.indexer.health !== "synced"
              ? "waiting-indexer"
              : "waiting-bitcoin-network",
            readinessBlocker: options.readContext.indexer.health !== "synced"
              ? "indexer-daemon"
              : "bitcoin-core",
            note: options.readContext.indexer.health !== "synced"
              ? "Mining is waiting for managed indexer readiness."
              : "Mining is waiting for the local Bitcoin node to become publishable.",
          });
          return continueMiningNormally();
        }

        if (state.targetBlockHeight === null) {
          clearMiningProviderWait(options.loopState);
          await options.saveCycleStatus(options.readContext, {
            runMode: options.runMode,
            currentPhase: "waiting-bitcoin-network",
            readinessBlocker: "bitcoin-core",
            note: resolveCorePublishStateNote(options.corePublishState)
              ?? "Mining is waiting for the local Bitcoin node to become publishable.",
          });
          return continueMiningNormally();
        }

        const eligibleDomains = resolveEligibleAnchoredRoots(options.readContext);
        if (state.selectedCandidate === null) {
          if (eligibleDomains.length === 0) {
            clearMiningProviderWait(options.loopState);
            await options.saveCycleStatus(options.readContext, {
              runMode: options.runMode,
              currentPhase: "idle",
              currentPublishDecision: null,
              competitivenessGateReason: null,
              competitivenessGateDiagnostics: null,
              lastError: null,
              note: "No locally controlled anchored root domains are currently eligible to mine.",
            });
            return continueMiningNormally();
          }

          try {
            await probeMiningFundingAvailability({
              rpc: options.rpc,
              walletName: options.readContext.localState.state.managedCoreWallet.walletName,
              state: options.readContext.localState.state,
              domains: eligibleDomains,
              referencedBlockHashDisplay: resolveReadContextCoreTip(options.readContext).hash ?? "00".repeat(32),
              targetBlockHeight: state.targetBlockHeight,
            });
          } catch (error) {
            if (isInsufficientFundsError(error)) {
              clearMiningProviderWait(options.loopState);
              clearSelectedCandidate(options.loopState);
              options.loopState.waitingNote = createInsufficientFundsMiningPublishWaitingNote();
              await options.saveCycleStatus(options.readContext, {
                runMode: options.runMode,
                currentPhase: "waiting",
                currentPublishDecision: "publish-paused-insufficient-funds",
                lastError: createInsufficientFundsMiningPublishErrorMessage(),
                note: createInsufficientFundsMiningPublishWaitingNote(),
              });
              return continueMiningNormally();
            }

            throw error;
          }
        }

        if (
          options.loopState.providerWaitState !== null
          && options.loopState.providerWaitLastError !== null
        ) {
          if (
            options.loopState.providerWaitNextRetryAtUnixMs !== null
            && now() < options.loopState.providerWaitNextRetryAtUnixMs
          ) {
            await options.saveCycleStatus(options.readContext, {
              runMode: options.runMode,
              currentPhase: "waiting-provider",
              currentPublishDecision: null,
              providerState: options.loopState.providerWaitState,
              lastError: options.loopState.providerWaitLastError,
              note: resolveWaitingProviderNote(options.loopState.providerWaitState),
            });
            return continueMiningNormally();
          }

          if (
            options.loopState.providerWaitNextRetryAtUnixMs === null
            && state.tipKey !== null
            && options.loopState.attemptedTipKey === state.tipKey
          ) {
            await options.saveCycleStatus(options.readContext, {
              runMode: options.runMode,
              currentPhase: "waiting-provider",
              currentPublishDecision: null,
              providerState: options.loopState.providerWaitState,
              lastError: options.loopState.providerWaitLastError,
              note: resolveWaitingProviderNote(options.loopState.providerWaitState),
            });
            return continueMiningNormally();
          }

          clearMiningProviderWait(
            options.loopState,
            options.loopState.providerWaitNextRetryAtUnixMs === null,
          );
        }

        if (state.tipKey !== null && options.loopState.attemptedTipKey === state.tipKey) {
          await options.saveCycleStatus(options.readContext, {
            runMode: options.runMode,
            currentPhase: "waiting",
            lastError: null,
            note: options.loopState.waitingNote
              ?? "Mining already attempted the current Bitcoin tip and is waiting for Bitcoin Core to report the next block.",
          });
          return continueMiningNormally();
        }

        state.phase = state.selectedCandidate === null ? "generating" : "publishing";
        continue;
      }
      case "generating": {
        await options.saveCycleStatus(options.readContext, {
          runMode: options.runMode,
          currentPhase: "generating",
          currentPublishDecision: null,
          competitivenessGateReason: null,
          competitivenessGateDiagnostics: null,
          lastError: null,
          note: "Generating mining sentences for eligible root domains.",
        });

        await options.appendEvent(createMiningEventRecord(
          "sentence-generation-start",
          "Started mining sentence generation.",
          {
            targetBlockHeight: state.targetBlockHeight,
            referencedBlockHashDisplay: resolveReadContextCoreTip(options.readContext).hash,
            runId: options.backgroundWorkerRunId,
          },
        ));

        try {
          state.generatedCandidates = await generateCandidatesImpl({
            rpc: options.rpc,
            readContext: options.readContext,
            domains: resolveEligibleAnchoredRoots(options.readContext),
            provider: options.provider,
            paths: options.paths,
            indexerTruthKey,
            runId: options.backgroundWorkerRunId,
            fetchImpl: options.fetchImpl,
            signal: options.stopSignal,
          });
          throwIfInterrupted();
        } catch (error) {
          if (
            isMiningStopRequestedError(error)
            || (error instanceof Error && error.message === "mining_runtime_resumed")
          ) {
            throw error;
          }

          if (error instanceof MiningProviderRequestError) {
            if (isTransientMiningProviderError(error)) {
              recordTransientMiningProviderWait({
                loopState: options.loopState,
                error,
                nowUnixMs: now(),
              });
            } else {
              recordTerminalMiningProviderWait({
                loopState: options.loopState,
                error,
              });
            }

            if (!isTransientMiningProviderError(error) && state.tipKey !== null) {
              options.loopState.attemptedTipKey = state.tipKey;
            }

            await options.saveCycleStatus(options.readContext, {
              runMode: options.runMode,
              currentPhase: "waiting-provider",
              currentPublishDecision: null,
              providerState: options.loopState.providerWaitState ?? error.providerState,
              lastError: error.message,
              note: resolveWaitingProviderNote(options.loopState.providerWaitState ?? error.providerState),
            });
            await options.appendEvent(createMiningEventRecord(
              "publish-paused-provider",
              error.message,
              {
                level: "warn",
                targetBlockHeight: state.targetBlockHeight,
                referencedBlockHashDisplay: resolveReadContextCoreTip(options.readContext).hash,
                runId: options.backgroundWorkerRunId,
              },
            ));
            return continueMiningNormally();
          }

          if (error instanceof Error && error.message === "mining_generation_stale_tip") {
            clearTransientRestartWork();
            await options.appendEvent(createMiningEventRecord(
              "generation-restarted-new-tip",
              "Detected a new best tip during sentence generation; restarting on the next tick.",
              {
                level: "warn",
                targetBlockHeight: state.targetBlockHeight,
                referencedBlockHashDisplay: resolveReadContextCoreTip(options.readContext).hash,
                runId: options.backgroundWorkerRunId,
              },
            ));
            return restartMiningImmediately();
          }

          if (error instanceof Error && error.message === "mining_generation_stale_indexer_truth") {
            clearTransientRestartWork();
            clearMiningGateCache(walletRootId);
            await options.appendEvent(createMiningEventRecord(
              "generation-restarted-indexer-truth",
              "Detected updated coherent indexer truth during mining; restarting on the next tick.",
              {
                level: "warn",
                targetBlockHeight: state.targetBlockHeight,
                referencedBlockHashDisplay: resolveReadContextCoreTip(options.readContext).hash,
                runId: options.backgroundWorkerRunId,
              },
            ));
            return restartMiningImmediately();
          }

          if (error instanceof Error && error.message === "mining_generation_preempted") {
            clearMiningProviderWait(options.loopState);
            await options.appendEvent(createMiningEventRecord(
              "generation-paused-preempted",
              "Stopped sentence generation because another wallet command requested mining preemption.",
              {
                level: "warn",
                targetBlockHeight: state.targetBlockHeight,
                referencedBlockHashDisplay: resolveReadContextCoreTip(options.readContext).hash,
                runId: options.backgroundWorkerRunId,
              },
            ));
            return continueMiningNormally();
          }

          clearMiningProviderWait(options.loopState);
          const failureMessage = error instanceof Error ? error.message : String(error);
          if (state.tipKey !== null) {
            options.loopState.attemptedTipKey = state.tipKey;
            options.loopState.waitingNote = "Mining sentence generation failed for the current tip.";
          }

          await options.saveCycleStatus(options.readContext, {
            runMode: options.runMode,
            currentPhase: "waiting-provider",
            currentPublishDecision: null,
            providerState: "unavailable",
            lastError: failureMessage,
            note: "Mining sentence generation failed for the current tip.",
          });
          await options.appendEvent(createMiningEventRecord(
            "sentence-generation-failed",
            failureMessage,
            {
              level: "error",
              targetBlockHeight: state.targetBlockHeight,
              referencedBlockHashDisplay: resolveReadContextCoreTip(options.readContext).hash,
              runId: options.backgroundWorkerRunId,
            },
          ));
          return continueMiningNormally();
        }

        state.phase = "scoring";
        continue;
      }
      case "scoring": {
        clearMiningProviderWait(options.loopState);
        await saveAttemptStatus(null, {
          runMode: options.runMode,
          currentPhase: "scoring",
          currentPublishDecision: null,
          competitivenessGateReason: null,
          competitivenessGateDiagnostics: null,
          lastError: null,
          note: `Scoring mining candidates for ${formatMiningAttemptBlock(state.targetBlockHeight)}.`,
        });

        const best = await chooseBestLocalCandidate(state.generatedCandidates ?? []);
        if (best === null) {
          if (state.tipKey !== null) {
            options.loopState.attemptedTipKey = state.tipKey;
            options.loopState.waitingNote = "No publishable mining candidate passed scoring gates for the current tip.";
          }
          clearSelectedCandidate(options.loopState);
          await options.saveCycleStatus(options.readContext, {
            runMode: options.runMode,
            currentPhase: "idle",
            currentPublishDecision: "publish-skipped-no-candidate",
            competitivenessGateReason: null,
            competitivenessGateDiagnostics: null,
            note: "No publishable mining candidate passed scoring gates for the current tip.",
          });
          await options.appendEvent(createMiningEventRecord(
            "publish-skipped-no-candidate",
            "No publishable mining candidate passed scoring gates.",
            {
              targetBlockHeight: state.targetBlockHeight,
              referencedBlockHashDisplay: resolveReadContextCoreTip(options.readContext).hash,
              runId: options.backgroundWorkerRunId,
            },
          ));
          return continueMiningNormally();
        }

        const scoringTruthResult = await ensureCurrentIndexerTruthOrStopCycle();
        if (scoringTruthResult !== null) {
          return scoringTruthResult;
        }

        options.loopState.ui.recentWin = null;
        cacheSelectedCandidateForTip(
          options.loopState,
          state.tipKey,
          best,
          options.readContext.localState.state.miningState,
        );
        state.selectedCandidate = best;
        const ensureCandidateFresh = createScoringFreshnessGuard(best);
        await options.appendEvent(createMiningEventRecord(
          "candidate-selected",
          `Selected ${best.domainName} with score ${best.canonicalBlend.toString()}.`,
          {
            targetBlockHeight: best.targetBlockHeight,
            referencedBlockHashDisplay: best.referencedBlockHashDisplay,
            domainId: best.domainId,
            domainName: best.domainName,
            score: best.canonicalBlend.toString(),
            runId: options.backgroundWorkerRunId,
          },
        ));

        if (!options.mempoolCheck) {
          state.phase = "publishing";
          continue;
        }

        let lastScoringProgressProcessed = -1;
        let lastScoringProgressSavedAtUnixMs = 0;
        let scoringProgressWrite = Promise.resolve();
        await appendTimingEvent(
          options.appendEvent,
          "timing-mempool-gate-start",
          "Started mining mempool competitiveness gate.",
          {
            runId: options.backgroundWorkerRunId,
            targetBlockHeight: best.targetBlockHeight,
            referencedBlockHashDisplay: best.referencedBlockHashDisplay,
            domainId: best.domainId,
            domainName: best.domainName,
            score: best.canonicalBlend.toString(),
            metrics: {
              outcome: "started",
              currentTxid: options.readContext.localState.state.miningState.currentTxid,
            },
          },
        );
        const gateStartedAt = performance.now();
        let gate: CompetitivenessDecision;
        try {
          gate = await runGateImpl({
            rpc: options.rpc,
            readContext: options.readContext,
            candidate: best,
            currentTxid: options.readContext.localState.state.miningState.currentTxid,
            assaySentencesImpl: options.assaySentencesImpl,
            cooperativeYield: options.cooperativeYieldImpl,
            cooperativeYieldEvery: options.cooperativeYieldEvery,
            mempoolIndex: options.mempoolIndex,
            runId: options.backgroundWorkerRunId,
            appendEvent: options.appendEvent,
            throwIfStopping: options.throwIfStopping,
            ensureCandidateFresh,
            onEvaluationStage: async (stage: MiningGateEvaluationStage) => {
              const note = stage === "mempool-hydrated"
                ? `Hydrated mempool context for ${formatMiningAttemptBlock(best.targetBlockHeight)}.`
                : `Evaluating mempool competitors for ${formatMiningAttemptBlock(best.targetBlockHeight)}.`;
              scoringProgressWrite = scoringProgressWrite.then(async () => {
                await saveAttemptStatus(best, {
                  runMode: options.runMode,
                  currentPhase: "scoring",
                  currentPublishDecision: null,
                  lastError: null,
                  note,
                });
              });
              await scoringProgressWrite;
            },
            onWarmupProgress: async (progress) => {
              if (progress.total <= 0) {
                return;
              }

              const nowUnixMs = now();
              if (
                progress.processed === lastScoringProgressProcessed
                || (
                  progress.processed !== 0
                  && progress.processed !== progress.total
                  && (nowUnixMs - lastScoringProgressSavedAtUnixMs) < 500
                )
              ) {
                return;
              }

              lastScoringProgressProcessed = progress.processed;
              lastScoringProgressSavedAtUnixMs = nowUnixMs;
              scoringProgressWrite = scoringProgressWrite.then(async () => {
                await saveAttemptStatus(best, {
                  runMode: options.runMode,
                  currentPhase: "scoring",
                  currentPublishDecision: null,
                  lastError: null,
                  note: `Hydrating mempool context for ${formatMiningAttemptBlock(best.targetBlockHeight)} (mempool ${progress.processed}/${progress.total}).`,
                });
              });
              await scoringProgressWrite;
            },
          });
        } catch (error) {
          await appendTimingEvent(
            options.appendEvent,
            "timing-mempool-gate-end",
            "Finished mining mempool competitiveness gate.",
            {
              level: "warn",
              runId: options.backgroundWorkerRunId,
              targetBlockHeight: best.targetBlockHeight,
              referencedBlockHashDisplay: best.referencedBlockHashDisplay,
              domainId: best.domainId,
              domainName: best.domainName,
              score: best.canonicalBlend.toString(),
              durationMs: performance.now() - gateStartedAt,
              metrics: {
                outcome: isMiningScoringAttemptStaleError(error) ? "stale" : "error",
                errorName: error instanceof Error ? error.name : "unknown",
                checkpoint: isMiningScoringAttemptStaleError(error) ? error.checkpoint : null,
              },
            },
          );
          await scoringProgressWrite;
          if (isMiningScoringAttemptStaleError(error)) {
            clearTransientRestartWork();
            clearMiningGateCache(walletRootId);
            options.loopState.waitingNote = "Bitcoin tip advanced; restarting mining scoring on the fresh tip.";
            await options.appendEvent(createMiningEventRecord(
              "generation-restarted-stale-tip",
              "Detected updated Bitcoin tip during mining scoring; restarting immediately.",
              {
                level: "warn",
                targetBlockHeight: best.targetBlockHeight,
                referencedBlockHashDisplay: best.referencedBlockHashDisplay,
                runId: options.backgroundWorkerRunId,
                reason: error.checkpoint,
                metrics: {
                  observedBestHeight: error.observedBestHeight,
                  observedBestHash: error.observedBestHash,
                },
              },
            ));
            return restartMiningImmediately("Bitcoin tip advanced; restarting mining scoring on the fresh tip.");
          }
          throw error;
        }
        await appendTimingEvent(
          options.appendEvent,
          "timing-mempool-gate-end",
          "Finished mining mempool competitiveness gate.",
          {
            runId: options.backgroundWorkerRunId,
            targetBlockHeight: best.targetBlockHeight,
            referencedBlockHashDisplay: best.referencedBlockHashDisplay,
            domainId: best.domainId,
            domainName: best.domainName,
            score: best.canonicalBlend.toString(),
            durationMs: performance.now() - gateStartedAt,
            metrics: {
              outcome: "success",
              allowed: gate.allowed,
              decision: gate.decision,
              indeterminate: gate.competitivenessGateIndeterminate,
              cacheStatus: gate.mempoolSequenceCacheStatus,
              mempoolSequence: gate.lastMempoolSequence,
            },
          },
        );
        await scoringProgressWrite;
        throwIfInterrupted();
        state.gateSnapshot = {
          higherRankedCompetitorDomainCount: gate.higherRankedCompetitorDomainCount,
          dedupedCompetitorDomainCount: gate.dedupedCompetitorDomainCount,
          mempoolSequenceCacheStatus: gate.mempoolSequenceCacheStatus,
          lastMempoolSequence: gate.lastMempoolSequence,
        };
        state.gateCheckedAtUnixMs = now();

        if (!gate.allowed) {
          if (state.tipKey !== null) {
            options.loopState.attemptedTipKey = state.tipKey;
          }
          clearSelectedCandidate(options.loopState);
          setMiningUiCandidate(
            options.loopState,
            best,
            options.readContext.localState.state.miningState,
          );
          options.loopState.waitingNote = gate.decision === "suppressed-same-domain-mempool"
            ? "Best local sentence found, but a same-domain mempool competitor already matches or beats it."
            : gate.decision === "suppressed-top5-mempool"
              ? `Best local sentence found, but ${gate.higherRankedCompetitorDomainCount} stronger competitor root domains are already in mempool.`
              : `Mining skipped this tick because the mempool competitiveness gate could not be verified safely${formatGateReasonSuffix(gate.indeterminateReason)}.${formatGateDiagnosticsSummary(gate.diagnostics)}`;
          const gateWasIndeterminate = gate.decision === "indeterminate-mempool-gate";
          await options.saveCycleStatus(options.readContext, {
            runMode: options.runMode,
            currentPhase: "waiting",
            currentPublishDecision: gate.decision,
            sameDomainCompetitorSuppressed: gate.sameDomainCompetitorSuppressed,
            higherRankedCompetitorDomainCount: gate.higherRankedCompetitorDomainCount,
            dedupedCompetitorDomainCount: gate.dedupedCompetitorDomainCount,
            competitivenessGateIndeterminate: gate.competitivenessGateIndeterminate,
            competitivenessGateReason: gateWasIndeterminate ? gate.indeterminateReason : null,
            competitivenessGateDiagnostics: gateWasIndeterminate ? gate.diagnostics : null,
            mempoolSequenceCacheStatus: gate.mempoolSequenceCacheStatus,
            lastMempoolSequence: gate.lastMempoolSequence,
            lastCompetitivenessGateAtUnixMs: now(),
            note: options.loopState.waitingNote,
          });
          await options.appendEvent(createMiningEventRecord(
            gate.decision === "suppressed-same-domain-mempool"
              ? "publish-skipped-same-domain-mempool"
              : gate.decision === "suppressed-top5-mempool"
                ? "publish-skipped-top5-mempool"
                : "publish-skipped-gate-indeterminate",
            gate.decision === "suppressed-same-domain-mempool"
                ? "Skipped publish because a same-domain mempool competitor already outranks the local candidate."
                : gate.decision === "suppressed-top5-mempool"
                  ? `Skipped publish because ${gate.higherRankedCompetitorDomainCount} stronger competitor root domains are already in mempool.`
                  : `Skipped publish because the competitiveness gate could not be evaluated safely${formatGateReasonSuffix(gate.indeterminateReason)}.${formatGateDiagnosticsSummary(gate.diagnostics)}`,
            {
              targetBlockHeight: best.targetBlockHeight,
              referencedBlockHashDisplay: best.referencedBlockHashDisplay,
              domainId: best.domainId,
              domainName: best.domainName,
              score: best.canonicalBlend.toString(),
              runId: options.backgroundWorkerRunId,
              reason: gateWasIndeterminate ? gate.indeterminateReason ?? gate.decision : gate.decision,
            },
          ));
          return continueMiningNormally();
        }

        state.phase = "publishing";
        continue;
      }
      case "publishing":
      case "replacing": {
        const selectedCandidate = state.selectedCandidate;
        if (selectedCandidate === null) {
          return continueMiningNormally();
        }

        options.loopState.ui.recentWin = null;
        setMiningUiCandidate(
          options.loopState,
          selectedCandidate,
          options.readContext.localState.state.miningState,
        );

        const publishTruthResult = await ensureCurrentIndexerTruthOrStopCycle();
        if (publishTruthResult !== null) {
          return publishTruthResult;
        }

        const prePublishStatusStartedAt = performance.now();
        try {
          await options.saveCycleStatus(options.readContext, {
            runMode: options.runMode,
            ...buildPrePublishStatusOverrides({
              state: options.readContext.localState.state,
              candidate: selectedCandidate,
            }),
            ...buildPublishGateStatusOverrides(state),
          });
          await appendTimingEvent(
            options.appendEvent,
            "timing-prepublish-status-write",
            "Wrote pre-publish mining status.",
            {
              runId: options.backgroundWorkerRunId,
              targetBlockHeight: selectedCandidate.targetBlockHeight,
              referencedBlockHashDisplay: selectedCandidate.referencedBlockHashDisplay,
              domainId: selectedCandidate.domainId,
              domainName: selectedCandidate.domainName,
              score: selectedCandidate.canonicalBlend.toString(),
              durationMs: performance.now() - prePublishStatusStartedAt,
              metrics: {
                outcome: "success",
              },
            },
          );
        } catch (error) {
          await appendTimingEvent(
            options.appendEvent,
            "timing-prepublish-status-write",
            "Wrote pre-publish mining status.",
            {
              level: "warn",
              runId: options.backgroundWorkerRunId,
              targetBlockHeight: selectedCandidate.targetBlockHeight,
              referencedBlockHashDisplay: selectedCandidate.referencedBlockHashDisplay,
              domainId: selectedCandidate.domainId,
              domainName: selectedCandidate.domainName,
              score: selectedCandidate.canonicalBlend.toString(),
              durationMs: performance.now() - prePublishStatusStartedAt,
              metrics: {
                outcome: "error",
                errorName: error instanceof Error ? error.name : "unknown",
              },
            },
          );
          throw error;
        }

        const publishLock = await acquireFileLock(options.paths.walletControlLockPath, {
          purpose: "wallet-mine",
          walletRootId: options.readContext.localState.state.walletRootId,
        });

        try {
          const lockedTruthResult = await ensureCurrentIndexerTruthOrStopCycle();
          if (lockedTruthResult !== null) {
            return lockedTruthResult;
          }

          throwIfInterrupted();
          const published = await publishCandidate({
            dataDir: options.dataDir,
            databasePath: options.databasePath,
            provider: options.provider,
            paths: options.paths,
            fallbackState: options.readContext.localState.state,
            openReadContext: options.openReadContext,
            attachService: options.attachService,
            rpcFactory: options.rpcFactory,
            candidate: selectedCandidate,
            runId: options.backgroundWorkerRunId,
            appendEventFn: async (_paths, event) => {
              await options.appendEvent(event);
            },
            throwIfStopping: options.throwIfStopping,
          });
          if (
            state.tipKey !== null
            && published.retryable !== true
            && published.restart !== true
            && published.decision !== "publish-paused-insufficient-funds"
          ) {
            options.loopState.attemptedTipKey = state.tipKey;
          }
          if (published.restart === true) {
            clearSelectedCandidate(options.loopState);
            options.loopState.waitingNote = published.note;
            await options.saveCycleStatus({
              ...options.readContext,
              localState: {
                ...options.readContext.localState,
                state: published.state,
              },
            }, {
              runMode: options.runMode,
              currentPhase: published.currentPhase ?? "waiting",
              readinessBlocker: published.readinessBlocker,
              currentPublishDecision: published.decision,
              ...buildPublishGateStatusOverrides(state),
              lastError: published.lastError ?? null,
              note: published.note,
              livePublishInMempool: published.state.miningState.livePublishInMempool,
            });
            return continueMiningNormally();
          }
          if (published.retryable === true) {
            cacheSelectedCandidateForTip(
              options.loopState,
              state.tipKey,
              published.candidate,
              published.state.miningState,
            );
            options.loopState.waitingNote = published.note;
            await options.saveCycleStatus({
              ...options.readContext,
              localState: {
                ...options.readContext.localState,
                state: published.state,
              },
            }, {
              runMode: options.runMode,
              currentPhase: published.currentPhase ?? "waiting",
              readinessBlocker: published.readinessBlocker,
              currentPublishDecision: published.decision,
              ...buildPublishGateStatusOverrides(state),
              lastError: published.lastError ?? null,
              note: published.note,
              livePublishInMempool: published.state.miningState.livePublishInMempool,
            });
            return continueMiningNormally();
          }
          if (published.skipped === true) {
            clearSelectedCandidate(options.loopState);
            setMiningUiCandidate(
              options.loopState,
              selectedCandidate,
              published.state.miningState,
            );
            options.loopState.waitingNote = published.note;
            const lastError = published.decision === "publish-paused-insufficient-funds"
              ? published.lastError ?? createInsufficientFundsMiningPublishErrorMessage()
              : published.lastError ?? null;
            await options.saveCycleStatus({
              ...options.readContext,
              localState: {
                ...options.readContext.localState,
                state: published.state,
              },
            }, {
              runMode: options.runMode,
              currentPhase: "waiting",
              currentPublishDecision: published.decision,
              ...buildPublishGateStatusOverrides(state),
              lastError,
              note: published.note,
              livePublishInMempool: published.state.miningState.livePublishInMempool,
            });
            return continueMiningNormally();
          }
          clearSelectedCandidate(options.loopState);
          if (published.txid !== null) {
            options.loopState.ui.latestTxid = published.txid;
          }
          setMiningUiCandidate(
            options.loopState,
            published.candidate,
            published.state.miningState,
          );
          options.loopState.waitingNote = published.decision === "kept-live-publish"
            ? "Existing live mining publish already covers this block attempt; waiting for Bitcoin Core to report the next block."
            : published.txid === null
              ? "Mining candidate was evaluated but the existing live publish stayed in place."
              : `Mining candidate ${published.decision === "replaced"
                ? "replaced"
                : "broadcast"} as ${published.txid}. Waiting for the next block.`;

          await options.saveCycleStatus({
            ...options.readContext,
            localState: {
              ...options.readContext.localState,
              state: published.state,
            },
          }, {
            runMode: options.runMode,
            currentPhase: "waiting",
            currentPublishDecision: published.decision,
            ...buildPublishGateStatusOverrides(state),
            lastError: null,
            note: options.loopState.waitingNote,
            livePublishInMempool: published.state.miningState.livePublishInMempool,
          });
          return continueMiningNormally();
        } finally {
          await publishLock.release();
        }
      }
      default:
        return continueMiningNormally();
    }
  }
}
