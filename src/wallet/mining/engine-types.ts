import type { WalletReadContext } from "../read/index.js";
import type {
  FixedWalletInput,
  MutationSender,
  WalletMutationRpcClient,
} from "../tx/common.js";
import type { WalletStateV1 } from "../types.js";
import type { MiningRuntimeStatusV1 } from "./types.js";
import type { MiningFollowVisualizerState, MiningRecentWinSummary, MiningSentenceBoardEntry } from "./visualizer.js";

export type MiningRpcClient = WalletMutationRpcClient & {
  getBlockchainInfo(): Promise<{
    blocks: number;
    bestblockhash: string;
    initialblockdownload?: boolean;
  }>;
  getNetworkInfo(): Promise<{
    networkactive: boolean;
    connections_out?: number;
  }>;
  getBlockHash(height: number): Promise<string>;
  getBlock(hashHex: string): Promise<{
    hash: string;
    previousblockhash?: string;
    height: number;
    time?: number;
  }>;
  getMempoolInfo(): Promise<{
    loaded: boolean;
  }>;
  getRawMempool(): Promise<string[]>;
  getRawMempoolVerbose(): Promise<{
    txids: string[];
    mempool_sequence: string | number;
  }>;
  getRawMempoolEntries(): Promise<Record<string, {
    vsize: number;
    fees: {
      base: number;
      ancestor: number;
      descendant: number;
    };
    ancestorsize?: number;
    descendantsize?: number;
  }>>;
  getMempoolEntry(txid: string): Promise<{
    vsize: number;
    fees: {
      base: number;
      ancestor: number;
      descendant: number;
    };
    ancestorsize?: number;
    descendantsize?: number;
  }>;
  getRawTransaction(txid: string, verbose?: boolean): Promise<{
    txid: string;
    hash?: string;
    vin: Array<{ txid?: string; prevout?: { scriptPubKey?: { hex?: string } } }>;
    vout: Array<{ n: number; value: number | string; scriptPubKey?: { hex?: string } }>;
  }>;
  getTransaction(walletName: string, txid: string): Promise<{
    txid: string;
    confirmations: number;
    blockhash?: string;
    walletconflicts?: string[];
  }>;
  sendRawTransaction(hex: string): Promise<string>;
  saveMempool?(): Promise<null>;
};

export interface MiningCandidate {
  domainId: number;
  domainName: string;
  localIndex: number;
  sender: MutationSender;
  sentence: string;
  encodedSentenceBytes: Uint8Array;
  bip39WordIndices: number[];
  bip39Words: readonly string[];
  canonicalBlend: bigint;
  referencedBlockHashDisplay: string;
  referencedBlockHashInternal: Uint8Array;
  targetBlockHeight: number;
}

export type ReadyMiningReadContext = WalletReadContext & {
  localState: { availability: "ready"; state: WalletStateV1 };
  snapshot: NonNullable<WalletReadContext["snapshot"]>;
  model: NonNullable<WalletReadContext["model"]>;
};

export function resolveReadyMiningReadContext(
  readContext: WalletReadContext,
): ReadyMiningReadContext | null {
  if (
    readContext.localState.availability !== "ready"
    || readContext.localState.state === null
    || readContext.snapshot === null
    || readContext.model === null
  ) {
    return null;
  }

  return readContext as ReadyMiningReadContext;
}

export interface MiningPublishSkipResult {
  state: WalletStateV1;
  txid: null;
  decision: "publish-skipped-stale-candidate" | "publish-paused-insufficient-funds";
  note: string;
  lastError?: string | null;
  skipped: true;
  retryable?: false;
  candidate: null;
}

export interface MiningPublishRetryResult {
  state: WalletStateV1;
  txid: null;
  decision: "publish-retry-pending";
  note: string;
  lastError?: string | null;
  skipped?: false;
  retryable: true;
  candidate: MiningCandidate;
}

export interface MiningPublishSuccessResult {
  state: WalletStateV1;
  txid: string | null;
  decision: string;
  note?: null;
  skipped?: false;
  retryable?: false;
  candidate: MiningCandidate;
}

export type MiningPublishOutcome =
  | MiningPublishSuccessResult
  | MiningPublishSkipResult
  | MiningPublishRetryResult;

export interface CompetitivenessDecision {
  allowed: boolean;
  decision: string;
  sameDomainCompetitorSuppressed: boolean;
  higherRankedCompetitorDomainCount: number;
  dedupedCompetitorDomainCount: number;
  competitivenessGateIndeterminate: boolean;
  mempoolSequenceCacheStatus: MiningRuntimeStatusV1["mempoolSequenceCacheStatus"];
  lastMempoolSequence: string | null;
  visibleBoardEntries: MiningSentenceBoardEntry[];
  candidateRank: number | null;
}

export type MiningCyclePhase = MiningRuntimeStatusV1["currentPhase"];

export interface MiningCycleGateSnapshot {
  higherRankedCompetitorDomainCount: number;
  dedupedCompetitorDomainCount: number;
  mempoolSequenceCacheStatus: MiningRuntimeStatusV1["mempoolSequenceCacheStatus"];
  lastMempoolSequence: string | null;
}

export interface MiningCycleState {
  phase: MiningCyclePhase;
  targetBlockHeight: number | null;
  tipKey: string | null;
  selectedCandidate: MiningCandidate | null;
  gateSnapshot: MiningCycleGateSnapshot;
}

export interface MiningCycleContext {
  currentPhase: MiningCyclePhase;
  targetBlockHeight: number | null;
  tipKey: string | null;
  selectedCandidate: MiningCandidate | null;
}

export interface MiningCycleEffects {
  statusPhase?: MiningCyclePhase;
  persistState?: WalletStateV1 | null;
  followUiState?: MiningFollowVisualizerState | null;
  recentWin?: MiningRecentWinSummary | null;
}

export interface MiningMutationPlan {
  sender: MutationSender;
  fixedInputs: FixedWalletInput[];
  outputs: unknown[];
  changeAddress: string;
  changePosition: number;
  expectedOpReturnScriptHex: string;
  allowedFundingScriptPubKeyHex: string;
  eligibleFundingOutpointKeys: Set<string>;
  expectedConflictOutpoint: { txid: string; vout: number } | null;
  feeRateSatVb: number;
}

export type MiningCooperativeYield = () => Promise<void>;
