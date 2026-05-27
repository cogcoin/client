import type { WalletReadContext } from "../read/index.js";
import type {
  FixedWalletInput,
  MutationSender,
  WalletMutationRpcClient,
} from "../tx/common.js";
import type { WalletStateV1 } from "../types.js";
import type { MiningRuntimeStatusV1 } from "./types.js";
import { resolveCorePublishStateNote } from "./publishability.js";
import type {
  MiningCompetitivenessGateDiagnostics,
  MiningCompetitivenessGateReason,
} from "./types.js";
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
  provenance?: MiningCandidateProvenance;
}

export type MiningCandidateAuthorizationRole = "owner" | "delegate" | "miner";

export interface MiningCandidateProvenance {
  walletRootId: string;
  walletScriptPubKeyHex: string;
  indexerDaemonInstanceId: string | null;
  indexerSnapshotSeq: string | null;
  snapshotTipHeight: number | null;
  snapshotTipHash: string | null;
  authorizationRole: MiningCandidateAuthorizationRole;
}

export type ReadyMiningReadContext = WalletReadContext & {
  localState: { availability: "ready"; state: WalletStateV1 };
  snapshot: NonNullable<WalletReadContext["snapshot"]>;
  model: NonNullable<WalletReadContext["model"]>;
};

export type MiningReadinessBlocker = NonNullable<MiningRuntimeStatusV1["readinessBlocker"]>;

export interface MiningReadinessResult {
  ready: boolean;
  blocker: MiningRuntimeStatusV1["readinessBlocker"];
  currentPhase: MiningRuntimeStatusV1["currentPhase"];
  note: string | null;
}

export function resolveReadyMiningReadContext(
  readContext: WalletReadContext,
): ReadyMiningReadContext | null {
  if (
    readContext.localState.availability !== "ready"
    || readContext.localState.state === null
    || readContext.indexer.source !== "lease"
    || readContext.snapshot === null
    || readContext.model === null
  ) {
    return null;
  }

  return readContext as ReadyMiningReadContext;
}

function hashesMatchOrUnknown(left: string | null | undefined, right: string | null | undefined): boolean {
  return left === null || left === undefined || right === null || right === undefined || left === right;
}

export interface MiningCoreTipObservation {
  height: number | null;
  hash: string | null;
}

export function resolveMiningCoreTipObservation(options: {
  nodeStatus: WalletReadContext["nodeStatus"];
  indexerStatus: WalletReadContext["indexer"]["status"];
}): MiningCoreTipObservation {
  const nodeHeight = options.nodeStatus?.nodeBestHeight ?? null;
  const nodeHash = options.nodeStatus?.nodeBestHashHex ?? null;
  const indexerCoreHeight = options.indexerStatus?.coreBestHeight ?? null;
  const indexerCoreHash = options.indexerStatus?.coreBestHash ?? null;
  const hasIndexerCoreTip = indexerCoreHeight !== null && indexerCoreHash !== null;
  const hasNodeCoreTip = nodeHeight !== null && nodeHash !== null;

  if (hasIndexerCoreTip && (!hasNodeCoreTip || indexerCoreHeight !== nodeHeight || indexerCoreHash !== nodeHash)) {
    return {
      height: indexerCoreHeight,
      hash: indexerCoreHash,
    };
  }

  if (hasNodeCoreTip) {
    return {
      height: nodeHeight,
      hash: nodeHash,
    };
  }

  return {
    height: nodeHeight ?? indexerCoreHeight,
    hash: nodeHash ?? indexerCoreHash,
  };
}

export function resolveReadContextCoreTip(readContext: WalletReadContext): MiningCoreTipObservation {
  return resolveMiningCoreTipObservation({
    nodeStatus: readContext.nodeStatus,
    indexerStatus: readContext.indexer.status,
  });
}

export function observedIndexerStatusMatchesCoreTip(readContext: WalletReadContext): boolean {
  const status = readContext.indexer.status;
  const coreTip = resolveReadContextCoreTip(readContext);

  return status !== null
    && status.state === "synced"
    && status.ipcReady === true
    && status.rpcReachable === true
    && coreTip.height !== null
    && status.appliedTipHeight === coreTip.height
    && hashesMatchOrUnknown(status.appliedTipHash, coreTip.hash);
}

export function resolveMiningReadiness(readContext: WalletReadContext, options: {
  corePublishState?: MiningRuntimeStatusV1["corePublishState"];
} = {}): MiningReadinessResult {
  if (readContext.localState.availability !== "ready" || readContext.localState.state === null) {
    return {
      ready: false,
      blocker: "wallet-state",
      currentPhase: "waiting",
      note: "Wallet state must be locally available for mining to continue.",
    };
  }

  if (
    readContext.nodeHealth !== "synced"
    || (
      options.corePublishState !== undefined
      && options.corePublishState !== null
      && options.corePublishState !== "healthy"
    )
  ) {
    return {
      ready: false,
      blocker: "bitcoin-core",
      currentPhase: "waiting-bitcoin-network",
      note: resolveCorePublishStateNote(options.corePublishState ?? null)
        ?? "Mining is waiting for the local Bitcoin node to become publishable.",
    };
  }

  const hasCoherentSnapshotLease = readContext.indexer.source === "lease"
    && readContext.snapshot !== null
    && readContext.model !== null;

  if (!hasCoherentSnapshotLease && observedIndexerStatusMatchesCoreTip(readContext)) {
    return {
      ready: false,
      blocker: "indexer-snapshot",
      currentPhase: "waiting-indexer",
      note: "Mining is waiting for a coherent indexer snapshot lease.",
    };
  }

  if (readContext.indexer.health !== "synced") {
    return {
      ready: false,
      blocker: "indexer-daemon",
      currentPhase: "waiting-indexer",
      note: readContext.indexer.health === "reorging"
        ? "Mining remains stopped while the indexer replays a reorg and refreshes the coherent snapshot."
        : "Mining is waiting for managed indexer readiness.",
    };
  }

  if (!hasCoherentSnapshotLease) {
    return {
      ready: false,
      blocker: "indexer-snapshot",
      currentPhase: "waiting-indexer",
      note: "Mining is waiting for a coherent indexer snapshot lease.",
    };
  }

  const indexedTip = readContext.snapshot?.tip ?? readContext.indexer.snapshotTip ?? null;
  if (indexedTip === null) {
    return {
      ready: false,
      blocker: "indexer-snapshot",
      currentPhase: "waiting-indexer",
      note: "Mining is waiting for a coherent indexer snapshot lease.",
    };
  }

  const coreTip = resolveReadContextCoreTip(readContext);
  if (
    coreTip.height === null
    || indexedTip.height !== coreTip.height
    || !hashesMatchOrUnknown(indexedTip.blockHashHex, coreTip.hash)
  ) {
    return {
      ready: false,
      blocker: "tip-alignment",
      currentPhase: "waiting-indexer",
      note: "Mining is waiting for Bitcoin Core and the indexer to align.",
    };
  }

  return {
    ready: true,
    blocker: null,
    currentPhase: "idle",
    note: null,
  };
}

export interface MiningPublishSkipResult {
  state: WalletStateV1;
  txid: null;
  decision:
    | "publish-skipped-domain-not-found"
    | "publish-skipped-domain-not-root"
    | "publish-skipped-domain-unanchored"
    | "publish-skipped-authorization-lost"
    | "publish-paused-insufficient-funds";
  note: string;
  lastError?: string | null;
  skipped: true;
  retryable?: false;
  restart?: false;
  candidate: null;
}

export interface MiningPublishRetryResult {
  state: WalletStateV1;
  txid: null;
  decision: "publish-retry-pending";
  note: string;
  lastError?: string | null;
  currentPhase?: MiningRuntimeStatusV1["currentPhase"];
  readinessBlocker?: MiningRuntimeStatusV1["readinessBlocker"];
  skipped?: false;
  retryable: true;
  restart?: false;
  candidate: MiningCandidate;
}

export interface MiningPublishRestartResult {
  state: WalletStateV1;
  txid: null;
  decision:
    | "publish-restart-snapshot-changed"
    | "publish-restart-tip-changed";
  note: string;
  lastError?: string | null;
  currentPhase?: MiningRuntimeStatusV1["currentPhase"];
  readinessBlocker?: MiningRuntimeStatusV1["readinessBlocker"];
  skipped?: false;
  retryable?: false;
  restart: true;
  candidate: null;
}

export interface MiningPublishSuccessResult {
  state: WalletStateV1;
  txid: string | null;
  decision: string;
  note?: null;
  skipped?: false;
  retryable?: false;
  restart?: false;
  candidate: MiningCandidate;
}

export type MiningPublishOutcome =
  | MiningPublishSuccessResult
  | MiningPublishSkipResult
  | MiningPublishRetryResult
  | MiningPublishRestartResult;

export interface CompetitivenessDecision {
  allowed: boolean;
  decision: string;
  sameDomainCompetitorSuppressed: boolean;
  higherRankedCompetitorDomainCount: number;
  dedupedCompetitorDomainCount: number;
  competitivenessGateIndeterminate: boolean;
  indeterminateReason: MiningCompetitivenessGateReason | null;
  diagnostics: MiningCompetitivenessGateDiagnostics;
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
