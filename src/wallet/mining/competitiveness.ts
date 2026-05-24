import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { assaySentences, deriveBlendSeed } from "@cogcoin/scoring";
import { lookupDomain, lookupDomainById } from "@cogcoin/indexer/queries";
import { COG_OPCODES, COG_PREFIX } from "../cogop/constants.js";
import type { WalletReadContext } from "../read/index.js";
import type { WalletStateV1 } from "../types.js";
import type {
  CompetitivenessDecision,
  MiningCandidate,
  MiningCooperativeYield,
  MiningRpcClient,
} from "./engine-types.js";
import {
  compareLexicographically,
  numberToSats,
  resolveBip39WordsFromIndices,
  rootDomain,
  tieBreakHash,
} from "./engine-utils.js";
import type { MiningSentenceBoardEntry } from "./visualizer.js";
import { createMiningEventRecord } from "./events.js";
import { getIndexerTruthKey } from "./candidate.js";
import {
  hydrateMiningMempoolIndex,
  MiningMempoolIndexHydrationIncompleteError,
  type MiningMempoolIndexHydrationDiagnostics,
  type MiningMempoolTxContext,
} from "./mempool-index.js";
import type { MiningEventRecord } from "./types.js";

interface CachedCompetitorEntry {
  txid: string;
  effectiveFeeRate: number;
  domainId: number;
  domainName: string;
  sentence: string;
  senderScriptHex: string;
  encodedSentenceBytesHex: string;
  bip39WordIndices: number[];
  canonicalBlend: bigint;
}

type CachedRawMempoolTxContext = MiningMempoolTxContext;

interface MiningCompetitivenessDecisionReuseRecord {
  indexerDaemonInstanceId: string;
  indexerSnapshotSeq: string;
  referencedBlockHashDisplay: string;
  localAssayTupleKey: string;
  excludedTxidsKey: string;
  mempoolSequence: string;
  decision: CompetitivenessDecision;
}

interface MiningCompetitivenessCacheState {
  rawTxContexts: Map<string, CachedRawMempoolTxContext>;
  decisionReuse: MiningCompetitivenessDecisionReuseRecord | null;
}

type MiningMempoolGateCacheStatus =
  NonNullable<CompetitivenessDecision["mempoolSequenceCacheStatus"]>;

export type MiningScoringFreshnessCheckpoint =
  | "mempool-verbose-loaded"
  | "mempool-hydration-start"
  | "mempool-hydration-complete"
  | "mempool-entry-fetch-start"
  | "competitor-scan"
  | "competitor-scan-complete"
  | "rank-evaluation-start"
  | "decision-complete";

export type MiningGateEvaluationStage =
  | "mempool-hydrated"
  | "evaluating-competitors";

export class MiningScoringAttemptStaleError extends Error {
  readonly candidateTargetBlockHeight: number;
  readonly candidateReferencedBlockHashDisplay: string;
  readonly observedBestHeight: number;
  readonly observedBestHash: string;
  readonly checkpoint: MiningScoringFreshnessCheckpoint;

  constructor(options: {
    candidateTargetBlockHeight: number;
    candidateReferencedBlockHashDisplay: string;
    observedBestHeight: number;
    observedBestHash: string;
    checkpoint: MiningScoringFreshnessCheckpoint;
  }) {
    super("mining_scoring_stale_tip");
    this.name = "MiningScoringAttemptStaleError";
    this.candidateTargetBlockHeight = options.candidateTargetBlockHeight;
    this.candidateReferencedBlockHashDisplay = options.candidateReferencedBlockHashDisplay;
    this.observedBestHeight = options.observedBestHeight;
    this.observedBestHash = options.observedBestHash;
    this.checkpoint = options.checkpoint;
  }
}

export function isMiningScoringAttemptStaleError(error: unknown): error is MiningScoringAttemptStaleError {
  return error instanceof MiningScoringAttemptStaleError
    || (
      error instanceof Error
      && error.message === "mining_scoring_stale_tip"
    );
}

interface OverlayDomainState {
  domainId: number;
  name: string | null;
  anchored: boolean;
  ownerScriptHex: string | null;
  delegateScriptHex: string | null;
  minerScriptHex: string | null;
}

type SupportedAncestorOperation =
  | { kind: "domain-reg"; name: string; senderScriptHex: string | null }
  | { kind: "domain-transfer"; domainId: number; recipientScriptHex: string; senderScriptHex: string | null }
  | { kind: "domain-anchor"; domainId: number; senderScriptHex: string | null }
  | { kind: "set-delegate"; domainId: number; delegateScriptHex: string | null }
  | { kind: "set-miner"; domainId: number; minerScriptHex: string | null };

interface RankedMiningSentenceEntry {
  domainId: number;
  domainName: string;
  sentence: string;
  canonicalBlend: bigint;
  senderScriptHex: string;
  encodedSentenceBytesHex: string;
  bip39WordIndices: number[];
  txid: string | null;
  txIndex: number;
}

const MINING_MEMPOOL_COOPERATIVE_YIELD_EVERY = 25;
const MINING_MEMPOOL_RAW_TX_FETCH_CONCURRENCY = 8;
const MINING_MEMPOOL_PROGRESS_REPORT_EVERY = 25;
const miningGateCache = new Map<string, MiningCompetitivenessCacheState>();

interface MiningGateWarmupProgress {
  processed: number;
  total: number;
}

function defaultMiningCooperativeYield(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

async function maybeYieldDuringMempoolScan(options: {
  iteration: number;
  cooperativeYield?: MiningCooperativeYield;
  cooperativeYieldEvery?: number;
}): Promise<void> {
  const yieldEvery = options.cooperativeYieldEvery ?? MINING_MEMPOOL_COOPERATIVE_YIELD_EVERY;
  if (yieldEvery <= 0 || options.iteration === 0 || (options.iteration % yieldEvery) !== 0) {
    return;
  }

  await (options.cooperativeYield ?? defaultMiningCooperativeYield)();
}

function getOrCreateMiningGateCacheState(walletRootId: string): MiningCompetitivenessCacheState {
  const existing = miningGateCache.get(walletRootId);
  if (existing !== undefined) {
    return existing;
  }

  const created: MiningCompetitivenessCacheState = {
    rawTxContexts: new Map<string, CachedRawMempoolTxContext>(),
    decisionReuse: null,
  };
  miningGateCache.set(walletRootId, created);
  return created;
}

function pruneRawTxContextsToVisibleTxids(options: {
  rawTxContexts: Map<string, CachedRawMempoolTxContext>;
  visibleTxids: readonly string[];
}): void {
  const visibleSet = new Set(options.visibleTxids);
  for (const txid of [...options.rawTxContexts.keys()]) {
    if (!visibleSet.has(txid)) {
      options.rawTxContexts.delete(txid);
    }
  }
}

function resolveEffectiveFeeRate(mempoolEntry: Awaited<ReturnType<MiningRpcClient["getMempoolEntry"]>>): number {
  return Number([
    mempoolEntry.vsize > 0 ? (numberToSats(mempoolEntry.fees.base) / BigInt(mempoolEntry.vsize)) : 0n,
    (mempoolEntry.ancestorsize ?? 0) > 0
      ? (numberToSats(mempoolEntry.fees.ancestor) / BigInt(mempoolEntry.ancestorsize ?? 1))
      : 0n,
    (mempoolEntry.descendantsize ?? 0) > 0
      ? (numberToSats(mempoolEntry.fees.descendant) / BigInt(mempoolEntry.descendantsize ?? 1))
      : 0n,
  ].reduce((best, candidate) => (candidate > best ? candidate : best), 0n));
}

function createContextFromRawTransaction(
  txid: string,
  tx: Awaited<ReturnType<MiningRpcClient["getRawTransaction"]>>,
): CachedRawMempoolTxContext | null {
  const payloadHex = tx.vout.find((entry) => entry.scriptPubKey?.hex?.startsWith("6a") === true)?.scriptPubKey?.hex;
  const payload = payloadHex === undefined ? null : Buffer.from(payloadHex, "hex");
  const decodedPayload = payload === null || payload.length < 2 || payload[0] !== 0x6a
    ? null
    : (() => {
      const opcode = payload[1];
      if (opcode === undefined) {
        return null;
      }
      if (opcode <= 75) {
        const end = 2 + opcode;
        return end === payload.length ? payload.subarray(2, end) : null;
      }
      if (opcode === 0x4c && payload.length >= 3) {
        const length = payload[2]!;
        const end = 3 + length;
        return end === payload.length ? payload.subarray(3, end) : null;
      }
      return null;
    })();

  if (
    decodedPayload === null
    || decodedPayload.length < 3
    || decodedPayload[0] !== COG_PREFIX[0]
    || decodedPayload[1] !== COG_PREFIX[1]
    || decodedPayload[2] !== COG_PREFIX[2]
  ) {
    return null;
  }

  return {
    txid,
    senderScriptHex: tx.vin[0]?.prevout?.scriptPubKey?.hex ?? null,
    inputTxids: tx.vin.map((input) => input.txid).filter((inputTxid): inputTxid is string => inputTxid !== undefined),
    payload: decodedPayload,
  };
}

async function warmMissingRawTxContexts(options: {
  rpc: MiningRpcClient;
  rawTxContexts: Map<string, CachedRawMempoolTxContext>;
  visibleTxids: readonly string[];
  cooperativeYield?: MiningCooperativeYield;
  cooperativeYieldEvery?: number;
  throwIfStopping?: () => void;
  onWarmupProgress?: (progress: MiningGateWarmupProgress) => Promise<void> | void;
}): Promise<void> {
  const missingTxids = options.visibleTxids.filter((txid) => !options.rawTxContexts.has(txid));
  if (missingTxids.length === 0) {
    return;
  }

  let completed = 0;
  let nextIndex = 0;
  let lastReportedProcessed = -1;
  let reportPromise = Promise.resolve();
  const reportProgress = async (processed: number, force = false): Promise<void> => {
    if (options.onWarmupProgress === undefined) {
      return;
    }

    if (!force && processed !== missingTxids.length && (processed % MINING_MEMPOOL_PROGRESS_REPORT_EVERY) !== 0) {
      return;
    }

    if (processed === lastReportedProcessed) {
      return;
    }

    lastReportedProcessed = processed;
    reportPromise = reportPromise.then(async () => {
      await options.onWarmupProgress?.({
        processed,
        total: missingTxids.length,
      });
    });
    await reportPromise;
  };

  await reportProgress(0, true);

  const workerCount = Math.min(MINING_MEMPOOL_RAW_TX_FETCH_CONCURRENCY, missingTxids.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const iteration = nextIndex;
      if (iteration >= missingTxids.length) {
        return;
      }
      nextIndex += 1;

      await maybeYieldDuringMempoolScan({
        iteration,
        cooperativeYield: options.cooperativeYield,
        cooperativeYieldEvery: options.cooperativeYieldEvery,
      });
      options.throwIfStopping?.();

      const txid = missingTxids[iteration]!;
      const tx = await options.rpc.getRawTransaction(txid, true).catch(() => null);
      options.throwIfStopping?.();

      if (tx !== null) {
        const context = createContextFromRawTransaction(txid, tx);
        if (context !== null) {
          options.rawTxContexts.set(txid, context);
        }
      }

      completed += 1;
      await reportProgress(completed, completed === missingTxids.length);
    }
  });

  await Promise.all(workers);
}

export function clearMiningGateCache(walletRootId: string | null | undefined): void {
  if (walletRootId === null || walletRootId === undefined) {
    miningGateCache.clear();
    return;
  }

  miningGateCache.delete(walletRootId);
}

function decodeMinePayload(payload: Uint8Array): {
  domainId: number;
  referencedBlockPrefixHex: string;
  sentenceBytes: Uint8Array;
} | null {
  if (payload.length < 68 || Buffer.from(payload.subarray(0, 3)).toString("utf8") !== "COG" || payload[3] !== 0x01) {
    return null;
  }

  return {
    domainId: Buffer.from(payload).readUInt32BE(4),
    referencedBlockPrefixHex: Buffer.from(payload.subarray(8, 12)).toString("hex"),
    sentenceBytes: payload.subarray(12, 72),
  };
}

function bytesToHex(value: Uint8Array | null | undefined): string | null {
  return value == null ? null : Buffer.from(value).toString("hex");
}

function readU32BE(bytes: Uint8Array, offset: number): number | null {
  if ((offset + 4) > bytes.length) {
    return null;
  }

  return Buffer.from(bytes.subarray(offset, offset + 4)).readUInt32BE(0);
}

function readLenPrefixedScriptHex(bytes: Uint8Array, offset: number): { scriptHex: string; nextOffset: number } | null {
  const length = bytes[offset];

  if (length === undefined || (offset + 1 + length) > bytes.length) {
    return null;
  }

  return {
    scriptHex: Buffer.from(bytes.subarray(offset + 1, offset + 1 + length)).toString("hex"),
    nextOffset: offset + 1 + length,
  };
}

function parseSupportedAncestorOperation(context: CachedRawMempoolTxContext): SupportedAncestorOperation | null | "unsupported" {
  const payload = context.payload;

  if (payload === null) {
    return null;
  }

  if (
    payload.length < 4
    || payload[0] !== COG_PREFIX[0]
    || payload[1] !== COG_PREFIX[1]
    || payload[2] !== COG_PREFIX[2]
  ) {
    return null;
  }

  const opcode = payload[3];

  if (opcode === COG_OPCODES.DOMAIN_REG) {
    const nameLength = payload[4];

    if (nameLength === undefined || (5 + nameLength) !== payload.length) {
      return "unsupported";
    }

    return {
      kind: "domain-reg",
      name: Buffer.from(payload.subarray(5, 5 + nameLength)).toString("utf8"),
      senderScriptHex: context.senderScriptHex,
    };
  }

  if (opcode === COG_OPCODES.DOMAIN_TRANSFER) {
    const domainId = readU32BE(payload, 4);
    const recipient = domainId === null ? null : readLenPrefixedScriptHex(payload, 8);

    if (domainId === null || recipient === null || recipient.nextOffset !== payload.length) {
      return "unsupported";
    }

    return {
      kind: "domain-transfer",
      domainId,
      recipientScriptHex: recipient.scriptHex,
      senderScriptHex: context.senderScriptHex,
    };
  }

  if (opcode === COG_OPCODES.DOMAIN_ANCHOR) {
    const domainId = readU32BE(payload, 4);

    if (domainId === null) {
      return "unsupported";
    }

    return {
      kind: "domain-anchor",
      domainId,
      senderScriptHex: context.senderScriptHex,
    };
  }

  if (opcode === COG_OPCODES.SET_DELEGATE || opcode === COG_OPCODES.SET_MINER) {
    const domainId = readU32BE(payload, 4);

    if (domainId === null) {
      return "unsupported";
    }

    if (payload.length === 8) {
      return opcode === COG_OPCODES.SET_DELEGATE
        ? { kind: "set-delegate", domainId, delegateScriptHex: null }
        : { kind: "set-miner", domainId, minerScriptHex: null };
    }

    const target = readLenPrefixedScriptHex(payload, 8);
    if (target === null || target.nextOffset !== payload.length) {
      return "unsupported";
    }

    return opcode === COG_OPCODES.SET_DELEGATE
      ? { kind: "set-delegate", domainId, delegateScriptHex: target.scriptHex }
      : { kind: "set-miner", domainId, minerScriptHex: target.scriptHex };
  }

  return "unsupported";
}

function getAncestorTxids(context: CachedRawMempoolTxContext, txContexts: Map<string, CachedRawMempoolTxContext>): string[] {
  return context.inputTxids.filter((txid) => txContexts.has(txid));
}

function topologicallyOrderAncestorContexts(options: {
  txid: string;
  txContexts: Map<string, CachedRawMempoolTxContext>;
}): CachedRawMempoolTxContext[] | null {
  const visited = new Map<string, "visiting" | "visited">();
  const ordered: CachedRawMempoolTxContext[] = [];
  const root = options.txContexts.get(options.txid);
  if (root === undefined) {
    return [];
  }

  const stack = getAncestorTxids(root, options.txContexts)
    .reverse()
    .map((txid) => ({
      txid,
      expanded: false,
    }));

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const state = visited.get(frame.txid);

    if (frame.expanded) {
      if (state !== "visiting") {
        continue;
      }

      visited.set(frame.txid, "visited");
      const context = options.txContexts.get(frame.txid);
      if (context !== undefined) {
        ordered.push(context);
      }
      continue;
    }

    if (state === "visited") {
      continue;
    }

    if (state === "visiting") {
      return null;
    }

    const context = options.txContexts.get(frame.txid);
    if (context === undefined) {
      continue;
    }

    visited.set(frame.txid, "visiting");
    stack.push({
      txid: frame.txid,
      expanded: true,
    });

    const parents = getAncestorTxids(context, options.txContexts);
    for (let index = parents.length - 1; index >= 0; index -= 1) {
      const parentTxid = parents[index]!;
      const parentState = visited.get(parentTxid);
      if (parentState === "visiting") {
        return null;
      }

      if (parentState !== "visited") {
        stack.push({
          txid: parentTxid,
          expanded: false,
        });
      }
    }
  }

  return ordered;
}

export function topologicallyOrderAncestorTxidsForTesting(options: {
  txid: string;
  txContexts: Map<string, {
    txid: string;
    rawTransaction: Awaited<ReturnType<MiningRpcClient["getRawTransaction"]>>;
  }>;
}): string[] | null {
  const txContexts = new Map([...options.txContexts].map(([txid, context]) => [txid, {
    txid: context.txid,
    senderScriptHex: null,
    inputTxids: context.rawTransaction.vin
      .map((vin) => vin.txid)
      .filter((inputTxid): inputTxid is string => inputTxid !== undefined),
    payload: null,
  } satisfies CachedRawMempoolTxContext]));
  const ordered = topologicallyOrderAncestorContexts({
    txid: options.txid,
    txContexts,
  });
  return ordered?.map((context) => context.txid) ?? null;
}

function cloneOverlayDomainFromConfirmed(
  readContext: WalletReadContext & { snapshot: NonNullable<WalletReadContext["snapshot"]> },
  domainId: number,
): OverlayDomainState | null {
  const domain = lookupDomainById(readContext.snapshot.state, domainId);

  if (domain === null) {
    return null;
  }

  return {
    domainId,
    name: domain.name,
    anchored: domain.anchored,
    ownerScriptHex: bytesToHex(domain.ownerScriptPubKey),
    delegateScriptHex: bytesToHex(domain.delegate),
    minerScriptHex: bytesToHex(domain.miner),
  };
}

function applySupportedAncestorOperation(options: {
  readContext: WalletReadContext & { snapshot: NonNullable<WalletReadContext["snapshot"]> };
  overlay: Map<number, OverlayDomainState>;
  nextDomainId: number;
  operation: SupportedAncestorOperation;
}): { nextDomainId: number; indeterminate: boolean } {
  const ensureDomain = (domainId: number): OverlayDomainState | null => {
    const existing = options.overlay.get(domainId);
    if (existing !== undefined) {
      return existing;
    }

    const confirmed = cloneOverlayDomainFromConfirmed(options.readContext, domainId);
    if (confirmed === null) {
      return null;
    }

    options.overlay.set(domainId, confirmed);
    return confirmed;
  };

  if (options.operation.kind === "domain-reg") {
    if (!rootDomain(options.operation.name)) {
      return { nextDomainId: options.nextDomainId, indeterminate: true };
    }

    if (lookupDomain(options.readContext.snapshot.state, options.operation.name) !== null) {
      return { nextDomainId: options.nextDomainId, indeterminate: true };
    }

    options.overlay.set(options.nextDomainId, {
      domainId: options.nextDomainId,
      name: options.operation.name,
      anchored: false,
      ownerScriptHex: options.operation.senderScriptHex,
      delegateScriptHex: null,
      minerScriptHex: null,
    });
    return {
      nextDomainId: options.nextDomainId + 1,
      indeterminate: false,
    };
  }

  const domain = ensureDomain(options.operation.domainId);
  if (domain === null) {
    return { nextDomainId: options.nextDomainId, indeterminate: true };
  }

  if (options.operation.kind === "domain-transfer") {
    domain.ownerScriptHex = options.operation.recipientScriptHex;
    options.overlay.set(domain.domainId, domain);
    return { nextDomainId: options.nextDomainId, indeterminate: false };
  }

  if (options.operation.kind === "domain-anchor") {
    domain.anchored = true;
    if (options.operation.senderScriptHex !== null) {
      domain.ownerScriptHex = options.operation.senderScriptHex;
    }
    options.overlay.set(domain.domainId, domain);
    return { nextDomainId: options.nextDomainId, indeterminate: false };
  }

  if (options.operation.kind === "set-delegate") {
    domain.delegateScriptHex = options.operation.delegateScriptHex;
    options.overlay.set(domain.domainId, domain);
    return { nextDomainId: options.nextDomainId, indeterminate: false };
  }

  domain.minerScriptHex = options.operation.minerScriptHex;
  options.overlay.set(domain.domainId, domain);
  return { nextDomainId: options.nextDomainId, indeterminate: false };
}

async function resolveOverlayAuthorizedMiningDomain(options: {
  readContext: WalletReadContext & { snapshot: NonNullable<WalletReadContext["snapshot"]> };
  txid: string;
  txContexts: Map<string, CachedRawMempoolTxContext>;
  domainId: number;
  senderScriptHex: string;
}): Promise<OverlayDomainState | "indeterminate" | null> {
  const orderedAncestors = topologicallyOrderAncestorContexts({
    txid: options.txid,
    txContexts: options.txContexts,
  });

  if (orderedAncestors === null) {
    return "indeterminate";
  }

  const overlay = new Map<number, OverlayDomainState>();
  let nextDomainId = options.readContext.snapshot.state.consensus.nextDomainId;

  for (const ancestor of orderedAncestors) {
    const parsed = parseSupportedAncestorOperation(ancestor);

    if (parsed === "unsupported") {
      return "indeterminate";
    }

    if (parsed === null) {
      continue;
    }

    const applied = applySupportedAncestorOperation({
      readContext: options.readContext,
      overlay,
      nextDomainId,
      operation: parsed,
    });
    nextDomainId = applied.nextDomainId;

    if (applied.indeterminate) {
      return "indeterminate";
    }
  }

  const domain = overlay.get(options.domainId) ?? cloneOverlayDomainFromConfirmed(options.readContext, options.domainId);
  if (domain === null || domain.name === null || !rootDomain(domain.name) || !domain.anchored) {
    return null;
  }

  const authorized = domain.ownerScriptHex === options.senderScriptHex
    || domain.delegateScriptHex === options.senderScriptHex
    || domain.minerScriptHex === options.senderScriptHex;
  return authorized ? domain : null;
}

function isBetterVisibleCompetitor(candidate: CachedCompetitorEntry, current: CachedCompetitorEntry | undefined): boolean {
  if (current === undefined) {
    return true;
  }

  if (candidate.canonicalBlend !== current.canonicalBlend) {
    return candidate.canonicalBlend > current.canonicalBlend;
  }

  if (candidate.effectiveFeeRate !== current.effectiveFeeRate) {
    return candidate.effectiveFeeRate > current.effectiveFeeRate;
  }

  return candidate.txid.localeCompare(current.txid) < 0;
}

function rankMiningSentenceEntries(
  entries: RankedMiningSentenceEntry[],
  blendSeed: Uint8Array,
): Array<RankedMiningSentenceEntry & { rank: number; tieBreak: Uint8Array }> {
  return entries
    .map((entry) => ({
      ...entry,
      tieBreak: tieBreakHash(blendSeed, entry.domainId),
    }))
    .sort((left, right) => {
      if (left.canonicalBlend !== right.canonicalBlend) {
        return left.canonicalBlend > right.canonicalBlend ? -1 : 1;
      }

      const tieBreakOrder = compareLexicographically(left.tieBreak, right.tieBreak);
      if (tieBreakOrder !== 0) {
        return tieBreakOrder;
      }

      return left.txIndex - right.txIndex;
    })
    .map((entry, index) => ({
      ...entry,
      rank: index + 1,
    }));
}

function toSentenceBoardEntries(
  entries: Array<{ rank: number; domainName: string; sentence: string; bip39WordIndices?: readonly number[] }>,
): MiningSentenceBoardEntry[] {
  return entries.slice(0, 5).map((entry) => ({
    rank: entry.rank,
    domainName: entry.domainName,
    sentence: entry.sentence,
    requiredWords: resolveBip39WordsFromIndices(entry.bip39WordIndices),
  }));
}

async function fetchIndexedMempoolEntries(options: {
  rpc: Pick<MiningRpcClient, "getMempoolEntry">;
  txids: readonly string[];
  throwIfStopping?: () => void;
}): Promise<Awaited<ReturnType<MiningRpcClient["getRawMempoolEntries"]>> | null> {
  const entries: Awaited<ReturnType<MiningRpcClient["getRawMempoolEntries"]>> = {};
  let nextIndex = 0;
  const workerCount = Math.min(MINING_MEMPOOL_RAW_TX_FETCH_CONCURRENCY, options.txids.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      if (index >= options.txids.length) {
        return;
      }
      nextIndex += 1;

      options.throwIfStopping?.();
      const txid = options.txids[index]!;
      const entry = await options.rpc.getMempoolEntry(txid).catch(() => null);
      options.throwIfStopping?.();
      if (entry === null) {
        throw new Error("mining_mempool_index_entry_unavailable");
      }
      entries[txid] = entry;
    }
  });

  try {
    await Promise.all(workers);
    return entries;
  } catch {
    return null;
  }
}

export async function runCompetitivenessGate(options: {
  rpc: MiningRpcClient;
  readContext: WalletReadContext & {
    snapshot: NonNullable<WalletReadContext["snapshot"]>;
  };
  candidate: MiningCandidate;
  currentTxid: string | null;
  assaySentencesImpl?: typeof assaySentences;
  cooperativeYield?: MiningCooperativeYield;
  cooperativeYieldEvery?: number;
  throwIfStopping?: () => void;
  onWarmupProgress?: (progress: MiningGateWarmupProgress) => Promise<void> | void;
  ensureCandidateFresh?: (checkpoint: MiningScoringFreshnessCheckpoint, options?: { force?: boolean }) => Promise<void>;
  onEvaluationStage?: (stage: MiningGateEvaluationStage) => Promise<void> | void;
  runId?: string | null;
  appendEvent?: (event: MiningEventRecord) => Promise<void> | void;
  mempoolIndex?: {
    rawTxSupported: boolean;
    cachePath: string;
    serviceIdentity: string;
  };
}): Promise<CompetitivenessDecision> {
  let visibleMempoolTxCount: number | null = null;
  let indexedContextCount: number | null = null;
  let negativeTxCount: number | null = null;
  let unknownTxCount: number | null = null;
  let hydratedTxCount: number | null = null;
  let mempoolEntryCount: number | null = null;
  let missingEntryCount: number | null = null;
  let mempoolSequenceForDiagnostics: string | null = null;
  let cacheStatusForDiagnostics: CompetitivenessDecision["mempoolSequenceCacheStatus"] = null;
  const createDiagnostics = (overrides: Partial<CompetitivenessDecision["diagnostics"]> = {}): CompetitivenessDecision["diagnostics"] => ({
    visibleMempoolTxCount: overrides.visibleMempoolTxCount ?? visibleMempoolTxCount,
    indexedContextCount: overrides.indexedContextCount ?? indexedContextCount,
    negativeTxCount: overrides.negativeTxCount ?? negativeTxCount,
    unknownTxCount: overrides.unknownTxCount ?? unknownTxCount,
    hydratedTxCount: overrides.hydratedTxCount ?? hydratedTxCount,
    mempoolEntryCount: overrides.mempoolEntryCount ?? mempoolEntryCount,
    missingEntryCount: overrides.missingEntryCount ?? missingEntryCount,
    cacheStatus: overrides.cacheStatus ?? cacheStatusForDiagnostics,
    mempoolSequence: overrides.mempoolSequence ?? mempoolSequenceForDiagnostics,
    candidateRank: overrides.candidateRank ?? null,
    higherRankedCompetitorDomainCount: overrides.higherRankedCompetitorDomainCount ?? null,
    dedupedCompetitorDomainCount: overrides.dedupedCompetitorDomainCount ?? null,
  });
  const createDecision = (overrides: Partial<CompetitivenessDecision>): CompetitivenessDecision => ({
    allowed: overrides.allowed ?? false,
    decision: overrides.decision ?? "indeterminate-mempool-gate",
    sameDomainCompetitorSuppressed: overrides.sameDomainCompetitorSuppressed ?? false,
    higherRankedCompetitorDomainCount: overrides.higherRankedCompetitorDomainCount ?? 0,
    dedupedCompetitorDomainCount: overrides.dedupedCompetitorDomainCount ?? 0,
    competitivenessGateIndeterminate: overrides.competitivenessGateIndeterminate ?? false,
    indeterminateReason: overrides.indeterminateReason ?? null,
    diagnostics: overrides.diagnostics ?? createDiagnostics({
      cacheStatus: overrides.mempoolSequenceCacheStatus ?? cacheStatusForDiagnostics,
      mempoolSequence: overrides.lastMempoolSequence ?? mempoolSequenceForDiagnostics,
      candidateRank: overrides.candidateRank ?? null,
      higherRankedCompetitorDomainCount: overrides.higherRankedCompetitorDomainCount ?? null,
      dedupedCompetitorDomainCount: overrides.dedupedCompetitorDomainCount ?? null,
    }),
    mempoolSequenceCacheStatus: overrides.mempoolSequenceCacheStatus ?? null,
    lastMempoolSequence: overrides.lastMempoolSequence ?? null,
    visibleBoardEntries: overrides.visibleBoardEntries ?? [],
    candidateRank: overrides.candidateRank ?? null,
  });
  const walletRootId = options.readContext.localState.walletRootId ?? "uninitialized-wallet-root";
  const assaySentencesImpl = options.assaySentencesImpl ?? assaySentences;
  const ensureCandidateFresh = async (
    checkpoint: MiningScoringFreshnessCheckpoint,
    freshnessOptions: { force?: boolean } = {},
  ): Promise<void> => {
    await options.ensureCandidateFresh?.(checkpoint, freshnessOptions);
  };
  const noteEvaluationStage = async (stage: MiningGateEvaluationStage): Promise<void> => {
    await options.onEvaluationStage?.(stage);
  };
  const indexerTruthKey = getIndexerTruthKey(
    options.readContext as WalletReadContext & {
      localState: { availability: "ready"; state: WalletStateV1 };
      snapshot: NonNullable<WalletReadContext["snapshot"]>;
    },
  );
  const excludedTxids = [options.currentTxid].filter((value): value is string => value !== null).sort();
  let localAssayTupleKey: string;
  try {
    localAssayTupleKey = [
      options.candidate.domainId,
      Buffer.from(options.candidate.encodedSentenceBytes).toString("hex"),
      options.candidate.canonicalBlend.toString(),
      options.candidate.sender.scriptPubKeyHex,
    ].join(":");
  } catch {
    return createDecision({
      allowed: false,
      decision: "indeterminate-mempool-gate",
      indeterminateReason: "rank_evaluation_failed",
      competitivenessGateIndeterminate: true,
    });
  }
  const cacheState = getOrCreateMiningGateCacheState(walletRootId);
  const setDecisionReuse = (decision: CompetitivenessDecision): void => {
    cacheState.decisionReuse = {
      indexerDaemonInstanceId: indexerTruthKey?.daemonInstanceId ?? "none",
      indexerSnapshotSeq: indexerTruthKey?.snapshotSeq ?? "none",
      referencedBlockHashDisplay: options.candidate.referencedBlockHashDisplay,
      localAssayTupleKey,
      excludedTxidsKey: excludedTxids.join(","),
      mempoolSequence,
      decision,
    };
  };

  let mempoolVerbose: Awaited<ReturnType<MiningRpcClient["getRawMempoolVerbose"]>>;
  try {
    mempoolVerbose = await options.rpc.getRawMempoolVerbose();
    options.throwIfStopping?.();
  } catch {
    return createDecision({
      competitivenessGateIndeterminate: true,
      indeterminateReason: "raw_mempool_verbose_unavailable",
    });
  }

  let mempoolSequence = String(mempoolVerbose.mempool_sequence);
  mempoolSequenceForDiagnostics = mempoolSequence;
  await ensureCandidateFresh("mempool-verbose-loaded", { force: true });
  const cached = cacheState.decisionReuse;
  const cachedTruthMatches = cached !== null
    && indexerTruthKey !== null
    && cached.indexerDaemonInstanceId === indexerTruthKey.daemonInstanceId
    && cached.indexerSnapshotSeq === indexerTruthKey.snapshotSeq;
  const cachedReferencedBlockMatches = cached !== null
    && cached.referencedBlockHashDisplay === options.candidate.referencedBlockHashDisplay;

  if (cached !== null && (!cachedTruthMatches || !cachedReferencedBlockMatches)) {
    cacheState.decisionReuse = null;
  }

  if (
    cached !== null
    && cachedTruthMatches
    && cachedReferencedBlockMatches
    && cached.localAssayTupleKey === localAssayTupleKey
    && cached.excludedTxidsKey === excludedTxids.join(",")
    && cached.mempoolSequence === mempoolSequence
  ) {
    await ensureCandidateFresh("decision-complete", { force: true });
    return {
      ...cached.decision,
      mempoolSequenceCacheStatus: "reused",
      diagnostics: {
        ...cached.decision.diagnostics,
        cacheStatus: "reused",
      },
    };
  }

  const referencedPrefix = Buffer.from(options.candidate.referencedBlockHashInternal.subarray(0, 4)).toString("hex");
  let visibleTxids = mempoolVerbose.txids.filter((txid) => !excludedTxids.includes(txid));
  visibleMempoolTxCount = visibleTxids.length;
  let rawTxContexts: Map<string, CachedRawMempoolTxContext>;
  let mempoolEntries: Awaited<ReturnType<MiningRpcClient["getRawMempoolEntries"]>>;
  let gateCacheStatus: MiningMempoolGateCacheStatus = "refreshed";
  let indexedEntryFailure = false;
  const applyIndexDiagnostics = (diagnostics: MiningMempoolIndexHydrationDiagnostics): void => {
    gateCacheStatus = diagnostics.cacheStatus;
    cacheStatusForDiagnostics = diagnostics.cacheStatus;
    indexedContextCount = diagnostics.indexedContextCount;
    negativeTxCount = diagnostics.negativeTxidCount;
    unknownTxCount = diagnostics.unknownTxidCount;
    hydratedTxCount = diagnostics.hydratedCount;
  };
  const createMempoolIndexHydrationIncompleteDecision = (): CompetitivenessDecision => createDecision({
    competitivenessGateIndeterminate: true,
    decision: "indeterminate-mempool-gate",
    indeterminateReason: "mempool_index_hydration_incomplete",
    mempoolSequenceCacheStatus: "index-warming",
    lastMempoolSequence: mempoolSequence,
  });
  const appendTimingEvent = async (
    kind: string,
    message: string,
    eventOptions: Partial<MiningEventRecord>,
  ): Promise<void> => {
    if (options.appendEvent === undefined) {
      return;
    }

    try {
      await options.appendEvent(createMiningEventRecord(kind, message, eventOptions));
    } catch {
      // Timing telemetry must not alter gate behavior.
    }
  };
  const hydrationMetrics = (
    attempt: string,
    attemptVisibleTxids: readonly string[],
    sequence: string | null,
    diagnostics: MiningMempoolIndexHydrationDiagnostics | null,
    outcome: string,
  ): MiningEventRecord["metrics"] => ({
    outcome,
    attempt,
    visibleMempoolTxCount: attemptVisibleTxids.length,
    indexedContextCount: diagnostics?.indexedContextCount ?? null,
    negativeTxCount: diagnostics?.negativeTxidCount ?? null,
    unknownTxCount: diagnostics?.unknownTxidCount ?? null,
    hydratedTxCount: diagnostics?.hydratedCount ?? null,
    cacheStatus: diagnostics?.cacheStatus ?? null,
    mempoolSequence: sequence,
  });
  const hydrateIndexWithTiming = async (
    attempt: "primary" | "retry",
    attemptVisibleTxids: readonly string[],
    sequence: string,
  ): Promise<Awaited<ReturnType<typeof hydrateMiningMempoolIndex>>> => {
    await ensureCandidateFresh("mempool-hydration-start", { force: true });
    await appendTimingEvent(
      "timing-mempool-hydration-start",
      "Started mining mempool index hydration.",
      {
        runId: options.runId ?? null,
        targetBlockHeight: options.candidate.targetBlockHeight,
        referencedBlockHashDisplay: options.candidate.referencedBlockHashDisplay,
        domainId: options.candidate.domainId,
        domainName: options.candidate.domainName,
        score: options.candidate.canonicalBlend.toString(),
        metrics: {
          outcome: "started",
          attempt,
          visibleMempoolTxCount: attemptVisibleTxids.length,
          mempoolSequence: sequence,
        },
      },
    );
    const startedAt = performance.now();
    try {
      const result = await hydrateMiningMempoolIndex({
        walletRootId,
        serviceIdentity: options.mempoolIndex!.serviceIdentity,
        cachePath: options.mempoolIndex!.cachePath,
        rpc: options.rpc,
        visibleTxids: attemptVisibleTxids,
        cooperativeYield: options.cooperativeYield,
        cooperativeYieldEvery: options.cooperativeYieldEvery,
        throwIfStopping: options.throwIfStopping,
        onWarmupProgress: options.onWarmupProgress,
      });
      await ensureCandidateFresh("mempool-hydration-complete", { force: true });
      await noteEvaluationStage("mempool-hydrated");
      await appendTimingEvent(
        "timing-mempool-hydration-end",
        "Finished mining mempool index hydration.",
        {
          runId: options.runId ?? null,
          targetBlockHeight: options.candidate.targetBlockHeight,
          referencedBlockHashDisplay: options.candidate.referencedBlockHashDisplay,
          domainId: options.candidate.domainId,
          domainName: options.candidate.domainName,
          score: options.candidate.canonicalBlend.toString(),
          durationMs: performance.now() - startedAt,
          metrics: hydrationMetrics(attempt, attemptVisibleTxids, sequence, result, "success"),
        },
      );
      return result;
    } catch (error) {
      const diagnostics = error instanceof MiningMempoolIndexHydrationIncompleteError
        ? error.diagnostics
        : null;
      await appendTimingEvent(
        "timing-mempool-hydration-end",
        "Finished mining mempool index hydration.",
        {
          level: "warn",
          runId: options.runId ?? null,
          targetBlockHeight: options.candidate.targetBlockHeight,
          referencedBlockHashDisplay: options.candidate.referencedBlockHashDisplay,
          domainId: options.candidate.domainId,
          domainName: options.candidate.domainName,
          score: options.candidate.canonicalBlend.toString(),
          durationMs: performance.now() - startedAt,
          metrics: {
            ...hydrationMetrics(
              attempt,
              attemptVisibleTxids,
              sequence,
              diagnostics,
              error instanceof MiningMempoolIndexHydrationIncompleteError ? "incomplete" : "error",
            ),
            errorName: error instanceof Error ? error.name : "unknown",
          },
        },
      );
      throw error;
    }
  };

  if (options.mempoolIndex?.rawTxSupported === true) {
    let indexed: Awaited<ReturnType<typeof hydrateMiningMempoolIndex>>;
    try {
      indexed = await hydrateIndexWithTiming("primary", visibleTxids, mempoolSequence);
    } catch (error) {
      if (isMiningScoringAttemptStaleError(error)) {
        throw error;
      }
      if (!(error instanceof MiningMempoolIndexHydrationIncompleteError)) {
        return createMempoolIndexHydrationIncompleteDecision();
      }
      applyIndexDiagnostics(error.diagnostics);

      const refreshedMempoolVerbose = await options.rpc.getRawMempoolVerbose().catch(() => null);
      options.throwIfStopping?.();
      if (refreshedMempoolVerbose === null) {
        return createMempoolIndexHydrationIncompleteDecision();
      }

      mempoolVerbose = refreshedMempoolVerbose;
      mempoolSequence = String(refreshedMempoolVerbose.mempool_sequence);
      mempoolSequenceForDiagnostics = mempoolSequence;
      visibleTxids = refreshedMempoolVerbose.txids.filter((txid) => !excludedTxids.includes(txid));
      visibleMempoolTxCount = visibleTxids.length;

      try {
        indexed = await hydrateIndexWithTiming("retry", visibleTxids, mempoolSequence);
      } catch (retryError) {
        if (isMiningScoringAttemptStaleError(retryError)) {
          throw retryError;
        }
        if (retryError instanceof MiningMempoolIndexHydrationIncompleteError) {
          applyIndexDiagnostics(retryError.diagnostics);
        }
        return createMempoolIndexHydrationIncompleteDecision();
      }
    }

    rawTxContexts = indexed.contexts;
    applyIndexDiagnostics(indexed);
    const indexedTxids = visibleTxids.filter((txid) => rawTxContexts.has(txid));
    await ensureCandidateFresh("mempool-entry-fetch-start", { force: true });
    const indexedEntries = await fetchIndexedMempoolEntries({
      rpc: options.rpc,
      txids: indexedTxids,
      throwIfStopping: options.throwIfStopping,
    });

    if (indexedEntries === null) {
      rawTxContexts = new Map();
      mempoolEntries = {};
      gateCacheStatus = "fallback-scan";
      cacheStatusForDiagnostics = gateCacheStatus;
      indexedEntryFailure = true;
    } else {
      mempoolEntries = indexedEntries;
      mempoolEntryCount = Object.keys(mempoolEntries).length;
      missingEntryCount = Math.max(0, indexedTxids.length - mempoolEntryCount);
    }
  } else {
    rawTxContexts = cacheState.rawTxContexts;
    gateCacheStatus = options.mempoolIndex?.rawTxSupported === false ? "fallback-scan" : "refreshed";
    cacheStatusForDiagnostics = gateCacheStatus;
    const fallbackEntries = await options.rpc.getRawMempoolEntries().catch(() => null);
    if (fallbackEntries === null) {
      return createDecision({
        competitivenessGateIndeterminate: true,
        indeterminateReason: "raw_mempool_entries_unavailable",
      });
    }
    mempoolEntries = fallbackEntries;
    mempoolEntryCount = Object.keys(mempoolEntries).length;
    missingEntryCount = Math.max(0, visibleTxids.length - mempoolEntryCount);
    pruneRawTxContextsToVisibleTxids({
      rawTxContexts,
      visibleTxids,
    });
    await warmMissingRawTxContexts({
      rpc: options.rpc,
      rawTxContexts,
      visibleTxids,
      cooperativeYield: options.cooperativeYield,
      cooperativeYieldEvery: options.cooperativeYieldEvery,
      throwIfStopping: options.throwIfStopping,
      onWarmupProgress: options.onWarmupProgress,
    });
    await ensureCandidateFresh("mempool-hydration-complete", { force: true });
    await noteEvaluationStage("mempool-hydrated");
    indexedContextCount = rawTxContexts.size;
    negativeTxCount = null;
    unknownTxCount = Math.max(0, visibleTxids.length - rawTxContexts.size);
    hydratedTxCount = rawTxContexts.size;
  }

  if (gateCacheStatus === "fallback-scan" && rawTxContexts.size === 0 && Object.keys(mempoolEntries).length === 0) {
    const fallbackEntries = await options.rpc.getRawMempoolEntries().catch(() => null);
    if (fallbackEntries === null) {
      return createDecision({
        competitivenessGateIndeterminate: true,
        indeterminateReason: indexedEntryFailure ? "indexed_mempool_entry_unavailable" : "raw_mempool_entries_unavailable",
      });
    }
    mempoolEntries = fallbackEntries;
    mempoolEntryCount = Object.keys(mempoolEntries).length;
    missingEntryCount = Math.max(0, visibleTxids.length - mempoolEntryCount);
    rawTxContexts = cacheState.rawTxContexts;
    pruneRawTxContextsToVisibleTxids({
      rawTxContexts,
      visibleTxids,
    });
    await warmMissingRawTxContexts({
      rpc: options.rpc,
      rawTxContexts,
      visibleTxids,
      cooperativeYield: options.cooperativeYield,
      cooperativeYieldEvery: options.cooperativeYieldEvery,
      throwIfStopping: options.throwIfStopping,
      onWarmupProgress: options.onWarmupProgress,
    });
    await ensureCandidateFresh("mempool-hydration-complete", { force: true });
    await noteEvaluationStage("mempool-hydrated");
    indexedContextCount = rawTxContexts.size;
    negativeTxCount = null;
    unknownTxCount = Math.max(0, visibleTxids.length - rawTxContexts.size);
    hydratedTxCount = rawTxContexts.size;
  }

  const entries = new Map<string, CachedCompetitorEntry>();
  await ensureCandidateFresh("competitor-scan", { force: true });
  await noteEvaluationStage("evaluating-competitors");
  for (let index = 0; index < visibleTxids.length; index += 1) {
    await maybeYieldDuringMempoolScan({
      iteration: index,
      cooperativeYield: options.cooperativeYield,
      cooperativeYieldEvery: options.cooperativeYieldEvery,
    });
    await ensureCandidateFresh("competitor-scan");
    options.throwIfStopping?.();
    const txid = visibleTxids[index]!;
    const context = rawTxContexts.get(txid);
    const mempoolEntry = mempoolEntries[txid];

    if (context === undefined || context.payload === null || context.senderScriptHex === null || mempoolEntry === undefined) {
      continue;
    }

    const decoded = decodeMinePayload(context.payload);
    if (decoded === null || decoded.referencedBlockPrefixHex !== referencedPrefix) {
      continue;
    }

    const overlayDomain = await resolveOverlayAuthorizedMiningDomain({
      readContext: options.readContext,
      txid,
      txContexts: rawTxContexts,
      domainId: decoded.domainId,
      senderScriptHex: context.senderScriptHex,
    });
    options.throwIfStopping?.();
    if (overlayDomain === "indeterminate") {
      const decision = createDecision({
        competitivenessGateIndeterminate: true,
        decision: "indeterminate-mempool-gate",
        indeterminateReason: "unsupported_ancestor_overlay",
        mempoolSequenceCacheStatus: gateCacheStatus,
        lastMempoolSequence: mempoolSequence,
      });
      setDecisionReuse(decision);
      return decision;
    }

    if (overlayDomain === null || overlayDomain.name === null || !rootDomain(overlayDomain.name)) {
      continue;
    }

    const assayed = await assaySentencesImpl(
      decoded.domainId,
      options.candidate.referencedBlockHashInternal,
      [Buffer.from(decoded.sentenceBytes).toString("utf8")],
    ).catch(() => []);
    options.throwIfStopping?.();
    const scored = assayed[0];
    if (scored === undefined || !scored.gatesPass || scored.encodedSentenceBytes === null || scored.canonicalBlend === null) {
      continue;
    }

    entries.set(txid, {
      txid,
      effectiveFeeRate: resolveEffectiveFeeRate(mempoolEntry),
      domainId: decoded.domainId,
      domainName: overlayDomain.name,
      sentence: Buffer.from(decoded.sentenceBytes).toString("utf8"),
      senderScriptHex: context.senderScriptHex,
      encodedSentenceBytesHex: Buffer.from(scored.encodedSentenceBytes).toString("hex"),
      bip39WordIndices: [...scored.bip39WordIndices],
      canonicalBlend: scored.canonicalBlend,
    });
  }
  await ensureCandidateFresh("competitor-scan-complete", { force: true });

  const blendSeed = deriveBlendSeed(options.candidate.referencedBlockHashInternal);
  const visibleBestByDomain = new Map<number, CachedCompetitorEntry>();
  for (const entry of entries.values()) {
    const current = visibleBestByDomain.get(entry.domainId);

    if (isBetterVisibleCompetitor(entry, current)) {
      visibleBestByDomain.set(entry.domainId, entry);
    }
  }

  const visibleRankedEntries = rankMiningSentenceEntries(
    [...visibleBestByDomain.values()]
      .sort((left, right) => left.domainId - right.domainId || left.txid.localeCompare(right.txid))
      .map((entry, index) => ({
        domainId: entry.domainId,
        domainName: entry.domainName,
        sentence: entry.sentence,
        canonicalBlend: entry.canonicalBlend,
        senderScriptHex: entry.senderScriptHex,
        encodedSentenceBytesHex: entry.encodedSentenceBytesHex,
        bip39WordIndices: entry.bip39WordIndices,
        txid: entry.txid,
        txIndex: index,
      })),
    blendSeed,
  );
  const sameDomainCompetitors = [...visibleBestByDomain.values()].filter((entry) => entry.domainId === options.candidate.domainId);
  const sameDomainCompetitorSuppressed = sameDomainCompetitors.some((competitor) =>
    competitor.canonicalBlend > options.candidate.canonicalBlend
    || competitor.canonicalBlend === options.candidate.canonicalBlend,
  );

  let decision: CompetitivenessDecision;
  const otherDomainBest = new Map<number, CachedCompetitorEntry>();
  for (const entry of visibleBestByDomain.values()) {
    if (entry.domainId === options.candidate.domainId) {
      continue;
    }

    const best = otherDomainBest.get(entry.domainId);
    if (isBetterVisibleCompetitor(entry, best)) {
      otherDomainBest.set(entry.domainId, entry);
    }
  }

  if (sameDomainCompetitorSuppressed) {
    await ensureCandidateFresh("rank-evaluation-start", { force: true });
    decision = createDecision({
      allowed: false,
      decision: "suppressed-same-domain-mempool",
      sameDomainCompetitorSuppressed: true,
      higherRankedCompetitorDomainCount: 1,
      dedupedCompetitorDomainCount: otherDomainBest.size,
      competitivenessGateIndeterminate: false,
      mempoolSequenceCacheStatus: gateCacheStatus,
      lastMempoolSequence: mempoolSequence,
      visibleBoardEntries: toSentenceBoardEntries(visibleRankedEntries),
    });
  } else {
    try {
      await ensureCandidateFresh("rank-evaluation-start", { force: true });
      const candidateRankedEntries = rankMiningSentenceEntries([
        {
          domainId: options.candidate.domainId,
          domainName: options.candidate.domainName,
          sentence: options.candidate.sentence,
          canonicalBlend: options.candidate.canonicalBlend,
          senderScriptHex: options.candidate.sender.scriptPubKeyHex,
          encodedSentenceBytesHex: Buffer.from(options.candidate.encodedSentenceBytes).toString("hex"),
          bip39WordIndices: options.candidate.bip39WordIndices,
          txid: null,
          txIndex: 0,
        },
        ...[...otherDomainBest.values()]
          .sort((left, right) => left.domainId - right.domainId || left.txid.localeCompare(right.txid))
          .map((entry, index) => ({
            domainId: entry.domainId,
            domainName: entry.domainName,
            sentence: entry.sentence,
            canonicalBlend: entry.canonicalBlend,
            senderScriptHex: entry.senderScriptHex,
            encodedSentenceBytesHex: entry.encodedSentenceBytesHex,
            bip39WordIndices: entry.bip39WordIndices,
            txid: entry.txid,
            txIndex: index + 1,
          })),
      ], blendSeed);
      const localEntry = candidateRankedEntries.find((entry) => entry.txid === null) ?? null;
      const candidateRank = localEntry?.rank ?? null;
      const higherRankedCompetitorDomainCount = candidateRank === null ? 0 : Math.max(0, candidateRank - 1);

      if (candidateRank !== null && candidateRank > 5) {
        decision = createDecision({
          allowed: false,
          decision: "suppressed-top5-mempool",
          sameDomainCompetitorSuppressed: false,
          higherRankedCompetitorDomainCount,
          dedupedCompetitorDomainCount: otherDomainBest.size,
          competitivenessGateIndeterminate: false,
          mempoolSequenceCacheStatus: gateCacheStatus,
          lastMempoolSequence: mempoolSequence,
          visibleBoardEntries: toSentenceBoardEntries(visibleRankedEntries),
          candidateRank,
        });
      } else {
        decision = createDecision({
          allowed: candidateRank !== null,
          decision: "publish",
          sameDomainCompetitorSuppressed: false,
          higherRankedCompetitorDomainCount,
          dedupedCompetitorDomainCount: otherDomainBest.size,
          competitivenessGateIndeterminate: false,
          mempoolSequenceCacheStatus: gateCacheStatus,
          lastMempoolSequence: mempoolSequence,
          visibleBoardEntries: toSentenceBoardEntries(visibleRankedEntries),
          candidateRank,
        });
      }
    } catch (error) {
      if (isMiningScoringAttemptStaleError(error)) {
        throw error;
      }
      decision = createDecision({
        allowed: false,
        decision: "indeterminate-mempool-gate",
        indeterminateReason: "rank_evaluation_failed",
        sameDomainCompetitorSuppressed: false,
        higherRankedCompetitorDomainCount: 0,
        dedupedCompetitorDomainCount: otherDomainBest.size,
        competitivenessGateIndeterminate: true,
        mempoolSequenceCacheStatus: gateCacheStatus,
        lastMempoolSequence: mempoolSequence,
        visibleBoardEntries: toSentenceBoardEntries(visibleRankedEntries),
      });
    }
  }

  await ensureCandidateFresh("decision-complete", { force: true });
  setDecisionReuse(decision);

  return decision;
}
