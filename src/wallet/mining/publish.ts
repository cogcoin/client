import { createHash } from "node:crypto";

import { getBlockWinners } from "@cogcoin/indexer/queries";
import { deriveBlendSeed, displayToInternalBlockhash } from "@cogcoin/scoring";
import { createRpcClient } from "../../bitcoind/node.js";
import { serializeMine } from "../cogop/index.js";
import { openWalletReadContext, type WalletReadContext } from "../read/index.js";
import type { WalletRuntimePaths } from "../runtime.js";
import type { WalletSecretProvider } from "../state/provider.js";
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
  type MiningMutationPlan,
  type MiningPublishOutcome,
  type MiningPublishSkipResult,
  type MiningPublishRetryResult,
  type MiningRpcClient,
  type ReadyMiningReadContext,
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
import { refreshMiningCandidateFromCurrentState, type MiningEligibleAnchoredRoot } from "./candidate.js";
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

export function createStaleMiningCandidateWaitingNote(): string {
  return "Mining candidate changed before broadcast: the selected root domain is no longer locally mineable. Skipping this tip and waiting for the next block.";
}

export function createRetryableMiningPublishWaitingNote(): string {
  return "Selected mining candidate did not reach mempool and will be retried on the current tip with refreshed wallet state.";
}

export function createInsufficientFundsMiningPublishWaitingNote(): string {
  return "Insufficient BTC to mine.";
}

export function createInsufficientFundsMiningPublishErrorMessage(): string {
  return "Bitcoin Core could not fund the next mining publish with safe BTC.";
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
}): Promise<{ state: WalletStateV1; txid: string | null; decision: string }> {
  const appendEventFn = options.appendEventFn;
  const service = await options.attachService({
    dataDir: options.dataDir,
    chain: "main",
    startHeight: 0,
    walletRootId: options.readContext.localState.state.walletRootId,
  });
  const rpc = options.rpcFactory(service.rpc);
  let state = (await reconcileLiveMiningState({
    state: options.readContext.localState.state,
    rpc,
    nodeBestHash: options.readContext.nodeStatus?.nodeBestHashHex ?? null,
    nodeBestHeight: options.readContext.nodeStatus?.nodeBestHeight ?? null,
    snapshotState: options.readContext.snapshot.state,
  })).state;
  const allUtxos = await rpc.listUnspent(state.managedCoreWallet.walletName, MINING_FUNDING_MIN_CONF);
  const conflictOutpoint = resolveMiningConflictOutpoint({
    state,
    allUtxos,
  });
  const priorMiningState = cloneMiningState(state.miningState);

  if (
    livePublishTargetsCandidateTip({
      liveState: state.miningState,
      candidate: options.candidate,
    })
  ) {
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
  const nextFeeRate = feeSelection.feeRateSatVb;

  const plan = createMiningPlan({
    state,
    candidate: options.candidate,
    conflictOutpoint,
    allUtxos,
    feeRateSatVb: nextFeeRate,
  });
  const built = await buildMiningTransaction({
    rpc,
    walletName: state.managedCoreWallet.walletName,
    state,
    plan,
  });
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
  await saveWalletStatePreservingUnlock({
    state,
    provider: options.provider,
    paths: options.paths,
  });

  try {
    await rpc.sendRawTransaction(built.rawHex);
  } catch (error) {
    if (isAlreadyAcceptedError(error)) {
      state = defaultMiningStatePatch(state, {
        currentPublishState: "in-mempool",
        livePublishInMempool: true,
      });
      await saveWalletStatePreservingUnlock({
        state,
        provider: options.provider,
        paths: options.paths,
      });
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
      state = defaultMiningStatePatch(state, {
        currentPublishState: "broadcast-unknown",
        currentPublishDecision: "broadcast-unknown",
      });
      await saveWalletStatePreservingUnlock({
        state,
        provider: options.provider,
        paths: options.paths,
      });
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

    state = {
      ...state,
      miningState: cloneMiningState(priorMiningState),
    };
    await saveWalletStatePreservingUnlock({
      state,
      provider: options.provider,
      paths: options.paths,
    });
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
  await saveWalletStatePreservingUnlock({
    state,
    provider: options.provider,
    paths: options.paths,
  });
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
  openReadContext: typeof openWalletReadContext;
  attachService: typeof attachOrStartManagedBitcoindService;
  rpcFactory: (config: Parameters<typeof createRpcClient>[0]) => MiningRpcClient;
  runId: string | null;
  publishAttempt?: typeof publishCandidateOnce;
  appendEventFn: AppendMiningEventFn;
}): Promise<MiningPublishOutcome> {
  const publishAttempt = options.publishAttempt ?? publishCandidateOnce;

  const createStaleCandidateSkipResult = async (state: WalletStateV1): Promise<MiningPublishSkipResult> => {
    const note = createStaleMiningCandidateWaitingNote();
    await options.appendEventFn(options.paths, createMiningEventRecord(
      "publish-skipped-stale-candidate",
      "Skipped mining publish for the current tip because the selected root domain is no longer locally mineable.",
      {
        level: "warn",
        runId: options.runId,
        targetBlockHeight: options.candidate.targetBlockHeight,
        referencedBlockHashDisplay: options.candidate.referencedBlockHashDisplay,
        domainId: options.candidate.domainId,
        domainName: options.candidate.domainName,
        score: options.candidate.canonicalBlend.toString(),
        reason: "candidate-unavailable",
      },
    ));
    return {
      state,
      txid: null,
      decision: "publish-skipped-stale-candidate",
      note,
      skipped: true,
      candidate: null,
    };
  };
  const lockedReadContext = await options.openReadContext({
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    secretProvider: options.provider,
    walletControlLockHeld: true,
    paths: options.paths,
  });

  try {
    if (
      lockedReadContext.localState.availability !== "ready"
      || lockedReadContext.localState.state === null
      || lockedReadContext.snapshot === null
      || lockedReadContext.model === null
    ) {
      return await createStaleCandidateSkipResult(options.fallbackState);
    }

    const readyReadContext = lockedReadContext as ReadyMiningReadContext;
    const refreshedCandidate = refreshMiningCandidateFromCurrentState(readyReadContext, options.candidate);
    if (refreshedCandidate === null) {
      return await createStaleCandidateSkipResult(readyReadContext.localState.state);
    }

    try {
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
      });
      return {
        ...published,
        candidate: refreshedCandidate,
      };
    } catch (error) {
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
  } finally {
    await lockedReadContext.close();
  }
}
