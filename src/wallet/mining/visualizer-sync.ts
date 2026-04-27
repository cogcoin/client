import {
  getBalance,
  getBlockWinners,
  lookupDomainById,
} from "@cogcoin/indexer/queries";
import { displayToInternalBlockhash } from "@cogcoin/scoring";

import { FOLLOW_VISIBLE_PRIOR_BLOCKS } from "../../bitcoind/client/follow-block-times.js";
import type { WalletReadContext } from "../read/index.js";
import { readFundingBalanceSummary } from "../read/local-state.js";
import type { WalletStateV1 } from "../types.js";
import type { MiningRpcClient } from "./engine-types.js";
import type { MiningRuntimeLoopState } from "./engine-state.js";
import { buildMiningTipKey, resetMiningUiForTip } from "./engine-state.js";
import {
  deriveMiningWordIndices,
  resolveBip39WordsFromIndices,
} from "./engine-utils.js";
import type {
  MiningFollowVisualizerState,
  MiningRecentWinSummary,
  MiningSentenceBoardEntry,
} from "./visualizer.js";
import { createEmptyMiningFollowVisualizerState } from "./visualizer.js";

function cloneSettledBoardEntries(
  entries: readonly MiningSentenceBoardEntry[],
): MiningSentenceBoardEntry[] {
  return entries.map((entry) => ({
    ...entry,
    requiredWords: [...entry.requiredWords],
  }));
}

function resolveSettledWinnerRequiredWords(options: {
  domainId: number;
  bip39WordIndices?: readonly number[] | null;
  snapshotTipPreviousHashHex?: string | null;
}): readonly string[] {
  const storedWords = resolveBip39WordsFromIndices(options.bip39WordIndices);

  if (storedWords.length > 0) {
    return storedWords;
  }

  if (
    options.snapshotTipPreviousHashHex === null
    || options.snapshotTipPreviousHashHex === undefined
    || !Number.isInteger(options.domainId)
    || options.domainId <= 0
  ) {
    return [];
  }

  return resolveBip39WordsFromIndices(
    deriveMiningWordIndices(
      Buffer.from(displayToInternalBlockhash(options.snapshotTipPreviousHashHex), "hex"),
      options.domainId,
    ),
  );
}

function fallbackSettledWinnerDomainName(domainId: number): string {
  return `domain-${domainId}`;
}

function resolveSettledBoardEntriesForHeight(options: {
  snapshotState: NonNullable<WalletReadContext["snapshot"]>["state"] | null | undefined;
  blockHeight: number;
  blockPreviousHashHex: string | null;
}): MiningSentenceBoardEntry[] | null {
  if (options.snapshotState === null || options.snapshotState === undefined) {
    return null;
  }

  const winners = getBlockWinners(options.snapshotState, options.blockHeight);
  if (winners === null) {
    return null;
  }

  const snapshotState = options.snapshotState;
  return winners
    .slice()
    .sort((left, right) => left.rank - right.rank || left.txIndex - right.txIndex)
    .slice(0, 5)
    .map((winner) => ({
      rank: winner.rank,
      domainName: lookupDomainById(snapshotState, winner.domainId)?.name ?? fallbackSettledWinnerDomainName(winner.domainId),
      sentence: winner.sentenceText ?? "[unavailable]",
      requiredWords: resolveSettledWinnerRequiredWords({
        domainId: winner.domainId,
        bip39WordIndices: (winner as typeof winner & { bip39WordIndices?: number[] }).bip39WordIndices,
        snapshotTipPreviousHashHex: options.blockPreviousHashHex,
      }),
    }));
}

function resolveLatestPriorNonEmptySettledBoard(options: {
  snapshotState: NonNullable<WalletReadContext["snapshot"]>["state"];
  snapshotTipHeight: number;
}): {
  settledBlockHeight: number | null;
  settledBoardEntries: MiningSentenceBoardEntry[];
} | null {
  for (let blockHeight = options.snapshotTipHeight - 1; blockHeight >= 0; blockHeight -= 1) {
    const settledBoardEntries = resolveSettledBoardEntriesForHeight({
      snapshotState: options.snapshotState,
      blockHeight,
      blockPreviousHashHex: null,
    });

    if (settledBoardEntries !== null && settledBoardEntries.length > 0) {
      return {
        settledBlockHeight: blockHeight,
        settledBoardEntries,
      };
    }
  }

  return null;
}

function resolveCurrentMinedBlockBoard(options: {
  snapshotState: NonNullable<WalletReadContext["snapshot"]>["state"] | null | undefined;
  snapshotTipHeight: number | null;
  snapshotTipPreviousHashHex: string | null;
  currentDisplayedBoard?: {
    settledBlockHeight: number | null;
    settledBoardEntries: readonly MiningSentenceBoardEntry[];
  };
}): {
  settledBlockHeight: number | null;
  settledBoardEntries: MiningSentenceBoardEntry[];
} {
  const settledBlockHeight = options.snapshotTipHeight ?? null;

  if (settledBlockHeight === null) {
    return {
      settledBlockHeight,
      settledBoardEntries: [],
    };
  }

  if (options.snapshotState === null || options.snapshotState === undefined) {
    return {
      settledBlockHeight,
      settledBoardEntries: [],
    };
  }

  const settledBoardEntries = resolveSettledBoardEntriesForHeight({
    snapshotState: options.snapshotState,
    blockHeight: settledBlockHeight,
    blockPreviousHashHex: options.snapshotTipPreviousHashHex,
  });

  if (settledBoardEntries !== null) {
    return {
      settledBlockHeight,
      settledBoardEntries,
    };
  }

  const currentDisplayedBlockHeight = options.currentDisplayedBoard?.settledBlockHeight ?? null;
  const currentDisplayedEntries = options.currentDisplayedBoard?.settledBoardEntries ?? [];
  if (
    currentDisplayedBlockHeight !== null
    && currentDisplayedBlockHeight <= settledBlockHeight
    && currentDisplayedEntries.length > 0
  ) {
    return {
      settledBlockHeight: currentDisplayedBlockHeight,
      settledBoardEntries: cloneSettledBoardEntries(currentDisplayedEntries),
    };
  }

  const latestPriorNonEmptyBoard = resolveLatestPriorNonEmptySettledBoard({
    snapshotState: options.snapshotState,
    snapshotTipHeight: settledBlockHeight,
  });
  if (latestPriorNonEmptyBoard !== null) {
    return latestPriorNonEmptyBoard;
  }

  return {
    settledBlockHeight,
    settledBoardEntries: [],
  };
}

export function resolveSettledBoard(options: {
  snapshotState: NonNullable<WalletReadContext["snapshot"]>["state"] | null | undefined;
  snapshotTipHeight: number | null;
  snapshotTipPreviousHashHex?: string | null;
  nodeBestHeight: number | null;
}): {
  settledBlockHeight: number | null;
  settledBoardEntries: MiningSentenceBoardEntry[];
} {
  void options.nodeBestHeight;

  return resolveCurrentMinedBlockBoard({
    snapshotState: options.snapshotState,
    snapshotTipHeight: options.snapshotTipHeight,
    snapshotTipPreviousHashHex: options.snapshotTipPreviousHashHex ?? null,
  });
}

function syncMiningUiSettledBoard(
  loopState: MiningRuntimeLoopState,
  snapshotState: NonNullable<WalletReadContext["snapshot"]>["state"] | null | undefined,
  snapshotTipHeight: number | null,
  snapshotTipPreviousHashHex: string | null,
): void {
  const settledBoard = resolveCurrentMinedBlockBoard({
    snapshotState,
    snapshotTipHeight,
    snapshotTipPreviousHashHex,
    currentDisplayedBoard: {
      settledBlockHeight: loopState.ui.settledBlockHeight,
      settledBoardEntries: loopState.ui.settledBoardEntries,
    },
  });
  loopState.ui.settledBlockHeight = settledBoard.settledBlockHeight;
  loopState.ui.settledBoardEntries = settledBoard.settledBoardEntries;
}

export function syncMiningUiForCurrentTip(options: {
  loopState: MiningRuntimeLoopState;
  snapshotState: NonNullable<WalletReadContext["snapshot"]>["state"] | null | undefined;
  snapshotTipHeight: number | null;
  snapshotTipPreviousHashHex: string | null;
  nodeBestHeight: number | null;
  nodeBestHash: string | null;
  recentWin: MiningRecentWinSummary | null;
}): {
  targetBlockHeight: number | null;
  tipKey: string | null;
  tipChanged: boolean;
} {
  const targetBlockHeight = options.nodeBestHeight === null
    ? null
    : options.nodeBestHeight + 1;
  const tipKey = buildMiningTipKey(options.nodeBestHash, targetBlockHeight);
  const priorTipKey = options.loopState.currentTipKey;
  const tipChanged = tipKey !== null && tipKey !== priorTipKey;

  if (tipKey !== priorTipKey) {
    options.loopState.currentTipKey = tipKey;
    resetMiningUiForTip(options.loopState, targetBlockHeight);

    if (options.recentWin !== null) {
      options.loopState.ui.recentWin = options.recentWin;
    }
  }

  syncMiningUiSettledBoard(
    options.loopState,
    options.snapshotState,
    options.snapshotTipHeight,
    options.snapshotTipPreviousHashHex,
  );

  return {
    targetBlockHeight,
    tipKey,
    tipChanged,
  };
}

export async function resolveFundingDisplaySats(state: WalletStateV1, rpc: MiningRpcClient): Promise<bigint> {
  const summary = await readFundingBalanceSummary({
    state,
    rpc,
  });

  return summary.fundingDisplaySats ?? 0n;
}

export async function loadMiningVisibleFollowBlockTimes(options: {
  rpc: MiningRpcClient;
  indexedTipHeight: number | null;
  indexedTipHashHex: string | null;
}): Promise<Record<number, number>> {
  if (options.indexedTipHeight === null || options.indexedTipHashHex === null) {
    return {};
  }

  const blockTimesByHeight: Record<number, number> = {};
  let currentHeight = options.indexedTipHeight;
  let currentHashHex: string | null = options.indexedTipHashHex;

  for (let offset = 0; offset <= FOLLOW_VISIBLE_PRIOR_BLOCKS; offset += 1) {
    if (currentHeight < 0 || currentHashHex === null) {
      break;
    }

    const block = await options.rpc.getBlock(currentHashHex);

    if (typeof block.time === "number") {
      blockTimesByHeight[currentHeight] = block.time;
    }

    currentHashHex = block.previousblockhash ?? null;
    currentHeight -= 1;
  }

  return blockTimesByHeight;
}

export function syncMiningVisualizerBalances(
  loopState: MiningRuntimeLoopState,
  readContext: WalletReadContext & { localState: { availability: "ready"; state: WalletStateV1 } },
  balanceSats: bigint | null,
): void {
  loopState.ui.fundingAddress = readContext.model?.walletAddress ?? readContext.localState.state.funding.address;
  loopState.ui.balanceCogtoshi = readContext.snapshot === null
    ? null
    : getBalance(readContext.snapshot.state, readContext.localState.state.funding.scriptPubKeyHex);
  loopState.ui.balanceSats = balanceSats;
}

export function createIndexedMiningFollowVisualizerState(
  readContext: WalletReadContext,
): MiningFollowVisualizerState {
  const uiState = createEmptyMiningFollowVisualizerState();
  const localState = readContext.localState;
  const settledBoard = resolveCurrentMinedBlockBoard({
    snapshotState: readContext.snapshot?.state ?? null,
    snapshotTipHeight: readContext.snapshot?.tip?.height ?? readContext.indexer.snapshotTip?.height ?? null,
    snapshotTipPreviousHashHex: readContext.snapshot?.tip?.previousHashHex ?? readContext.indexer.snapshotTip?.previousHashHex ?? null,
  });

  uiState.settledBlockHeight = settledBoard.settledBlockHeight;
  uiState.settledBoardEntries = settledBoard.settledBoardEntries;
  if (localState.availability === "ready" && localState.state !== null) {
    uiState.fundingAddress = readContext.model?.walletAddress ?? localState.state.funding.address;
  }

  if (readContext.snapshot !== null && localState.availability === "ready" && localState.state !== null) {
    uiState.balanceCogtoshi = getBalance(
      readContext.snapshot.state,
      localState.state.funding.scriptPubKeyHex,
    );
  }

  return uiState;
}

export function syncMiningVisualizerBlockTimes(
  loopState: MiningRuntimeLoopState,
  blockTimesByHeight: Record<number, number>,
): void {
  loopState.ui.visibleBlockTimesByHeight = { ...blockTimesByHeight };
}

export function findRecentMiningWin(
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
