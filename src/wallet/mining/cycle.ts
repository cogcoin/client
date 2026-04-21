import { assaySentences } from "@cogcoin/scoring";
import { acquireFileLock } from "../fs/lock.js";
import { openWalletReadContext, type WalletReadContext } from "../read/index.js";
import type { WalletRuntimePaths } from "../runtime.js";
import type { WalletSecretProvider } from "../state/provider.js";
import { createMiningEventRecord } from "./events.js";
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
import { clearMiningGateCache, runCompetitivenessGate } from "./competitiveness.js";
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
  type MiningRuntimeStatusOverrides,
} from "./projection.js";

interface RuntimeMiningCycleState extends MiningCycleState {
  generatedCandidates: MiningCandidate[] | null;
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
    gateSnapshot: {
      higherRankedCompetitorDomainCount: 0,
      dedupedCompetitorDomainCount: 0,
      mempoolSequenceCacheStatus: null,
      lastMempoolSequence: null,
    },
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
  nowImpl?: () => number;
  saveCycleStatus: (
    readContext: WalletReadContext,
    overrides: MiningRuntimeStatusOverrides,
  ) => Promise<MiningRuntimeStatusV1>;
  appendEvent: (event: MiningEventRecord) => Promise<void>;
  throwIfStopping?: () => void;
  throwIfSuspendDetected?: () => void;
}): Promise<void> {
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
  const ensureCurrentIndexerTruthOrRestart = async (): Promise<boolean> => {
    try {
      await ensureIndexerTruthIsCurrent({
        dataDir: options.readContext.dataDir,
        truthKey: indexerTruthKey,
      });
      return true;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "mining_generation_stale_indexer_truth") {
        throw error;
      }

      clearMiningGateCache(walletRootId);
      await options.appendEvent(createMiningEventRecord(
        "generation-restarted-indexer-truth",
        "Detected updated coherent indexer truth during mining; restarting on the next tick.",
        {
          level: "warn",
          targetBlockHeight: state.targetBlockHeight,
          referencedBlockHashDisplay: options.readContext.nodeStatus?.nodeBestHashHex ?? null,
          runId: options.backgroundWorkerRunId,
        },
      ));
      return false;
    }
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
            note: "Mining is waiting for the local Bitcoin node to become publishable.",
          });
          return;
        }

        if (options.readContext.indexer.health !== "synced" || options.readContext.nodeHealth !== "synced") {
          clearMiningProviderWait(options.loopState);
          await options.saveCycleStatus(options.readContext, {
            runMode: options.runMode,
            currentPhase: options.readContext.indexer.health !== "synced"
              ? "waiting-indexer"
              : "waiting-bitcoin-network",
            note: options.readContext.indexer.health !== "synced"
              ? "Mining is waiting for Bitcoin Core and the indexer to align."
              : "Mining is waiting for the local Bitcoin node to become publishable.",
          });
          return;
        }

        if (state.targetBlockHeight === null) {
          clearMiningProviderWait(options.loopState);
          await options.saveCycleStatus(options.readContext, {
            runMode: options.runMode,
            currentPhase: "waiting-bitcoin-network",
            note: "Mining is waiting for the local Bitcoin node to become publishable.",
          });
          return;
        }

        const eligibleDomains = resolveEligibleAnchoredRoots(options.readContext);
        if (state.selectedCandidate === null) {
          if (eligibleDomains.length === 0) {
            clearMiningProviderWait(options.loopState);
            await options.saveCycleStatus(options.readContext, {
              runMode: options.runMode,
              currentPhase: "idle",
              currentPublishDecision: null,
              lastError: null,
              note: "No locally controlled anchored root domains are currently eligible to mine.",
            });
            return;
          }

          try {
            await probeMiningFundingAvailability({
              rpc: options.rpc,
              walletName: options.readContext.localState.state.managedCoreWallet.walletName,
              state: options.readContext.localState.state,
              domains: eligibleDomains,
              referencedBlockHashDisplay: options.readContext.nodeStatus?.nodeBestHashHex ?? "00".repeat(32),
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
              return;
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
              note: "Mining is waiting for the sentence provider to recover.",
            });
            return;
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
              note: "Mining is waiting for the sentence provider to recover.",
            });
            return;
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
            note: options.loopState.waitingNote ?? "Waiting for the next block after the last mining attempt on this tip.",
          });
          return;
        }

        state.phase = state.selectedCandidate === null ? "generating" : "publishing";
        continue;
      }
      case "generating": {
        await options.saveCycleStatus(options.readContext, {
          runMode: options.runMode,
          currentPhase: "generating",
          currentPublishDecision: null,
          lastError: null,
          note: "Generating mining sentences for eligible root domains.",
        });

        await options.appendEvent(createMiningEventRecord(
          "sentence-generation-start",
          "Started mining sentence generation.",
          {
            targetBlockHeight: state.targetBlockHeight,
            referencedBlockHashDisplay: options.readContext.nodeStatus?.nodeBestHashHex ?? null,
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
              note: "Mining is waiting for the sentence provider to recover.",
            });
            await options.appendEvent(createMiningEventRecord(
              "publish-paused-provider",
              error.message,
              {
                level: "warn",
                targetBlockHeight: state.targetBlockHeight,
                referencedBlockHashDisplay: options.readContext.nodeStatus?.nodeBestHashHex ?? null,
                runId: options.backgroundWorkerRunId,
              },
            ));
            return;
          }

          if (error instanceof Error && error.message === "mining_generation_stale_tip") {
            await options.appendEvent(createMiningEventRecord(
              "generation-restarted-new-tip",
              "Detected a new best tip during sentence generation; restarting on the next tick.",
              {
                level: "warn",
                targetBlockHeight: state.targetBlockHeight,
                referencedBlockHashDisplay: options.readContext.nodeStatus?.nodeBestHashHex ?? null,
                runId: options.backgroundWorkerRunId,
              },
            ));
            return;
          }

          if (error instanceof Error && error.message === "mining_generation_stale_indexer_truth") {
            clearMiningProviderWait(options.loopState);
            clearMiningGateCache(walletRootId);
            await options.appendEvent(createMiningEventRecord(
              "generation-restarted-indexer-truth",
              "Detected updated coherent indexer truth during mining; restarting on the next tick.",
              {
                level: "warn",
                targetBlockHeight: state.targetBlockHeight,
                referencedBlockHashDisplay: options.readContext.nodeStatus?.nodeBestHashHex ?? null,
                runId: options.backgroundWorkerRunId,
              },
            ));
            return;
          }

          if (error instanceof Error && error.message === "mining_generation_preempted") {
            clearMiningProviderWait(options.loopState);
            await options.appendEvent(createMiningEventRecord(
              "generation-paused-preempted",
              "Stopped sentence generation because another wallet command requested mining preemption.",
              {
                level: "warn",
                targetBlockHeight: state.targetBlockHeight,
                referencedBlockHashDisplay: options.readContext.nodeStatus?.nodeBestHashHex ?? null,
                runId: options.backgroundWorkerRunId,
              },
            ));
            return;
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
              referencedBlockHashDisplay: options.readContext.nodeStatus?.nodeBestHashHex ?? null,
              runId: options.backgroundWorkerRunId,
            },
          ));
          return;
        }

        state.phase = "scoring";
        continue;
      }
      case "scoring": {
        clearMiningProviderWait(options.loopState);
        await options.saveCycleStatus(options.readContext, {
          runMode: options.runMode,
          currentPhase: "scoring",
          currentPublishDecision: null,
          lastError: null,
          note: "Scoring mining candidates for the current tip.",
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
            note: "No publishable mining candidate passed scoring gates for the current tip.",
          });
          await options.appendEvent(createMiningEventRecord(
            "publish-skipped-no-candidate",
            "No publishable mining candidate passed scoring gates.",
            {
              targetBlockHeight: state.targetBlockHeight,
              referencedBlockHashDisplay: options.readContext.nodeStatus?.nodeBestHashHex ?? null,
              runId: options.backgroundWorkerRunId,
            },
          ));
          return;
        }

        if (!await ensureCurrentIndexerTruthOrRestart()) {
          return;
        }

        options.loopState.ui.recentWin = null;
        cacheSelectedCandidateForTip(
          options.loopState,
          state.tipKey,
          best,
          options.readContext.localState.state.miningState,
        );
        state.selectedCandidate = best;
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

        const gate = await runGateImpl({
          rpc: options.rpc,
          readContext: options.readContext,
          candidate: best,
          currentTxid: options.readContext.localState.state.miningState.currentTxid,
          assaySentencesImpl: options.assaySentencesImpl,
          cooperativeYield: options.cooperativeYieldImpl,
          cooperativeYieldEvery: options.cooperativeYieldEvery,
          throwIfStopping: options.throwIfStopping,
        });
        throwIfInterrupted();
        state.gateSnapshot = {
          higherRankedCompetitorDomainCount: gate.higherRankedCompetitorDomainCount,
          dedupedCompetitorDomainCount: gate.dedupedCompetitorDomainCount,
          mempoolSequenceCacheStatus: gate.mempoolSequenceCacheStatus,
          lastMempoolSequence: gate.lastMempoolSequence,
        };

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
              : "Mining skipped this tick because the mempool competitiveness gate could not be verified safely.";
          await options.saveCycleStatus(options.readContext, {
            runMode: options.runMode,
            currentPhase: "waiting",
            currentPublishDecision: gate.decision,
            sameDomainCompetitorSuppressed: gate.sameDomainCompetitorSuppressed,
            higherRankedCompetitorDomainCount: gate.higherRankedCompetitorDomainCount,
            dedupedCompetitorDomainCount: gate.dedupedCompetitorDomainCount,
            competitivenessGateIndeterminate: gate.competitivenessGateIndeterminate,
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
                : "Skipped publish because the competitiveness gate could not be evaluated safely.",
            {
              targetBlockHeight: best.targetBlockHeight,
              referencedBlockHashDisplay: best.referencedBlockHashDisplay,
              domainId: best.domainId,
              domainName: best.domainName,
              score: best.canonicalBlend.toString(),
              runId: options.backgroundWorkerRunId,
              reason: gate.decision,
            },
          ));
          return;
        }

        state.phase = "publishing";
        continue;
      }
      case "publishing":
      case "replacing": {
        const selectedCandidate = state.selectedCandidate;
        if (selectedCandidate === null) {
          return;
        }

        options.loopState.ui.recentWin = null;
        setMiningUiCandidate(
          options.loopState,
          selectedCandidate,
          options.readContext.localState.state.miningState,
        );

        if (!await ensureCurrentIndexerTruthOrRestart()) {
          return;
        }

        await options.saveCycleStatus(options.readContext, {
          runMode: options.runMode,
          ...buildPrePublishStatusOverrides({
            state: options.readContext.localState.state,
            candidate: selectedCandidate,
          }),
        });

        const publishLock = await acquireFileLock(options.paths.walletControlLockPath, {
          purpose: "wallet-mine",
          walletRootId: options.readContext.localState.state.walletRootId,
        });

        try {
          if (!await ensureCurrentIndexerTruthOrRestart()) {
            return;
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
            && published.decision !== "publish-paused-insufficient-funds"
          ) {
            options.loopState.attemptedTipKey = state.tipKey;
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
              currentPhase: "waiting",
              currentPublishDecision: published.decision,
              sameDomainCompetitorSuppressed: false,
              higherRankedCompetitorDomainCount: state.gateSnapshot.higherRankedCompetitorDomainCount,
              dedupedCompetitorDomainCount: state.gateSnapshot.dedupedCompetitorDomainCount,
              competitivenessGateIndeterminate: false,
              mempoolSequenceCacheStatus: state.gateSnapshot.mempoolSequenceCacheStatus,
              lastMempoolSequence: state.gateSnapshot.lastMempoolSequence,
              lastCompetitivenessGateAtUnixMs: now(),
              lastError: published.lastError ?? null,
              note: published.note,
              livePublishInMempool: published.state.miningState.livePublishInMempool,
            });
            return;
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
              : null;
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
              sameDomainCompetitorSuppressed: false,
              higherRankedCompetitorDomainCount: state.gateSnapshot.higherRankedCompetitorDomainCount,
              dedupedCompetitorDomainCount: state.gateSnapshot.dedupedCompetitorDomainCount,
              competitivenessGateIndeterminate: false,
              mempoolSequenceCacheStatus: state.gateSnapshot.mempoolSequenceCacheStatus,
              lastMempoolSequence: state.gateSnapshot.lastMempoolSequence,
              lastCompetitivenessGateAtUnixMs: now(),
              lastError,
              note: published.note,
              livePublishInMempool: published.state.miningState.livePublishInMempool,
            });
            return;
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
            ? "Existing live mining publish already covers this block attempt. Waiting for the next block."
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
            sameDomainCompetitorSuppressed: false,
            higherRankedCompetitorDomainCount: state.gateSnapshot.higherRankedCompetitorDomainCount,
            dedupedCompetitorDomainCount: state.gateSnapshot.dedupedCompetitorDomainCount,
            competitivenessGateIndeterminate: false,
            mempoolSequenceCacheStatus: state.gateSnapshot.mempoolSequenceCacheStatus,
            lastMempoolSequence: state.gateSnapshot.lastMempoolSequence,
            lastCompetitivenessGateAtUnixMs: now(),
            lastError: null,
            note: options.loopState.waitingNote,
            livePublishInMempool: published.state.miningState.livePublishInMempool,
          });
          return;
        } finally {
          await publishLock.release();
        }
      }
      default:
        return;
    }
  }
}
