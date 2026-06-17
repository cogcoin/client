import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { getBlockWinners } from "@cogcoin/indexer/queries";
import { deriveBlendSeed, displayToInternalBlockhash } from "@cogcoin/scoring";
import { createRpcClient } from "../../bitcoind/node.js";
import { serializeMine } from "../cogop/index.js";
import { openWalletReadContext, type WalletReadContext } from "../read/index.js";
import type { WalletRuntimePaths } from "../runtime.js";
import type { WalletSecretProvider } from "../state/provider.js";
import { loadWalletState } from "../state/storage.js";
import {
  assertFixedInputPrefixMatches,
  buildWalletMutationTransaction,
  fundAndValidateWalletMutationDraft,
  isAlreadyAcceptedError,
  isBroadcastUnknownError,
  isInsufficientFundsError,
  outpointKey as walletMutationOutpointKey,
  reconcilePersistentPolicyLocks,
  resolveWalletMutationFeeSelection,
  saveWalletStatePreservingUnlock,
  type MutationSender,
} from "../tx/common.js";
import type { MiningStateRecord, OutpointRecord, WalletStateV1 } from "../types.js";
import { createMiningEventRecord } from "./events.js";
import {
  type MiningCandidate,
  type MiningCandidateProvenance,
  type MiningMutationPlan,
  type MiningPublishOutcome,
  type MiningPublishRestartResult,
  type MiningPublishSkipResult,
  type MiningPublishRetryResult,
  type MiningRpcClient,
  type ReadyMiningReadContext,
  resolveReadContextCoreTip,
  resolveReadyMiningReadContext,
} from "./engine-types.js";
import {
  cloneMiningState,
  defaultMiningStatePatch,
  livePublishTargetsCandidateTip,
  miningCandidateIsCurrent,
  resolveSharedMiningConflictOutpoint,
} from "./engine-state.js";
import {
  deriveMiningWordIndices,
  numberToSats,
  resolveBip39WordsFromIndices,
} from "./engine-utils.js";
import {
  clearMiningPublishState,
  miningPublishMayStillExist,
} from "./state.js";
import {
  ensureIndexerTruthIsCurrent,
  refreshMiningCandidateFromCurrentStateDetailed,
  getIndexerTruthKey,
  type MiningCandidateRefreshFailureReason,
  type MiningEligibleAnchoredRoot,
} from "./candidate.js";
import type { MiningEventRecord } from "./types.js";
import type { MiningRecentWinSummary } from "./visualizer.js";
import { attachOrStartManagedBitcoindService } from "../../bitcoind/service.js";

const MINING_FUNDING_MIN_CONF = 0;
const MINING_FUNDING_PROBE_PLACEHOLDER_SENTENCE = "m".repeat(60);

export class MiningPublishRejectedError extends Error {
  readonly revertedState: WalletStateV1;

  constructor(message: string, revertedState: WalletStateV1) {
    super(message);
    this.name = "MiningPublishRejectedError";
    this.revertedState = revertedState;
  }
}

class ManagedCoreWalletRelockPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedCoreWalletRelockPendingError";
  }
}

async function appendPublishTimingEvent(
  appendEventFn: AppendMiningEventFn | undefined,
  paths: WalletRuntimePaths,
  kind: string,
  message: string,
  options: Partial<MiningEventRecord>,
): Promise<void> {
  if (appendEventFn === undefined) {
    return;
  }

  try {
    await appendEventFn(paths, createMiningEventRecord(kind, message, options));
  } catch {
    // Timing telemetry must not alter the publish path.
  }
}

function createPublishTimingContext(options: {
  candidate: MiningCandidate;
  runId: string | null;
  txid?: string | null;
  feeRateSatVb?: number | null;
  feeSats?: string | null;
  level?: MiningEventRecord["level"];
  durationMs?: number | null;
  metrics: MiningEventRecord["metrics"];
}): Partial<MiningEventRecord> {
  const event: Partial<MiningEventRecord> = {
    runId: options.runId,
    targetBlockHeight: options.candidate.targetBlockHeight,
    referencedBlockHashDisplay: options.candidate.referencedBlockHashDisplay,
    domainId: options.candidate.domainId,
    domainName: options.candidate.domainName,
    txid: options.txid ?? null,
    feeRateSatVb: options.feeRateSatVb ?? null,
    feeSats: options.feeSats ?? null,
    score: options.candidate.canonicalBlend.toString(),
    metrics: options.metrics,
  };
  if (options.level !== undefined) {
    event.level = options.level;
  }
  if (options.durationMs !== undefined) {
    event.durationMs = options.durationMs;
  }
  return event;
}

export function createStaleMiningCandidateWaitingNote(): string {
  return "Mining candidate changed before broadcast: wallet authorization for the selected root domain was lost. Skipping this tip and waiting for the next block.";
}

export function createSnapshotUnavailableMiningPublishWaitingNote(): string {
  return "Mining is waiting for a coherent indexer snapshot lease before broadcasting the selected candidate.";
}

export function createSnapshotChangedMiningPublishWaitingNote(): string {
  return "Mining indexer truth changed before broadcast; restarting candidate selection with the latest coherent snapshot.";
}

export function createTipChangedMiningPublishWaitingNote(): string {
  return "Bitcoin tip changed before broadcast; restarting candidate selection for the current block.";
}

function createCandidateRefreshFailureWaitingNote(reason: MiningCandidateRefreshFailureReason): string {
  switch (reason) {
    case "domain-not-found":
      return "Mining candidate changed before broadcast: the selected root domain ID is not present in the current indexer snapshot.";
    case "domain-not-root":
      return "Mining candidate changed before broadcast: the selected domain is no longer a root domain.";
    case "domain-unanchored":
      return "Mining candidate changed before broadcast: the selected root domain is no longer anchored.";
    case "authorization-lost":
      return createStaleMiningCandidateWaitingNote();
  }
}

export function createRetryableMiningPublishWaitingNote(): string {
  return "Selected mining candidate did not reach mempool and will be retried on the current tip with refreshed wallet state.";
}

export function createManagedCoreWalletRelockRetryWaitingNote(): string {
  return "Mining temporarily lost the managed Bitcoin wallet unlock and is retrying.";
}

export function createInsufficientFundsMiningPublishWaitingNote(): string {
  return "Insufficient BTC to mine.";
}

export function createInsufficientFundsMiningPublishErrorMessage(): string {
  return "Bitcoin Core could not fund the next mining publish with safe BTC.";
}

function clearAutoReconciledMiningPublish(
  state: WalletStateV1,
  currentPublishDecision: string,
): WalletStateV1 {
  return {
    ...state,
    miningState: {
      ...clearMiningPublishState(state.miningState),
      currentPublishDecision,
    },
  };
}

async function hasConfirmedWalletConflict(options: {
  rpc: MiningRpcClient;
  walletName: string;
  conflictTxids: readonly string[];
}): Promise<boolean> {
  for (const txid of options.conflictTxids) {
    const conflictTx = await options.rpc.getTransaction(options.walletName, txid).catch(() => null);
    if (conflictTx !== null && conflictTx.confirmations > 0) {
      return true;
    }
  }

  return false;
}

function createMiningFundingProbeCandidate(options: {
  domain: MiningEligibleAnchoredRoot;
  referencedBlockHashDisplay: string;
  targetBlockHeight: number;
}): MiningCandidate {
  const referencedBlockHashInternal = Buffer.from(
    displayToInternalBlockhash(options.referencedBlockHashDisplay),
    "hex",
  );
  const bip39WordIndices = deriveMiningWordIndices(
    referencedBlockHashInternal,
    options.domain.domainId,
  );

  return {
    domainId: options.domain.domainId,
    domainName: options.domain.domainName,
    localIndex: options.domain.localIndex,
    sender: options.domain.sender,
    sentence: MINING_FUNDING_PROBE_PLACEHOLDER_SENTENCE,
    encodedSentenceBytes: Buffer.from(MINING_FUNDING_PROBE_PLACEHOLDER_SENTENCE, "utf8"),
    bip39WordIndices,
    bip39Words: resolveBip39WordsFromIndices(bip39WordIndices),
    canonicalBlend: 0n,
    referencedBlockHashDisplay: options.referencedBlockHashDisplay,
    referencedBlockHashInternal,
    targetBlockHeight: options.targetBlockHeight,
  };
}

export function resolveMiningConflictOutpoint(options: {
  state: WalletStateV1;
  allUtxos: Awaited<ReturnType<MiningRpcClient["listUnspent"]>>;
}): OutpointRecord | null {
  void options.allUtxos;
  return resolveSharedMiningConflictOutpoint(options.state.miningState);
}

export function createMiningPlan(options: {
  state: WalletStateV1;
  candidate: MiningCandidate;
  conflictOutpoint: OutpointRecord | null;
  allUtxos: Awaited<ReturnType<MiningRpcClient["listUnspent"]>>;
  feeRateSatVb: number;
}): MiningMutationPlan {
  const fundingUtxos = options.allUtxos.filter((entry) =>
    entry.scriptPubKey === options.state.funding.scriptPubKeyHex
    && entry.confirmations >= MINING_FUNDING_MIN_CONF
    && entry.spendable !== false
    && entry.safe !== false
    && !(
      options.conflictOutpoint !== null
      && entry.txid === options.conflictOutpoint.txid
      && entry.vout === options.conflictOutpoint.vout
    )
  );
  const opReturnData = serializeMine(
    options.candidate.domainId,
    options.candidate.referencedBlockHashInternal,
    options.candidate.encodedSentenceBytes,
  ).opReturnData;
  const expectedOpReturnScriptHex = Buffer.concat([
    Buffer.from([0x6a, opReturnData.length]),
    Buffer.from(opReturnData),
  ]).toString("hex");

  return {
    sender: options.candidate.sender,
    fixedInputs: options.conflictOutpoint === null ? [] : [options.conflictOutpoint],
    outputs: [{ data: Buffer.from(opReturnData).toString("hex") }],
    changeAddress: options.state.funding.address,
    changePosition: 1,
    expectedOpReturnScriptHex,
    allowedFundingScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
    eligibleFundingOutpointKeys: new Set(
      fundingUtxos.map((entry) => walletMutationOutpointKey({ txid: entry.txid, vout: entry.vout })),
    ),
    expectedConflictOutpoint: options.conflictOutpoint,
    feeRateSatVb: options.feeRateSatVb,
  };
}

export function validateMiningDraft(
  decoded: Awaited<ReturnType<MiningRpcClient["decodePsbt"]>>,
  funded: Awaited<ReturnType<MiningRpcClient["walletCreateFundedPsbt"]>>,
  plan: MiningMutationPlan,
): void {
  const inputs = decoded.tx.vin;
  const outputs = decoded.tx.vout;

  if (inputs.length === 0) {
    throw new Error("wallet_mining_missing_inputs");
  }

  assertFixedInputPrefixMatches(inputs, plan.fixedInputs, "wallet_mining_missing_inputs");

  if (
    plan.expectedConflictOutpoint !== null
    && (
      inputs[0]?.txid !== plan.expectedConflictOutpoint.txid
      || inputs[0]?.vout !== plan.expectedConflictOutpoint.vout
    )
  ) {
    throw new Error("wallet_mining_conflict_input_mismatch");
  }

  if (outputs[0]?.scriptPubKey?.hex !== plan.expectedOpReturnScriptHex) {
    throw new Error("wallet_mining_opreturn_mismatch");
  }

  if (
    funded.changepos !== -1
    && (
      funded.changepos !== plan.changePosition
      || outputs[funded.changepos]?.scriptPubKey?.hex !== plan.allowedFundingScriptPubKeyHex
    )
  ) {
    throw new Error("wallet_mining_change_output_mismatch");
  }
}

async function buildMiningTransaction(options: {
  rpc: MiningRpcClient;
  walletName: string;
  state: WalletStateV1;
  plan: MiningMutationPlan;
  recoverManagedCoreWalletLockedOnce?: boolean;
  onManagedCoreWalletLockedRecoveryOutcome?: (outcome: "recovered" | "still-locked") => void;
}) {
  return buildWalletMutationTransaction({
    rpc: options.rpc,
    walletName: options.walletName,
    state: options.state,
    plan: options.plan,
    validateFundedDraft: validateMiningDraft,
    finalizeErrorCode: "wallet_mining_finalize_failed",
    mempoolRejectPrefix: "wallet_mining_mempool_rejected",
    feeRate: options.plan.feeRateSatVb,
    availableFundingMinConf: MINING_FUNDING_MIN_CONF,
    recoverManagedCoreWalletLockedOnce: options.recoverManagedCoreWalletLockedOnce,
    onManagedCoreWalletLockedRecoveryOutcome: options.onManagedCoreWalletLockedRecoveryOutcome,
  });
}

export async function probeMiningFundingAvailability(options: {
  rpc: MiningRpcClient;
  walletName: string;
  state: WalletStateV1;
  domains: MiningEligibleAnchoredRoot[];
  referencedBlockHashDisplay: string;
  targetBlockHeight: number;
}): Promise<void> {
  const templateDomain = options.domains[0];
  if (templateDomain === undefined) {
    return;
  }

  const allUtxos = await options.rpc.listUnspent(
    options.walletName,
    MINING_FUNDING_MIN_CONF,
  );
  const conflictOutpoint = resolveMiningConflictOutpoint({
    state: options.state,
    allUtxos,
  });
  const feeSelection = await resolveWalletMutationFeeSelection({
    rpc: options.rpc,
  });
  const plan = createMiningPlan({
    state: options.state,
    candidate: createMiningFundingProbeCandidate({
      domain: templateDomain,
      referencedBlockHashDisplay: options.referencedBlockHashDisplay,
      targetBlockHeight: options.targetBlockHeight,
    }),
    conflictOutpoint,
    allUtxos,
    feeRateSatVb: feeSelection.feeRateSatVb,
  });

  await fundAndValidateWalletMutationDraft({
    rpc: options.rpc,
    walletName: options.walletName,
    plan,
    validateFundedDraft: validateMiningDraft,
    feeRate: plan.feeRateSatVb,
    availableFundingMinConf: MINING_FUNDING_MIN_CONF,
  });
}

function findRecentMiningWin(
  snapshotState: NonNullable<WalletReadContext["snapshot"]>["state"] | null | undefined,
  txid: string | null,
  targetBlockHeight: number | null,
): MiningRecentWinSummary | null {
  if (snapshotState === null || snapshotState === undefined || txid === null || targetBlockHeight === null) {
    return null;
  }

  const winners = getBlockWinners(snapshotState, targetBlockHeight) ?? [];
  const winner = winners.find((entry) => entry.txidHex === txid) ?? null;

  if (winner === null) {
    return null;
  }

  return {
    rank: winner.rank,
    rewardCogtoshi: winner.rewardCogtoshi,
    blockHeight: winner.height,
  };
}

function computeIntentFingerprint(state: WalletStateV1, candidate: MiningCandidate): string {
  return createHash("sha256")
    .update([
      "mine",
      state.walletRootId,
      candidate.domainId,
      candidate.referencedBlockHashDisplay,
      Buffer.from(candidate.encodedSentenceBytes).toString("hex"),
    ].join("\n"))
    .digest("hex");
}

function resolveCurrentCandidateProvenanceSnapshot(context: ReadyMiningReadContext): Omit<MiningCandidateProvenance, "authorizationRole"> {
  return {
    walletRootId: context.localState.state.walletRootId,
    walletScriptPubKeyHex: context.model.walletScriptPubKeyHex,
    indexerDaemonInstanceId: context.snapshot.daemonInstanceId ?? context.indexer.daemonInstanceId ?? null,
    indexerSnapshotSeq: context.snapshot.snapshotSeq ?? context.indexer.snapshotSeq ?? null,
    snapshotTipHeight: context.snapshot.tip?.height ?? context.indexer.snapshotTip?.height ?? null,
    snapshotTipHash: context.snapshot.tip?.blockHashHex ?? context.indexer.snapshotTip?.blockHashHex ?? null,
  };
}

function candidateProvenanceSnapshotChanged(
  context: ReadyMiningReadContext,
  candidate: MiningCandidate,
): boolean {
  const provenance = candidate.provenance;
  if (provenance === undefined) {
    return false;
  }

  const current = resolveCurrentCandidateProvenanceSnapshot(context);
  return provenance.walletRootId !== current.walletRootId
    || provenance.walletScriptPubKeyHex !== current.walletScriptPubKeyHex
    || provenance.indexerDaemonInstanceId !== current.indexerDaemonInstanceId
    || provenance.indexerSnapshotSeq !== current.indexerSnapshotSeq
    || provenance.snapshotTipHeight !== current.snapshotTipHeight
    || provenance.snapshotTipHash !== current.snapshotTipHash;
}

function candidateTargetsCurrentNodeTip(
  context: ReadyMiningReadContext,
  candidate: MiningCandidate,
): boolean {
  const nodeBestHeight = context.nodeStatus?.nodeBestHeight ?? null;
  const nodeBestHash = context.nodeStatus?.nodeBestHashHex ?? null;
  return nodeBestHeight !== null
    && nodeBestHash !== null
    && candidate.targetBlockHeight === nodeBestHeight + 1
    && candidate.referencedBlockHashDisplay === nodeBestHash;
}

type PublishFastRevalidationResult =
  | { ok: true }
  | {
    ok: false;
    reason: string;
    errorName?: string | null;
  };

function managedCoreWalletIdentityMatches(
  current: WalletStateV1["managedCoreWallet"],
  loaded: WalletStateV1["managedCoreWallet"],
): boolean {
  return loaded.walletName === current.walletName
    && loaded.internalPassphrase === current.internalPassphrase
    && loaded.descriptorChecksum === current.descriptorChecksum
    && (loaded.walletAddress ?? null) === (current.walletAddress ?? null)
    && (loaded.walletScriptPubKeyHex ?? null) === (current.walletScriptPubKeyHex ?? null)
    && loaded.proofStatus === current.proofStatus;
}

function walletPublishIdentityMatches(
  context: ReadyMiningReadContext,
  loaded: WalletStateV1,
): boolean {
  const current = context.localState.state;
  return loaded.stateRevision === current.stateRevision
    && loaded.walletRootId === current.walletRootId
    && loaded.walletRootId === context.localState.walletRootId
    && loaded.network === current.network
    && loaded.descriptor.publicExternal === current.descriptor.publicExternal
    && loaded.descriptor.checksum === current.descriptor.checksum
    && loaded.funding.address === current.funding.address
    && loaded.funding.scriptPubKeyHex === current.funding.scriptPubKeyHex
    && managedCoreWalletIdentityMatches(current.managedCoreWallet, loaded.managedCoreWallet);
}

async function validateFastPublishReadContext(options: {
  readContext: ReadyMiningReadContext;
  candidate: MiningCandidate;
  dataDir: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  throwIfStopping?: () => void;
}): Promise<PublishFastRevalidationResult> {
  options.throwIfStopping?.();

  if (options.candidate.provenance === undefined) {
    return {
      ok: false,
      reason: "missing-candidate-provenance",
    };
  }

  if (candidateProvenanceSnapshotChanged(options.readContext, options.candidate)) {
    return {
      ok: false,
      reason: "candidate-provenance-changed",
    };
  }

  const truthKey = getIndexerTruthKey(options.readContext);
  if (truthKey === null) {
    return {
      ok: false,
      reason: "missing-snapshot-lease",
    };
  }

  try {
    await ensureIndexerTruthIsCurrent({
      dataDir: options.dataDir,
      truthKey,
    });
  } catch (error) {
    return {
      ok: false,
      reason: "indexer-truth-changed",
      errorName: error instanceof Error ? error.name : "unknown",
    };
  }

  let loadedState: WalletStateV1;
  try {
    loadedState = (await loadWalletState({
      primaryPath: options.paths.walletStatePath,
      backupPath: options.paths.walletStateBackupPath,
    }, {
      provider: options.provider,
    })).state;
  } catch (error) {
    return {
      ok: false,
      reason: "wallet-state-unavailable",
      errorName: error instanceof Error ? error.name : "unknown",
    };
  }

  if (!walletPublishIdentityMatches(options.readContext, loadedState)) {
    return {
      ok: false,
      reason: "wallet-state-changed",
    };
  }

  return { ok: true };
}

async function appendFastPublishRevalidationEvent(options: {
  appendEventFn: AppendMiningEventFn;
  paths: WalletRuntimePaths;
  candidate: MiningCandidate;
  runId: string | null;
  readContext: ReadyMiningReadContext;
  durationMs: number;
  result: PublishFastRevalidationResult;
}): Promise<void> {
  await appendPublishTimingEvent(
    options.appendEventFn,
    options.paths,
    "timing-publish-fast-revalidation",
    options.result.ok
      ? "Validated current mining read context before publish."
      : "Current mining read context needs a publish-time refresh.",
    createPublishTimingContext({
      candidate: options.candidate,
      runId: options.runId,
      level: options.result.ok ? "info" : "warn",
      durationMs: options.durationMs,
      metrics: {
        outcome: options.result.ok ? "success" : "fallback",
        reason: options.result.ok ? null : options.result.reason,
        errorName: options.result.ok ? null : options.result.errorName ?? null,
        snapshotSeq: options.readContext.snapshot.snapshotSeq ?? options.readContext.indexer.snapshotSeq ?? null,
        daemonInstanceId: options.readContext.snapshot.daemonInstanceId ?? options.readContext.indexer.daemonInstanceId ?? null,
        stateRevision: options.readContext.localState.state.stateRevision,
        coreBestHeight: options.readContext.nodeStatus?.nodeBestHeight ?? null,
        coreBestHash: options.readContext.nodeStatus?.nodeBestHashHex ?? null,
        indexerTipHeight: options.readContext.snapshot.tip?.height ?? options.readContext.indexer.snapshotTip?.height ?? null,
        indexerTipHash: options.readContext.snapshot.tip?.blockHashHex ?? options.readContext.indexer.snapshotTip?.blockHashHex ?? null,
      },
    }),
  );
}

interface MiningCoreTip {
  height: number | null;
  hash: string | null;
}

class MiningPublishFreshnessRestartError extends Error {
  readonly reason: "snapshot-changed" | "tip-changed";

  constructor(reason: "snapshot-changed" | "tip-changed") {
    super(reason === "snapshot-changed"
      ? "mining_publish_indexer_truth_not_current"
      : "mining_publish_bitcoin_tip_not_current");
    this.reason = reason;
  }
}

function candidateTargetsCoreTip(
  coreTip: MiningCoreTip,
  candidate: MiningCandidate,
): boolean {
  return coreTip.height !== null
    && coreTip.hash !== null
    && candidate.targetBlockHeight === coreTip.height + 1
    && candidate.referencedBlockHashDisplay === coreTip.hash;
}

function readContextIndexerTargetsCoreTip(
  context: ReadyMiningReadContext,
  coreTip: MiningCoreTip,
): boolean {
  if (coreTip.height === null || coreTip.hash === null) {
    return false;
  }

  const snapshotTip = context.snapshot.tip ?? context.indexer.snapshotTip ?? null;
  if (
    snapshotTip === null
    || snapshotTip.height !== coreTip.height
    || snapshotTip.blockHashHex !== coreTip.hash
  ) {
    return false;
  }

  const status = context.indexer.status;
  if (status === null) {
    return true;
  }

  return status.appliedTipHeight === coreTip.height
    && (
      status.appliedTipHash === null
      || status.appliedTipHash === coreTip.hash
    );
}

export async function reconcileLiveMiningState(options: {
  state: WalletStateV1;
  rpc: MiningRpcClient;
  nodeBestHash: string | null;
  nodeBestHeight: number | null;
  snapshotState?: NonNullable<WalletReadContext["snapshot"]>["state"] | null;
}): Promise<{ state: WalletStateV1; recentWin: MiningRecentWinSummary | null }> {
  let state = {
    ...options.state,
    miningState: cloneMiningState(options.state.miningState),
  };
  const currentTxid = state.miningState.currentTxid;

  if (currentTxid === null || !miningPublishMayStillExist(state.miningState)) {
    if (state.miningState.state === "repair-required") {
      state = clearAutoReconciledMiningPublish(state, "repair-auto-cleared-empty-publish");
    }
    await reconcilePersistentPolicyLocks({
      rpc: options.rpc,
      walletName: state.managedCoreWallet.walletName,
      state,
      fixedInputs: [],
    });
    return {
      state,
      recentWin: null,
    };
  }

  const walletName = state.managedCoreWallet.walletName;
  const [mempoolVerbose, walletTx] = await Promise.all([
    options.rpc.getRawMempoolVerbose().catch((): { txids: string[]; mempool_sequence: string } => ({
      txids: [],
      mempool_sequence: "unknown",
    })),
    options.rpc.getTransaction(walletName, currentTxid).catch(() => null),
  ]);
  const inMempool = mempoolVerbose.txids.includes(currentTxid);

  if (walletTx !== null && walletTx.confirmations > 0) {
    const recentWin = findRecentMiningWin(
      options.snapshotState ?? null,
      currentTxid,
      state.miningState.currentBlockTargetHeight,
    );
    state = {
      ...state,
      miningState: {
        ...clearMiningPublishState(state.miningState),
        currentPublishDecision: "tx-confirmed-while-down",
      },
    };
    await reconcilePersistentPolicyLocks({
      rpc: options.rpc,
      walletName: state.managedCoreWallet.walletName,
      state,
      fixedInputs: [],
    });
    return {
      state,
      recentWin,
    };
  }

  if (inMempool) {
    const stale = !miningCandidateIsCurrent({
      state: state.miningState,
      nodeBestHash: options.nodeBestHash,
      nodeBestHeight: options.nodeBestHeight,
    });
    state = defaultMiningStatePatch(state, {
      livePublishInMempool: true,
      currentPublishState: "in-mempool",
      state: stale
        ? "paused-stale"
        : state.miningState.runMode === "stopped"
          ? "paused"
          : "live",
      pauseReason: stale
        ? "stale-block-context"
        : state.miningState.runMode === "stopped"
          ? "user-stopped"
          : null,
      currentPublishDecision: stale ? "paused-stale-mempool" : "restored-live-publish",
    });
    await reconcilePersistentPolicyLocks({
      rpc: options.rpc,
      walletName: state.managedCoreWallet.walletName,
      state,
      fixedInputs: [],
    });
    return {
      state,
      recentWin: null,
    };
  }

  if ((walletTx?.walletconflicts?.length ?? 0) > 0) {
    const confirmedConflict = await hasConfirmedWalletConflict({
      rpc: options.rpc,
      walletName,
      conflictTxids: walletTx?.walletconflicts ?? [],
    });

    if (confirmedConflict) {
      state = clearAutoReconciledMiningPublish(state, "repair-auto-cleared-confirmed-conflict");
      await reconcilePersistentPolicyLocks({
        rpc: options.rpc,
        walletName: state.managedCoreWallet.walletName,
        state,
        fixedInputs: [],
      });
      return {
        state,
        recentWin: null,
      };
    }

    state = defaultMiningStatePatch(state, {
      state: "repair-required",
      pauseReason: state.miningState.currentPublishState === "broadcast-unknown"
        ? "broadcast-unknown-conflict"
        : "wallet-conflict-observed",
      livePublishInMempool: false,
      currentPublishDecision: state.miningState.currentPublishState === "broadcast-unknown"
        ? "repair-required-broadcast-conflict"
        : "repair-required-wallet-conflict",
    });
    await reconcilePersistentPolicyLocks({
      rpc: options.rpc,
      walletName: state.managedCoreWallet.walletName,
      state,
      fixedInputs: [],
    });
    return {
      state,
      recentWin: null,
    };
  }

  state = defaultMiningStatePatch(state, {
    ...clearMiningPublishState(state.miningState),
    currentPublishDecision: state.miningState.currentPublishState === "broadcast-unknown"
      ? "broadcast-unknown-not-seen"
      : "live-publish-not-seen",
  });
  await reconcilePersistentPolicyLocks({
    rpc: options.rpc,
    walletName: state.managedCoreWallet.walletName,
    state,
    fixedInputs: [],
  });
  return {
    state,
    recentWin: null,
  };
}

export async function publishCandidateOnce(options: {
  readContext: ReadyMiningReadContext;
  candidate: MiningCandidate;
  dataDir: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  attachService: typeof attachOrStartManagedBitcoindService;
  rpcFactory: (config: Parameters<typeof createRpcClient>[0]) => MiningRpcClient;
  runId: string | null;
  appendEventFn?: AppendMiningEventFn;
  throwIfStopping?: () => void;
}): Promise<{ state: WalletStateV1; txid: string | null; decision: string }> {
  const appendEventFn = options.appendEventFn;
  const service = await options.attachService({
    dataDir: options.dataDir,
    chain: "main",
    startHeight: 0,
    walletRootId: options.readContext.localState.state.walletRootId,
  });
  options.throwIfStopping?.();
  const rpc = options.rpcFactory(service.rpc);
  const blockchain = await rpc.getBlockchainInfo();
  options.throwIfStopping?.();
  const coreTip: MiningCoreTip = {
    height: blockchain.blocks ?? null,
    hash: blockchain.bestblockhash ?? null,
  };
  if (!candidateTargetsCoreTip(coreTip, options.candidate)) {
    throw new MiningPublishFreshnessRestartError("tip-changed");
  }
  if (!readContextIndexerTargetsCoreTip(options.readContext, coreTip)) {
    throw new MiningPublishFreshnessRestartError("snapshot-changed");
  }
  let state = (await reconcileLiveMiningState({
    state: options.readContext.localState.state,
    rpc,
    nodeBestHash: coreTip.hash,
    nodeBestHeight: coreTip.height,
    snapshotState: options.readContext.snapshot.state,
  })).state;
  options.throwIfStopping?.();
  const saveWalletStateWithTiming = async (
    stage: string,
    stateToSave: WalletStateV1,
  ): Promise<void> => {
    const startedAt = performance.now();
    try {
      await saveWalletStatePreservingUnlock({
        state: stateToSave,
        provider: options.provider,
        paths: options.paths,
      });
      await appendPublishTimingEvent(
        appendEventFn,
        options.paths,
        "timing-wallet-state-save",
        "Saved mining wallet state.",
        createPublishTimingContext({
          candidate: options.candidate,
          runId: options.runId,
          txid: stateToSave.miningState.currentTxid,
          feeRateSatVb: stateToSave.miningState.currentFeeRateSatVb,
          durationMs: performance.now() - startedAt,
          metrics: {
            outcome: "success",
            stage,
            currentPublishState: stateToSave.miningState.currentPublishState,
            currentPublishDecision: stateToSave.miningState.currentPublishDecision,
          },
        }),
      );
    } catch (error) {
      await appendPublishTimingEvent(
        appendEventFn,
        options.paths,
        "timing-wallet-state-save",
        "Saved mining wallet state.",
        createPublishTimingContext({
          candidate: options.candidate,
          runId: options.runId,
          txid: stateToSave.miningState.currentTxid,
          feeRateSatVb: stateToSave.miningState.currentFeeRateSatVb,
          level: "warn",
          durationMs: performance.now() - startedAt,
          metrics: {
            outcome: "error",
            stage,
            currentPublishState: stateToSave.miningState.currentPublishState,
            currentPublishDecision: stateToSave.miningState.currentPublishDecision,
            errorName: error instanceof Error ? error.name : "unknown",
          },
        }),
      );
      throw error;
    }
  };

  let allUtxos: Awaited<ReturnType<MiningRpcClient["listUnspent"]>> | null = null;
  let conflictOutpoint: OutpointRecord | null = null;
  let priorMiningState!: MiningStateRecord;
  let nextFeeRate!: number;
  let managedCoreWalletRelockOutcome: "recovered" | "still-locked" | null = null;
  let built!: Awaited<ReturnType<typeof buildMiningTransaction>>;
  const walletBuildStartedAt = performance.now();

  try {
    allUtxos = await rpc.listUnspent(state.managedCoreWallet.walletName, MINING_FUNDING_MIN_CONF);
    options.throwIfStopping?.();
    conflictOutpoint = resolveMiningConflictOutpoint({
      state,
      allUtxos,
    });
    priorMiningState = cloneMiningState(state.miningState);

    if (
      livePublishTargetsCandidateTip({
        liveState: state.miningState,
        candidate: options.candidate,
      })
    ) {
      await appendPublishTimingEvent(
        appendEventFn,
        options.paths,
        "timing-wallet-build",
        "Built mining wallet transaction.",
        createPublishTimingContext({
          candidate: options.candidate,
          runId: options.runId,
          txid: state.miningState.currentTxid,
          durationMs: performance.now() - walletBuildStartedAt,
          metrics: {
            outcome: "kept-live-publish",
            utxoCount: allUtxos.length,
            hasConflictOutpoint: conflictOutpoint !== null,
            feeRateSatVb: null,
            managedCoreWalletRelockOutcome,
          },
        }),
      );
      return {
        state: defaultMiningStatePatch(state, {
          currentPublishDecision: "kept-live-publish",
        }),
        txid: state.miningState.currentTxid,
        decision: "kept-live-publish",
      };
    }

    const feeSelection = await resolveWalletMutationFeeSelection({
      rpc,
    });
    options.throwIfStopping?.();
    nextFeeRate = feeSelection.feeRateSatVb;

    const plan = createMiningPlan({
      state,
      candidate: options.candidate,
      conflictOutpoint,
      allUtxos,
      feeRateSatVb: nextFeeRate,
    });
    built = await buildMiningTransaction({
      rpc,
      walletName: state.managedCoreWallet.walletName,
      state,
      plan,
      recoverManagedCoreWalletLockedOnce: true,
      onManagedCoreWalletLockedRecoveryOutcome: (outcome: "recovered" | "still-locked") => {
        managedCoreWalletRelockOutcome = outcome;
      },
    });
  } catch (error) {
    if (managedCoreWalletRelockOutcome === "still-locked" && error instanceof Error) {
      await appendPublishTimingEvent(
        appendEventFn,
        options.paths,
        "timing-wallet-build",
        "Built mining wallet transaction.",
        createPublishTimingContext({
          candidate: options.candidate,
          runId: options.runId,
          level: "warn",
          durationMs: performance.now() - walletBuildStartedAt,
          metrics: {
            outcome: "error",
            errorName: "ManagedCoreWalletRelockPendingError",
            utxoCount: allUtxos?.length ?? null,
            hasConflictOutpoint: conflictOutpoint !== null,
            feeRateSatVb: nextFeeRate ?? null,
            managedCoreWalletRelockOutcome,
          },
        }),
      );
      throw new ManagedCoreWalletRelockPendingError(error.message);
    }

    await appendPublishTimingEvent(
      appendEventFn,
      options.paths,
      "timing-wallet-build",
      "Built mining wallet transaction.",
      createPublishTimingContext({
        candidate: options.candidate,
        runId: options.runId,
        level: "warn",
        durationMs: performance.now() - walletBuildStartedAt,
        metrics: {
          outcome: "error",
          errorName: error instanceof Error ? error.name : "unknown",
          utxoCount: allUtxos?.length ?? null,
          hasConflictOutpoint: conflictOutpoint !== null,
          feeRateSatVb: nextFeeRate ?? null,
          managedCoreWalletRelockOutcome,
        },
      }),
    );
    throw error;
  }
  options.throwIfStopping?.();
  await appendPublishTimingEvent(
    appendEventFn,
    options.paths,
    "timing-wallet-build",
    "Built mining wallet transaction.",
    createPublishTimingContext({
      candidate: options.candidate,
      runId: options.runId,
      txid: built.txid,
      feeRateSatVb: nextFeeRate,
      feeSats: numberToSats(built.funded.fee).toString(),
      durationMs: performance.now() - walletBuildStartedAt,
      metrics: {
        outcome: "success",
        utxoCount: allUtxos?.length ?? null,
        hasConflictOutpoint: conflictOutpoint !== null,
        feeRateSatVb: nextFeeRate,
        managedCoreWalletRelockOutcome,
      },
    }),
  );
  if (managedCoreWalletRelockOutcome === "recovered" && appendEventFn !== undefined) {
    await appendEventFn(options.paths, createMiningEventRecord(
      "managed-core-wallet-relock-recovered",
      "Managed Bitcoin Core wallet relocked during signing and was recovered automatically.",
      {
        level: "warn",
        runId: options.runId,
        targetBlockHeight: options.candidate.targetBlockHeight,
        referencedBlockHashDisplay: options.candidate.referencedBlockHashDisplay,
        domainId: options.candidate.domainId,
        domainName: options.candidate.domainName,
        feeRateSatVb: nextFeeRate,
        score: options.candidate.canonicalBlend.toString(),
        reason: "managed-core-wallet-locked",
      },
    ));
  }
  const intentFingerprintHex = computeIntentFingerprint(state, options.candidate);
  state = defaultMiningStatePatch(state, {
    state: "live",
    currentPublishState: "broadcasting",
    currentDomain: options.candidate.domainName,
    currentDomainId: options.candidate.domainId,
    currentDomainIndex: options.candidate.localIndex,
    currentSenderScriptPubKeyHex: options.candidate.sender.scriptPubKeyHex,
    currentTxid: built.txid,
    currentWtxid: built.wtxid,
    currentFeeRateSatVb: nextFeeRate,
    currentAbsoluteFeeSats: numberToSats(built.funded.fee).toString() === "0" ? 0 : Number(numberToSats(built.funded.fee)),
    currentScore: options.candidate.canonicalBlend.toString(),
    currentSentence: options.candidate.sentence,
    currentEncodedSentenceBytesHex: Buffer.from(options.candidate.encodedSentenceBytes).toString("hex"),
    currentBip39WordIndices: [...options.candidate.bip39WordIndices],
    currentBlendSeedHex: Buffer.from(deriveBlendSeed(options.candidate.referencedBlockHashInternal)).toString("hex"),
    currentBlockTargetHeight: options.candidate.targetBlockHeight,
    currentReferencedBlockHashDisplay: options.candidate.referencedBlockHashDisplay,
    currentIntentFingerprintHex: intentFingerprintHex,
    sharedMiningConflictOutpoint: conflictOutpoint,
    livePublishInMempool: null,
    currentPublishDecision: priorMiningState.currentTxid === null
      ? "publishing"
      : "replacing",
  });
  await saveWalletStateWithTiming("pre-broadcast", state);
  options.throwIfStopping?.();

  const sendRawTransactionStartedAt = performance.now();
  try {
    await rpc.sendRawTransaction(built.rawHex);
    options.throwIfStopping?.();
    await appendPublishTimingEvent(
      appendEventFn,
      options.paths,
      "timing-sendrawtransaction",
      "Sent mining transaction to Bitcoin Core.",
      createPublishTimingContext({
        candidate: options.candidate,
        runId: options.runId,
        txid: built.txid,
        feeRateSatVb: nextFeeRate,
        feeSats: numberToSats(built.funded.fee).toString(),
        durationMs: performance.now() - sendRawTransactionStartedAt,
        metrics: {
          outcome: "accepted",
        },
      }),
    );
  } catch (error) {
    if (isAlreadyAcceptedError(error)) {
      await appendPublishTimingEvent(
        appendEventFn,
        options.paths,
        "timing-sendrawtransaction",
        "Sent mining transaction to Bitcoin Core.",
        createPublishTimingContext({
          candidate: options.candidate,
          runId: options.runId,
          txid: built.txid,
          feeRateSatVb: nextFeeRate,
          feeSats: numberToSats(built.funded.fee).toString(),
          durationMs: performance.now() - sendRawTransactionStartedAt,
          metrics: {
            outcome: "already-accepted",
            errorName: error instanceof Error ? error.name : "unknown",
          },
        }),
      );
      state = defaultMiningStatePatch(state, {
        currentPublishState: "in-mempool",
        livePublishInMempool: true,
      });
      await saveWalletStateWithTiming("already-accepted", state);
      if (appendEventFn !== undefined) {
        await appendEventFn(options.paths, createMiningEventRecord(
          state.miningState.currentPublishDecision === "replacing" ? "tx-replaced" : "tx-broadcast",
          `Mining transaction ${built.txid} is already accepted by the local node.`,
          {
            runId: options.runId,
            targetBlockHeight: options.candidate.targetBlockHeight,
            referencedBlockHashDisplay: options.candidate.referencedBlockHashDisplay,
            domainId: options.candidate.domainId,
            domainName: options.candidate.domainName,
            txid: built.txid,
            feeRateSatVb: nextFeeRate,
            feeSats: numberToSats(built.funded.fee).toString(),
            score: options.candidate.canonicalBlend.toString(),
          },
        ));
      }
      return {
        state,
        txid: built.txid,
        decision: state.miningState.currentPublishDecision === "replacing"
          ? "replaced"
          : "broadcast",
      };
    }

    if (isBroadcastUnknownError(error)) {
      await appendPublishTimingEvent(
        appendEventFn,
        options.paths,
        "timing-sendrawtransaction",
        "Sent mining transaction to Bitcoin Core.",
        createPublishTimingContext({
          candidate: options.candidate,
          runId: options.runId,
          txid: built.txid,
          feeRateSatVb: nextFeeRate,
          feeSats: numberToSats(built.funded.fee).toString(),
          level: "warn",
          durationMs: performance.now() - sendRawTransactionStartedAt,
          metrics: {
            outcome: "broadcast-unknown",
            errorName: error instanceof Error ? error.name : "unknown",
          },
        }),
      );
      state = defaultMiningStatePatch(state, {
        currentPublishState: "broadcast-unknown",
        currentPublishDecision: "broadcast-unknown",
      });
      await saveWalletStateWithTiming("broadcast-unknown", state);
      if (appendEventFn !== undefined) {
        await appendEventFn(options.paths, createMiningEventRecord(
          "error",
          `Mining broadcast became uncertain for ${built.txid}.`,
          {
            level: "warn",
            runId: options.runId,
            targetBlockHeight: options.candidate.targetBlockHeight,
            referencedBlockHashDisplay: options.candidate.referencedBlockHashDisplay,
            domainId: options.candidate.domainId,
            domainName: options.candidate.domainName,
            txid: built.txid,
            feeRateSatVb: nextFeeRate,
            feeSats: numberToSats(built.funded.fee).toString(),
            score: options.candidate.canonicalBlend.toString(),
            reason: "broadcast-unknown",
          },
        ));
      }
      return {
        state,
        txid: built.txid,
        decision: "broadcast-unknown",
      };
    }

    await appendPublishTimingEvent(
      appendEventFn,
      options.paths,
      "timing-sendrawtransaction",
      "Sent mining transaction to Bitcoin Core.",
      createPublishTimingContext({
        candidate: options.candidate,
        runId: options.runId,
        txid: built.txid,
        feeRateSatVb: nextFeeRate,
        feeSats: numberToSats(built.funded.fee).toString(),
        level: "warn",
        durationMs: performance.now() - sendRawTransactionStartedAt,
        metrics: {
          outcome: "rejected",
          errorName: error instanceof Error ? error.name : "unknown",
        },
      }),
    );
    state = {
      ...state,
      miningState: cloneMiningState(priorMiningState),
    };
    await saveWalletStateWithTiming("reverted-after-rejection", state);
    throw new MiningPublishRejectedError(
      error instanceof Error ? error.message : String(error),
      state,
    );
  }

  const absoluteFeeSats = numberToSats(built.funded.fee);
  const replacementCount = priorMiningState.currentTxid === null
    ? priorMiningState.replacementCount
    : priorMiningState.replacementCount + 1;
  state = defaultMiningStatePatch(state, {
    currentPublishState: "in-mempool",
    livePublishInMempool: true,
    currentPublishDecision: state.miningState.currentPublishDecision === "replacing"
      ? "replaced"
      : "broadcast",
    replacementCount,
    currentAbsoluteFeeSats: Number(absoluteFeeSats),
    currentBlockFeeSpentSats: (BigInt(state.miningState.currentBlockFeeSpentSats) + absoluteFeeSats).toString(),
    sessionFeeSpentSats: (BigInt(state.miningState.sessionFeeSpentSats) + absoluteFeeSats).toString(),
    lifetimeFeeSpentSats: (BigInt(state.miningState.lifetimeFeeSpentSats) + absoluteFeeSats).toString(),
  });
  await saveWalletStateWithTiming("post-broadcast", state);
  if (appendEventFn !== undefined) {
    await appendEventFn(options.paths, createMiningEventRecord(
      state.miningState.currentPublishDecision === "replaced"
        ? "tx-replaced"
        : "tx-broadcast",
      `${state.miningState.currentPublishDecision === "replaced"
        ? "Replaced"
        : "Broadcast"} mining transaction ${built.txid}.`,
      {
        runId: options.runId,
        targetBlockHeight: options.candidate.targetBlockHeight,
        referencedBlockHashDisplay: options.candidate.referencedBlockHashDisplay,
        domainId: options.candidate.domainId,
        domainName: options.candidate.domainName,
        txid: built.txid,
        feeRateSatVb: nextFeeRate,
        feeSats: absoluteFeeSats.toString(),
        score: options.candidate.canonicalBlend.toString(),
      },
    ));
  }

  return {
    state,
    txid: built.txid,
    decision: state.miningState.currentPublishDecision === "replaced"
      ? "replaced"
      : "broadcast",
  };
}

type AppendMiningEventFn = (paths: WalletRuntimePaths, event: MiningEventRecord) => Promise<void>;

export async function publishCandidate(options: {
  candidate: MiningCandidate;
  dataDir: string;
  databasePath: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  fallbackState: WalletStateV1;
  currentReadContext?: ReadyMiningReadContext;
  openReadContext: typeof openWalletReadContext;
  attachService: typeof attachOrStartManagedBitcoindService;
  rpcFactory: (config: Parameters<typeof createRpcClient>[0]) => MiningRpcClient;
  runId: string | null;
  publishAttempt?: typeof publishCandidateOnce;
  appendEventFn: AppendMiningEventFn;
  throwIfStopping?: () => void;
}): Promise<MiningPublishOutcome> {
  const publishAttempt = options.publishAttempt ?? publishCandidateOnce;

  const createSnapshotUnavailableRetryResult = async (): Promise<MiningPublishRetryResult> => {
    const note = createSnapshotUnavailableMiningPublishWaitingNote();
    await options.appendEventFn(options.paths, createMiningEventRecord(
      "publish-retry-pending",
      "Mining publish is waiting for a coherent indexer snapshot lease before broadcasting.",
      {
        level: "warn",
        runId: options.runId,
        targetBlockHeight: options.candidate.targetBlockHeight,
        referencedBlockHashDisplay: options.candidate.referencedBlockHashDisplay,
        domainId: options.candidate.domainId,
        domainName: options.candidate.domainName,
        score: options.candidate.canonicalBlend.toString(),
        reason: "snapshot-unavailable",
      },
    ));
    return {
      state: options.fallbackState,
      txid: null,
      decision: "publish-retry-pending",
      note,
      currentPhase: "waiting-indexer",
      readinessBlocker: "indexer-snapshot",
      retryable: true,
      candidate: options.candidate,
    };
  };

  const createRestartResult = async (
    state: WalletStateV1,
    decision: MiningPublishRestartResult["decision"],
    note: string,
    reason: "snapshot-changed" | "tip-changed",
  ): Promise<MiningPublishRestartResult> => {
    await options.appendEventFn(options.paths, createMiningEventRecord(
      decision,
      reason === "snapshot-changed"
        ? "Mining indexer truth changed before broadcast; restarting candidate selection."
        : "Bitcoin tip changed before broadcast; restarting candidate selection.",
      {
        level: "warn",
        runId: options.runId,
        targetBlockHeight: options.candidate.targetBlockHeight,
        referencedBlockHashDisplay: options.candidate.referencedBlockHashDisplay,
        domainId: options.candidate.domainId,
        domainName: options.candidate.domainName,
        score: options.candidate.canonicalBlend.toString(),
        reason,
      },
    ));
    return {
      state,
      txid: null,
      decision,
      note,
      currentPhase: "waiting",
      restart: true,
      candidate: null,
    };
  };

  const createCandidateRefreshSkipResult = async (
    state: WalletStateV1,
    reason: MiningCandidateRefreshFailureReason,
    diagnostic: string,
  ): Promise<MiningPublishSkipResult> => {
    const decision = `publish-skipped-${reason}` as MiningPublishSkipResult["decision"];
    const note = createCandidateRefreshFailureWaitingNote(reason);
    const ownerAuthorizationInvariantFailed = reason === "authorization-lost"
      && options.candidate.provenance?.authorizationRole === "owner";
    const lastError = ownerAuthorizationInvariantFailed
      ? `Mining candidate owner authorization invariant failed before broadcast: ${diagnostic}`
      : null;

    await options.appendEventFn(options.paths, createMiningEventRecord(
      decision,
      reason === "authorization-lost"
        ? `Skipped mining publish for the current tip because wallet authorization for the selected root domain was lost. ${diagnostic}`
        : `Skipped mining publish for the current tip because the selected root domain failed publish-time validation: ${diagnostic}`,
      {
        level: ownerAuthorizationInvariantFailed ? "error" : "warn",
        runId: options.runId,
        targetBlockHeight: options.candidate.targetBlockHeight,
        referencedBlockHashDisplay: options.candidate.referencedBlockHashDisplay,
        domainId: options.candidate.domainId,
        domainName: options.candidate.domainName,
        score: options.candidate.canonicalBlend.toString(),
        reason,
      },
    ));

    return {
      state,
      txid: null,
      decision,
      note,
      lastError,
      skipped: true,
      candidate: null,
    };
  };

  const publishWithReadyReadContext = async (
    readyReadContext: ReadyMiningReadContext,
  ): Promise<MiningPublishOutcome> => {
    if (!candidateTargetsCurrentNodeTip(readyReadContext, options.candidate)) {
      return await createRestartResult(
        readyReadContext.localState.state,
        "publish-restart-tip-changed",
        createTipChangedMiningPublishWaitingNote(),
        "tip-changed",
      );
    }
    if (candidateProvenanceSnapshotChanged(readyReadContext, options.candidate)) {
      return await createRestartResult(
        readyReadContext.localState.state,
        "publish-restart-snapshot-changed",
        createSnapshotChangedMiningPublishWaitingNote(),
        "snapshot-changed",
      );
    }
    const refreshResult = refreshMiningCandidateFromCurrentStateDetailed(readyReadContext, options.candidate);
    if (!refreshResult.ok) {
      return await createCandidateRefreshSkipResult(
        readyReadContext.localState.state,
        refreshResult.reason,
        refreshResult.diagnostic,
      );
    }
    const refreshedCandidate = refreshResult.candidate;

    try {
      options.throwIfStopping?.();
      const published = await publishAttempt({
        readContext: readyReadContext,
        candidate: refreshedCandidate,
        dataDir: options.dataDir,
        provider: options.provider,
        paths: options.paths,
        attachService: options.attachService,
        rpcFactory: options.rpcFactory,
        runId: options.runId,
        appendEventFn: options.appendEventFn,
        throwIfStopping: options.throwIfStopping,
      });
      return {
        ...published,
        candidate: refreshedCandidate,
      };
    } catch (error) {
      if (error instanceof MiningPublishFreshnessRestartError) {
        return await createRestartResult(
          readyReadContext.localState.state,
          error.reason === "snapshot-changed"
            ? "publish-restart-snapshot-changed"
            : "publish-restart-tip-changed",
          error.reason === "snapshot-changed"
            ? createSnapshotChangedMiningPublishWaitingNote()
            : createTipChangedMiningPublishWaitingNote(),
          error.reason,
        );
      }

      if (error instanceof ManagedCoreWalletRelockPendingError) {
        const note = createManagedCoreWalletRelockRetryWaitingNote();
        const lastError = error.message;
        await options.appendEventFn(options.paths, createMiningEventRecord(
          "publish-retry-pending",
          "Managed Bitcoin Core wallet relocked during mining publish and will be retried on the current tip.",
          {
            level: "warn",
            runId: options.runId,
            targetBlockHeight: refreshedCandidate.targetBlockHeight,
            referencedBlockHashDisplay: refreshedCandidate.referencedBlockHashDisplay,
            domainId: refreshedCandidate.domainId,
            domainName: refreshedCandidate.domainName,
            score: refreshedCandidate.canonicalBlend.toString(),
            reason: "managed-core-wallet-locked",
          },
        ));
        return {
          state: readyReadContext.localState.state,
          txid: null,
          decision: "publish-retry-pending",
          note,
          lastError,
          retryable: true,
          candidate: refreshedCandidate,
        };
      }

      if (error instanceof Error && error.message === "wallet_mining_mempool_rejected_missing-inputs") {
        const note = createRetryableMiningPublishWaitingNote();
        const revertedState = error instanceof MiningPublishRejectedError
          ? error.revertedState
          : readyReadContext.localState.state;
        await options.appendEventFn(options.paths, createMiningEventRecord(
          "publish-retry-pending",
          "Selected mining candidate did not reach mempool and will be retried on the current tip with refreshed wallet state.",
          {
            level: "warn",
            runId: options.runId,
            targetBlockHeight: refreshedCandidate.targetBlockHeight,
            referencedBlockHashDisplay: refreshedCandidate.referencedBlockHashDisplay,
            domainId: refreshedCandidate.domainId,
            domainName: refreshedCandidate.domainName,
            score: refreshedCandidate.canonicalBlend.toString(),
            reason: "missing-inputs",
          },
        ));
        return {
          state: revertedState,
          txid: null,
          decision: "publish-retry-pending",
          note,
          retryable: true,
          candidate: refreshedCandidate,
        };
      }

      if (isInsufficientFundsError(error)) {
        const note = createInsufficientFundsMiningPublishWaitingNote();
        const lastError = createInsufficientFundsMiningPublishErrorMessage();
        await options.appendEventFn(options.paths, createMiningEventRecord(
          "publish-paused-insufficient-funds",
          "Paused mining publish because Bitcoin Core could not fund the next mining transaction with safe BTC.",
          {
            level: "warn",
            runId: options.runId,
            targetBlockHeight: refreshedCandidate.targetBlockHeight,
            referencedBlockHashDisplay: refreshedCandidate.referencedBlockHashDisplay,
            domainId: refreshedCandidate.domainId,
            domainName: refreshedCandidate.domainName,
            score: refreshedCandidate.canonicalBlend.toString(),
            reason: "insufficient-funds",
          },
        ));
        return {
          state: readyReadContext.localState.state,
          txid: null,
          decision: "publish-paused-insufficient-funds",
          note,
          lastError,
          skipped: true,
          candidate: null,
        };
      }

      throw error;
    }
  };

  if (options.currentReadContext !== undefined) {
    const fastRevalidationStartedAt = performance.now();
    const fastRevalidationResult = await validateFastPublishReadContext({
      readContext: options.currentReadContext,
      candidate: options.candidate,
      dataDir: options.dataDir,
      provider: options.provider,
      paths: options.paths,
      throwIfStopping: options.throwIfStopping,
    });
    await appendFastPublishRevalidationEvent({
      appendEventFn: options.appendEventFn,
      paths: options.paths,
      candidate: options.candidate,
      runId: options.runId,
      readContext: options.currentReadContext,
      durationMs: performance.now() - fastRevalidationStartedAt,
      result: fastRevalidationResult,
    });

    if (fastRevalidationResult.ok) {
      return await publishWithReadyReadContext(options.currentReadContext);
    }
  }

  options.throwIfStopping?.();
  const readContextRefreshStartedAt = performance.now();
  let lockedReadContext: WalletReadContext;
  try {
    lockedReadContext = await options.openReadContext({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      secretProvider: options.provider,
      walletControlLockHeld: true,
      paths: options.paths,
    });
  } catch (error) {
    await appendPublishTimingEvent(
      options.appendEventFn,
      options.paths,
      "timing-read-context-refresh",
      "Refreshed mining read context before publish.",
      createPublishTimingContext({
        candidate: options.candidate,
        runId: options.runId,
        level: "warn",
        durationMs: performance.now() - readContextRefreshStartedAt,
        metrics: {
          outcome: "error",
          errorName: error instanceof Error ? error.name : "unknown",
        },
      }),
    );
    throw error;
  }

  try {
    options.throwIfStopping?.();
    const readyReadContext = resolveReadyMiningReadContext(lockedReadContext);
    await appendPublishTimingEvent(
      options.appendEventFn,
      options.paths,
      "timing-read-context-refresh",
      "Refreshed mining read context before publish.",
      createPublishTimingContext({
        candidate: options.candidate,
        runId: options.runId,
        durationMs: performance.now() - readContextRefreshStartedAt,
        metrics: {
          outcome: readyReadContext === null ? "snapshot-unavailable" : "success",
          indexerTruthSource: lockedReadContext.indexer.source ?? null,
          snapshotSeq: lockedReadContext.snapshot?.snapshotSeq ?? lockedReadContext.indexer.snapshotSeq ?? null,
          daemonInstanceId: lockedReadContext.snapshot?.daemonInstanceId ?? lockedReadContext.indexer.daemonInstanceId ?? null,
          hasSnapshot: lockedReadContext.snapshot !== null,
          hasModel: lockedReadContext.model !== null,
          coreBestHeight: lockedReadContext.nodeStatus?.nodeBestHeight ?? null,
          coreBestHash: lockedReadContext.nodeStatus?.nodeBestHashHex ?? null,
          indexerTipHeight: lockedReadContext.snapshot?.tip?.height ?? lockedReadContext.indexer.snapshotTip?.height ?? null,
          indexerTipHash: lockedReadContext.snapshot?.tip?.blockHashHex ?? lockedReadContext.indexer.snapshotTip?.blockHashHex ?? null,
        },
      }),
    );
    if (readyReadContext === null) {
      return await createSnapshotUnavailableRetryResult();
    }
    return await publishWithReadyReadContext(readyReadContext);
  } finally {
    await lockedReadContext.close();
  }
}
