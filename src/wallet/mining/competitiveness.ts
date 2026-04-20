import { createHash } from "node:crypto";

import { assaySentences, deriveBlendSeed } from "@cogcoin/scoring";
import { lookupDomain, lookupDomainById } from "@cogcoin/indexer/queries";
import { COG_OPCODES, COG_PREFIX } from "../cogop/constants.js";
import { extractOpReturnPayloadFromScriptHex } from "../tx/register.js";
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
import { getIndexerTruthKey } from "./candidate.js";

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

interface CachedMempoolTxContext {
  txid: string;
  effectiveFeeRate: number;
  senderScriptHex: string | null;
  rawTransaction: Awaited<ReturnType<MiningRpcClient["getRawTransaction"]>>;
  payload: Uint8Array | null;
}

interface MiningCompetitivenessCacheRecord {
  indexerDaemonInstanceId: string;
  indexerSnapshotSeq: string;
  referencedBlockHashDisplay: string;
  localAssayTupleKey: string;
  excludedTxidsKey: string;
  mempoolSequence: string;
  txids: string[];
  txContexts: Map<string, CachedMempoolTxContext>;
  decision: CompetitivenessDecision;
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
const miningGateCache = new Map<string, MiningCompetitivenessCacheRecord>();

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

function parseSupportedAncestorOperation(context: CachedMempoolTxContext): SupportedAncestorOperation | null | "unsupported" {
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

function getAncestorTxids(context: CachedMempoolTxContext, txContexts: Map<string, CachedMempoolTxContext>): string[] {
  return context.rawTransaction.vin
    .map((vin) => vin.txid ?? null)
    .filter((txid): txid is string => txid !== null && txContexts.has(txid));
}

function topologicallyOrderAncestorContexts(options: {
  txid: string;
  txContexts: Map<string, CachedMempoolTxContext>;
}): CachedMempoolTxContext[] | null {
  const visited = new Map<string, "visiting" | "visited">();
  const ordered: CachedMempoolTxContext[] = [];
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
  txContexts: Map<string, CachedMempoolTxContext>;
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
}): Promise<CompetitivenessDecision> {
  const createDecision = (overrides: Partial<CompetitivenessDecision>): CompetitivenessDecision => ({
    allowed: overrides.allowed ?? false,
    decision: overrides.decision ?? "indeterminate-mempool-gate",
    sameDomainCompetitorSuppressed: overrides.sameDomainCompetitorSuppressed ?? false,
    higherRankedCompetitorDomainCount: overrides.higherRankedCompetitorDomainCount ?? 0,
    dedupedCompetitorDomainCount: overrides.dedupedCompetitorDomainCount ?? 0,
    competitivenessGateIndeterminate: overrides.competitivenessGateIndeterminate ?? false,
    mempoolSequenceCacheStatus: overrides.mempoolSequenceCacheStatus ?? null,
    lastMempoolSequence: overrides.lastMempoolSequence ?? null,
    visibleBoardEntries: overrides.visibleBoardEntries ?? [],
    candidateRank: overrides.candidateRank ?? null,
  });
  const walletRootId = options.readContext.localState.walletRootId ?? "uninitialized-wallet-root";
  const assaySentencesImpl = options.assaySentencesImpl ?? assaySentences;
  const indexerTruthKey = getIndexerTruthKey(
    options.readContext as WalletReadContext & {
      localState: { availability: "ready"; state: WalletStateV1 };
      snapshot: NonNullable<WalletReadContext["snapshot"]>;
    },
  );
  const excludedTxids = [options.currentTxid].filter((value): value is string => value !== null).sort();
  const localAssayTupleKey = [
    options.candidate.domainId,
    Buffer.from(options.candidate.encodedSentenceBytes).toString("hex"),
    options.candidate.canonicalBlend.toString(),
    options.candidate.sender.scriptPubKeyHex,
  ].join(":");

  let mempoolVerbose: Awaited<ReturnType<MiningRpcClient["getRawMempoolVerbose"]>>;
  try {
    mempoolVerbose = await options.rpc.getRawMempoolVerbose();
  } catch {
    return createDecision({
      competitivenessGateIndeterminate: true,
    });
  }

  const mempoolSequence = String(mempoolVerbose.mempool_sequence);
  const cached = miningGateCache.get(walletRootId);
  const cachedTruthMatches = cached !== undefined
    && indexerTruthKey !== null
    && cached.indexerDaemonInstanceId === indexerTruthKey.daemonInstanceId
    && cached.indexerSnapshotSeq === indexerTruthKey.snapshotSeq;
  const cachedReferencedBlockMatches = cached !== undefined
    && cached.referencedBlockHashDisplay === options.candidate.referencedBlockHashDisplay;

  if (cached !== undefined && (!cachedTruthMatches || !cachedReferencedBlockMatches)) {
    clearMiningGateCache(walletRootId);
  }

  if (
    cached !== undefined
    && cachedTruthMatches
    && cachedReferencedBlockMatches
    && cached.localAssayTupleKey === localAssayTupleKey
    && cached.excludedTxidsKey === excludedTxids.join(",")
    && cached.mempoolSequence === mempoolSequence
  ) {
    return {
      ...cached.decision,
      mempoolSequenceCacheStatus: "reused",
    };
  }

  const referencedPrefix = Buffer.from(options.candidate.referencedBlockHashInternal.subarray(0, 4)).toString("hex");
  const visibleTxids = mempoolVerbose.txids.filter((txid) => !excludedTxids.includes(txid));
  const txContexts = cachedTruthMatches && cachedReferencedBlockMatches
    ? (cached?.txContexts ?? new Map<string, CachedMempoolTxContext>())
    : new Map<string, CachedMempoolTxContext>();
  for (const txid of [...txContexts.keys()]) {
    if (!visibleTxids.includes(txid)) {
      txContexts.delete(txid);
    }
  }

  for (let index = 0; index < visibleTxids.length; index += 1) {
    await maybeYieldDuringMempoolScan({
      iteration: index,
      cooperativeYield: options.cooperativeYield,
      cooperativeYieldEvery: options.cooperativeYieldEvery,
    });
    const txid = visibleTxids[index]!;
    if (txContexts.has(txid)) {
      continue;
    }

    const [tx, mempoolEntry] = await Promise.all([
      options.rpc.getRawTransaction(txid, true).catch(() => null),
      options.rpc.getMempoolEntry(txid).catch(() => null),
    ]);
    if (tx === null || mempoolEntry === null) {
      continue;
    }

    const effectiveFeeRate = Number([
      mempoolEntry.vsize > 0 ? (numberToSats(mempoolEntry.fees.base) / BigInt(mempoolEntry.vsize)) : 0n,
      (mempoolEntry.ancestorsize ?? 0) > 0 ? (numberToSats(mempoolEntry.fees.ancestor) / BigInt(mempoolEntry.ancestorsize ?? 1)) : 0n,
      (mempoolEntry.descendantsize ?? 0) > 0 ? (numberToSats(mempoolEntry.fees.descendant) / BigInt(mempoolEntry.descendantsize ?? 1)) : 0n,
    ].reduce((best, candidate) => (candidate > best ? candidate : best), 0n));
    const payloadHex = tx.vout.find((entry) => entry.scriptPubKey?.hex?.startsWith("6a") === true)?.scriptPubKey?.hex;
    txContexts.set(txid, {
      txid,
      effectiveFeeRate,
      senderScriptHex: tx.vin[0]?.prevout?.scriptPubKey?.hex ?? null,
      rawTransaction: tx,
      payload: payloadHex === undefined ? null : extractOpReturnPayloadFromScriptHex(payloadHex),
    });
  }

  const entries = new Map<string, CachedCompetitorEntry>();
  for (let index = 0; index < visibleTxids.length; index += 1) {
    await maybeYieldDuringMempoolScan({
      iteration: index,
      cooperativeYield: options.cooperativeYield,
      cooperativeYieldEvery: options.cooperativeYieldEvery,
    });
    const txid = visibleTxids[index]!;
    const context = txContexts.get(txid);

    if (context === undefined || context.payload === null || context.senderScriptHex === null) {
      continue;
    }

    const decoded = decodeMinePayload(context.payload);
    if (decoded === null || decoded.referencedBlockPrefixHex !== referencedPrefix) {
      continue;
    }

    const overlayDomain = await resolveOverlayAuthorizedMiningDomain({
      readContext: options.readContext,
      txid,
      txContexts,
      domainId: decoded.domainId,
      senderScriptHex: context.senderScriptHex,
    });
    if (overlayDomain === "indeterminate") {
      const decision = createDecision({
        competitivenessGateIndeterminate: true,
        decision: "indeterminate-mempool-gate",
        mempoolSequenceCacheStatus: "refreshed",
        lastMempoolSequence: mempoolSequence,
      });
      miningGateCache.set(walletRootId, {
        indexerDaemonInstanceId: indexerTruthKey?.daemonInstanceId ?? "none",
        indexerSnapshotSeq: indexerTruthKey?.snapshotSeq ?? "none",
        referencedBlockHashDisplay: options.candidate.referencedBlockHashDisplay,
        localAssayTupleKey,
        excludedTxidsKey: excludedTxids.join(","),
        mempoolSequence,
        txids: [...visibleTxids],
        txContexts,
        decision,
      });
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
    const scored = assayed[0];
    if (scored === undefined || !scored.gatesPass || scored.encodedSentenceBytes === null || scored.canonicalBlend === null) {
      continue;
    }

    entries.set(txid, {
      txid,
      effectiveFeeRate: context.effectiveFeeRate,
      domainId: decoded.domainId,
      domainName: overlayDomain.name,
      sentence: Buffer.from(decoded.sentenceBytes).toString("utf8"),
      senderScriptHex: context.senderScriptHex,
      encodedSentenceBytesHex: Buffer.from(scored.encodedSentenceBytes).toString("hex"),
      bip39WordIndices: [...scored.bip39WordIndices],
      canonicalBlend: scored.canonicalBlend,
    });
  }

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
    decision = createDecision({
      allowed: false,
      decision: "suppressed-same-domain-mempool",
      sameDomainCompetitorSuppressed: true,
      higherRankedCompetitorDomainCount: 1,
      dedupedCompetitorDomainCount: otherDomainBest.size,
      competitivenessGateIndeterminate: false,
      mempoolSequenceCacheStatus: "refreshed",
      lastMempoolSequence: mempoolSequence,
      visibleBoardEntries: toSentenceBoardEntries(visibleRankedEntries),
    });
  } else {
    try {
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
          mempoolSequenceCacheStatus: "refreshed",
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
          mempoolSequenceCacheStatus: "refreshed",
          lastMempoolSequence: mempoolSequence,
          visibleBoardEntries: toSentenceBoardEntries(visibleRankedEntries),
          candidateRank,
        });
      }
    } catch {
      decision = createDecision({
        allowed: false,
        decision: "indeterminate-mempool-gate",
        sameDomainCompetitorSuppressed: false,
        higherRankedCompetitorDomainCount: 0,
        dedupedCompetitorDomainCount: otherDomainBest.size,
        competitivenessGateIndeterminate: true,
        mempoolSequenceCacheStatus: "refreshed",
        lastMempoolSequence: mempoolSequence,
        visibleBoardEntries: toSentenceBoardEntries(visibleRankedEntries),
      });
    }
  }

  miningGateCache.set(walletRootId, {
    indexerDaemonInstanceId: indexerTruthKey?.daemonInstanceId ?? "none",
    indexerSnapshotSeq: indexerTruthKey?.snapshotSeq ?? "none",
    referencedBlockHashDisplay: options.candidate.referencedBlockHashDisplay,
    localAssayTupleKey,
    excludedTxidsKey: excludedTxids.join(","),
    mempoolSequence,
    txids: [...visibleTxids],
    txContexts,
    decision,
  });

  return decision;
}
