import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  lookupDomain,
  lookupDomainById,
} from "@cogcoin/indexer/queries";
import {
  assaySentences,
  deriveBlendSeed,
  displayToInternalBlockhash,
  getWords,
  settleBlock,
} from "@cogcoin/scoring";

import { probeIndexerDaemon } from "../../bitcoind/indexer-daemon.js";
import { attachOrStartManagedBitcoindService } from "../../bitcoind/service.js";
import { createRpcClient } from "../../bitcoind/node.js";
import type { ProgressOutputMode } from "../../bitcoind/types.js";
import { COG_OPCODES, COG_PREFIX } from "../cogop/constants.js";
import { extractOpReturnPayloadFromScriptHex } from "../tx/register.js";
import {
  DEFAULT_WALLET_MUTATION_FEE_RATE_SAT_VB,
  assertFixedInputPrefixMatches,
  assertFundingInputsAfterFixedPrefix,
  buildWalletMutationTransaction,
  outpointKey as walletMutationOutpointKey,
  isAlreadyAcceptedError,
  isBroadcastUnknownError,
  saveWalletStatePreservingUnlock,
  type FixedWalletInput,
  type MutationSender,
  type WalletMutationRpcClient,
} from "../tx/common.js";
import { acquireFileLock } from "../fs/lock.js";
import { loadOrAutoUnlockWalletState, type WalletPrompter } from "../lifecycle.js";
import {
  isMineableWalletDomain,
  openWalletReadContext,
  type WalletReadContext,
} from "../read/index.js";
import { resolveWalletRuntimePathsForTesting, type WalletRuntimePaths } from "../runtime.js";
import {
  createDefaultWalletSecretProvider,
  type WalletSecretProvider,
} from "../state/provider.js";
import type {
  MiningStateRecord,
  OutpointRecord,
  WalletStateV1,
} from "../types.js";
import { serializeMine } from "../cogop/index.js";
import {
  appendMiningEvent,
  loadMiningRuntimeStatus,
  saveMiningRuntimeStatus,
} from "./runtime-artifacts.js";
import { loadClientConfig } from "./config.js";
import {
  MINING_HOOK_COOLDOWN_MS,
  MINING_HOOK_FAILURE_THRESHOLD,
  MINING_LOOP_INTERVAL_MS,
  MINING_NETWORK_SETTLE_WINDOW_MS,
  MINING_PROVIDER_BACKOFF_BASE_MS,
  MINING_PROVIDER_BACKOFF_MAX_MS,
  MINING_SHUTDOWN_GRACE_MS,
  MINING_STATUS_HEARTBEAT_INTERVAL_MS,
  MINING_SUSPEND_GAP_THRESHOLD_MS,
  MINING_TIP_SETTLE_WINDOW_MS,
  MINING_WORKER_API_VERSION,
} from "./constants.js";
import { inspectMiningControlPlane, setupBuiltInMining } from "./control.js";
import {
  isMiningGenerationAbortRequested,
  markMiningGenerationActive,
  markMiningGenerationInactive,
  readMiningPreemptionRequest,
  requestMiningGenerationPreemption,
} from "./coordination.js";
import {
  clearMiningFamilyState,
  miningFamilyMayStillExist,
  normalizeMiningPublishState,
  normalizeMiningStateRecord,
} from "./state.js";
import { createGenerateSentencesHookLimits } from "./hook-protocol.js";
import { generateMiningSentences, MiningProviderRequestError, type MiningSentenceGenerationRequest } from "./sentences.js";
import type { MiningControlPlaneView, MiningEventRecord, MiningRuntimeStatusV1 } from "./types.js";
import { MiningFollowVisualizer } from "./visualizer.js";

const BEST_BLOCK_POLL_INTERVAL_MS = 500;
const BACKGROUND_START_TIMEOUT_MS = 15_000;

type MiningRpcClient = WalletMutationRpcClient & {
  getBlockchainInfo(): Promise<{
    blocks: number;
    bestblockhash: string;
    initialblockdownload?: boolean;
  }>;
  getNetworkInfo(): Promise<{
    networkactive: boolean;
    connections_out?: number;
  }>;
  getMempoolInfo(): Promise<{
    loaded: boolean;
  }>;
  getRawMempool(): Promise<string[]>;
  getRawMempoolVerbose(): Promise<{
    txids: string[];
    mempool_sequence: string | number;
  }>;
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

interface MiningRunnerStatusOverrides {
  runMode?: MiningRuntimeStatusV1["runMode"];
  backgroundWorkerPid?: number | null;
  backgroundWorkerRunId?: string | null;
  backgroundWorkerHeartbeatAtUnixMs?: number | null;
  currentPhase?: MiningRuntimeStatusV1["currentPhase"];
  lastSuspendDetectedAtUnixMs?: number | null;
  providerState?: MiningRuntimeStatusV1["providerState"];
  corePublishState?: MiningRuntimeStatusV1["corePublishState"];
  currentPublishDecision?: string | null;
  sameDomainCompetitorSuppressed?: boolean | null;
  higherRankedCompetitorDomainCount?: number | null;
  dedupedCompetitorDomainCount?: number | null;
  competitivenessGateIndeterminate?: boolean | null;
  mempoolSequenceCacheStatus?: MiningRuntimeStatusV1["mempoolSequenceCacheStatus"];
  lastMempoolSequence?: string | null;
  lastCompetitivenessGateAtUnixMs?: number | null;
  lastError?: string | null;
  note?: string | null;
  liveMiningFamilyInMempool?: boolean | null;
}

interface MiningCandidate {
  domainId: number;
  domainName: string;
  localIndex: number;
  sender: MutationSender;
  anchorOutpoint: OutpointRecord;
  sentence: string;
  encodedSentenceBytes: Uint8Array;
  bip39WordIndices: number[];
  bip39Words: readonly string[];
  canonicalBlend: bigint;
  referencedBlockHashDisplay: string;
  referencedBlockHashInternal: Uint8Array;
  targetBlockHeight: number;
}

interface CompetitivenessDecision {
  allowed: boolean;
  decision: string;
  sameDomainCompetitorSuppressed: boolean;
  higherRankedCompetitorDomainCount: number;
  dedupedCompetitorDomainCount: number;
  competitivenessGateIndeterminate: boolean;
  mempoolSequenceCacheStatus: MiningRuntimeStatusV1["mempoolSequenceCacheStatus"];
  lastMempoolSequence: string | null;
}

interface RunnerDependencies {
  openReadContext?: typeof openWalletReadContext;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => MiningRpcClient;
  fetchImpl?: typeof fetch;
}

interface CachedCompetitorEntry {
  txid: string;
  effectiveFeeRate: number;
  domainId: number;
  senderScriptHex: string;
  encodedSentenceBytesHex: string;
  bip39WordIndices: number[];
  canonicalBlend: bigint;
}

interface IndexerTruthKey {
  walletRootId: string;
  daemonInstanceId: string;
  snapshotSeq: string;
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
  currentFeeTargetSatVb: number;
  excludedTxidsKey: string;
  mempoolSequence: string;
  txids: string[];
  txContexts: Map<string, CachedMempoolTxContext>;
  decision: CompetitivenessDecision;
}

interface MiningSuspendDetector {
  lastMonotonicMs: number;
}

class MiningSuspendDetectedError extends Error {
  readonly detectedAtUnixMs: number;

  constructor(detectedAtUnixMs: number) {
    super("mining_runtime_resumed");
    this.detectedAtUnixMs = detectedAtUnixMs;
  }
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

const miningGateCache = new Map<string, MiningCompetitivenessCacheRecord>();

function createMiningSuspendDetector(monotonicNow = performance.now()): MiningSuspendDetector {
  return {
    lastMonotonicMs: monotonicNow,
  };
}

function checkpointMiningSuspendDetector(
  detector: MiningSuspendDetector | undefined,
  monotonicNow = performance.now(),
): void {
  if (detector === undefined) {
    return;
  }

  const gapMs = monotonicNow - detector.lastMonotonicMs;
  detector.lastMonotonicMs = monotonicNow;

  if (gapMs > MINING_SUSPEND_GAP_THRESHOLD_MS) {
    throw new MiningSuspendDetectedError(Date.now());
  }
}

function clearMiningGateCache(walletRootId: string | null | undefined): void {
  if (walletRootId === null || walletRootId === undefined) {
    miningGateCache.clear();
    return;
  }

  miningGateCache.delete(walletRootId);
}

export interface RunForegroundMiningOptions extends RunnerDependencies {
  dataDir: string;
  databasePath: string;
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  stdout?: { write(chunk: string): void };
  stderr?: { isTTY?: boolean; columns?: number; write(chunk: string): boolean | void };
  signal?: AbortSignal;
  progressOutput?: ProgressOutputMode;
  paths?: WalletRuntimePaths;
}

export interface StartBackgroundMiningOptions extends RunnerDependencies {
  dataDir: string;
  databasePath: string;
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  paths?: WalletRuntimePaths;
}

export interface StopBackgroundMiningOptions extends RunnerDependencies {
  dataDir: string;
  databasePath: string;
  provider?: WalletSecretProvider;
  paths?: WalletRuntimePaths;
}

export interface MiningStartResult {
  started: boolean;
  snapshot: MiningRuntimeStatusV1 | null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function isProcessAlive(pid: number | null): Promise<boolean> {
  if (pid === null) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }

    return true;
  }
}

function writeStdout(stream: { write(chunk: string): void } | undefined, line: string): void {
  if (stream === undefined) {
    return;
  }

  stream.write(`${line}\n`);
}

function createEvent(
  kind: string,
  message: string,
  options: Partial<MiningEventRecord> = {},
): MiningEventRecord {
  return {
    schemaVersion: 1,
    timestampUnixMs: options.timestampUnixMs ?? Date.now(),
    level: options.level ?? "info",
    kind,
    message,
    targetBlockHeight: options.targetBlockHeight ?? null,
    referencedBlockHashDisplay: options.referencedBlockHashDisplay ?? null,
    domainId: options.domainId ?? null,
    domainName: options.domainName ?? null,
    txid: options.txid ?? null,
    feeRateSatVb: options.feeRateSatVb ?? null,
    feeSats: options.feeSats ?? null,
    score: options.score ?? null,
    reason: options.reason ?? null,
    runId: options.runId ?? null,
  };
}

function cloneMiningState(state: MiningStateRecord): MiningStateRecord {
  const normalized = normalizeMiningStateRecord(state);
  return {
    ...normalized,
    currentBip39WordIndices: normalized.currentBip39WordIndices === null ? null : [...normalized.currentBip39WordIndices],
    sharedMiningConflictOutpoint: normalized.sharedMiningConflictOutpoint === null
      ? null
      : { ...normalized.sharedMiningConflictOutpoint },
  };
}

function hasBlockingMutation(state: WalletStateV1): boolean {
  return state.proactiveFamilies.some((family) =>
    family.status === "draft"
    || family.status === "broadcasting"
    || family.status === "broadcast-unknown"
    || family.status === "live"
    || family.status === "repair-required"
  ) || (state.pendingMutations ?? []).some((mutation) =>
    mutation.status === "draft"
    || mutation.status === "broadcasting"
    || mutation.status === "broadcast-unknown"
    || mutation.status === "live"
    || mutation.status === "repair-required"
  );
}

function rootDomain(name: string): boolean {
  return !name.includes("-");
}

function uint32BigEndian(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function getBlockRewardCogtoshi(height: number): bigint {
  const halvingEra = Math.floor(height / 210_000);

  if (halvingEra >= 33) {
    return 0n;
  }

  return 5_000_000_000n >> BigInt(halvingEra);
}

function deriveMiningWordIndices(referencedBlockhash: Uint8Array, miningDomainId: number): number[] {
  const seed = createHash("sha256")
    .update(Buffer.from(referencedBlockhash))
    .update(uint32BigEndian(miningDomainId))
    .digest();
  const indices: number[] = [];

  for (let index = 0; index < 5; index += 1) {
    const chunkOffset = index * 4;
    let wordIndex = seed.readUInt32BE(chunkOffset) % 2048;

    while (indices.includes(wordIndex)) {
      wordIndex = (wordIndex + 1) % 2048;
    }

    indices.push(wordIndex);
  }

  return indices;
}

function outpointKey(outpoint: OutpointRecord | null): string | null {
  return outpoint === null ? null : `${outpoint.txid}:${outpoint.vout}`;
}

function numberToSats(value: number | string): bigint {
  const text = typeof value === "number" ? value.toFixed(8) : value;
  const match = /^(-?)(\d+)(?:\.(\d{0,8}))?$/.exec(text.trim());

  if (match == null) {
    throw new Error(`mining_invalid_amount_${text}`);
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2] ?? "0");
  const fraction = BigInt((match[3] ?? "").padEnd(8, "0"));
  return sign * ((whole * 100_000_000n) + fraction);
}

function satsToBtc(value: bigint): number {
  return Number(value) / 100_000_000;
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

function defaultMiningStatePatch(
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
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: CachedMempoolTxContext[] = [];

  const visit = (txid: string): boolean => {
    if (visited.has(txid)) {
      return true;
    }

    if (visiting.has(txid)) {
      return false;
    }

    const context = options.txContexts.get(txid);
    if (context === undefined) {
      return true;
    }

    visiting.add(txid);
    for (const parentTxid of getAncestorTxids(context, options.txContexts)) {
      if (!visit(parentTxid)) {
        return false;
      }
    }
    visiting.delete(txid);
    visited.add(txid);
    ordered.push(context);
    return true;
  };

  const root = options.txContexts.get(options.txid);
  if (root === undefined) {
    return [];
  }

  for (const parentTxid of getAncestorTxids(root, options.txContexts)) {
    if (!visit(parentTxid)) {
      return null;
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

function buildStatusSnapshot(
  view: MiningControlPlaneView,
  overrides: MiningRunnerStatusOverrides = {},
): MiningRuntimeStatusV1 {
  return {
    ...view.runtime,
    runMode: overrides.runMode ?? view.runtime.runMode,
    backgroundWorkerPid: overrides.backgroundWorkerPid ?? view.runtime.backgroundWorkerPid,
    backgroundWorkerRunId: overrides.backgroundWorkerRunId ?? view.runtime.backgroundWorkerRunId,
    backgroundWorkerHeartbeatAtUnixMs: overrides.backgroundWorkerHeartbeatAtUnixMs ?? view.runtime.backgroundWorkerHeartbeatAtUnixMs,
    currentPhase: overrides.currentPhase ?? view.runtime.currentPhase,
    lastSuspendDetectedAtUnixMs: overrides.lastSuspendDetectedAtUnixMs ?? view.runtime.lastSuspendDetectedAtUnixMs,
    providerState: overrides.providerState ?? view.runtime.providerState,
    corePublishState: overrides.corePublishState ?? view.runtime.corePublishState,
    currentPublishDecision: overrides.currentPublishDecision ?? view.runtime.currentPublishDecision,
    sameDomainCompetitorSuppressed: overrides.sameDomainCompetitorSuppressed ?? view.runtime.sameDomainCompetitorSuppressed,
    higherRankedCompetitorDomainCount: overrides.higherRankedCompetitorDomainCount ?? view.runtime.higherRankedCompetitorDomainCount,
    dedupedCompetitorDomainCount: overrides.dedupedCompetitorDomainCount ?? view.runtime.dedupedCompetitorDomainCount,
    competitivenessGateIndeterminate: overrides.competitivenessGateIndeterminate ?? view.runtime.competitivenessGateIndeterminate,
    mempoolSequenceCacheStatus: overrides.mempoolSequenceCacheStatus ?? view.runtime.mempoolSequenceCacheStatus,
    lastMempoolSequence: overrides.lastMempoolSequence ?? view.runtime.lastMempoolSequence,
    lastCompetitivenessGateAtUnixMs: overrides.lastCompetitivenessGateAtUnixMs ?? view.runtime.lastCompetitivenessGateAtUnixMs,
    lastError: overrides.lastError ?? view.runtime.lastError,
    note: overrides.note ?? view.runtime.note,
    liveMiningFamilyInMempool: overrides.liveMiningFamilyInMempool ?? view.runtime.liveMiningFamilyInMempool,
    updatedAtUnixMs: Date.now(),
  };
}

async function refreshAndSaveStatus(options: {
  paths: WalletRuntimePaths;
  provider: WalletSecretProvider;
  readContext: WalletReadContext;
  overrides?: MiningRunnerStatusOverrides;
  visualizer?: MiningFollowVisualizer;
}): Promise<MiningRuntimeStatusV1> {
  const view = await inspectMiningControlPlane({
    provider: options.provider,
    localState: options.readContext.localState,
    bitcoind: options.readContext.bitcoind,
    nodeStatus: options.readContext.nodeStatus,
    nodeHealth: options.readContext.nodeHealth,
    indexer: options.readContext.indexer,
    paths: options.paths,
  });
  const snapshot = buildStatusSnapshot(view, options.overrides);
  await saveMiningRuntimeStatus(options.paths.miningStatusPath, snapshot);
  options.visualizer?.update(snapshot);
  return snapshot;
}

async function appendEvent(paths: WalletRuntimePaths, event: MiningEventRecord): Promise<void> {
  await appendMiningEvent(paths.miningEventsPath, event);
}

async function handleDetectedMiningRuntimeResume(options: {
  dataDir: string;
  databasePath: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  runMode: "foreground" | "background";
  backgroundWorkerPid: number | null;
  backgroundWorkerRunId: string | null;
  detectedAtUnixMs: number;
  openReadContext: typeof openWalletReadContext;
  visualizer?: MiningFollowVisualizer;
}): Promise<void> {
  const readContext = await options.openReadContext({
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    secretProvider: options.provider,
    paths: options.paths,
  });

  try {
    clearMiningGateCache(readContext.localState.walletRootId);
    await refreshAndSaveStatus({
      paths: options.paths,
      provider: options.provider,
      readContext,
      overrides: {
        runMode: options.runMode,
        backgroundWorkerPid: options.backgroundWorkerPid,
        backgroundWorkerRunId: options.backgroundWorkerRunId,
        backgroundWorkerHeartbeatAtUnixMs: options.runMode === "background" ? Date.now() : null,
        currentPhase: "resuming",
        lastSuspendDetectedAtUnixMs: options.detectedAtUnixMs,
        note: "Mining discarded stale in-flight work after a large local runtime gap and is rechecking health.",
      },
      visualizer: options.visualizer,
    });
  } finally {
    await readContext.close();
  }

  await appendEvent(options.paths, createEvent(
    "system-resumed",
    "Detected a large local runtime gap, discarded stale in-flight mining work, and resumed health checks from scratch.",
    {
      level: "warn",
      runId: options.backgroundWorkerRunId,
      timestampUnixMs: options.detectedAtUnixMs,
    },
  ));
}

function getIndexerTruthKey(
  readContext: WalletReadContext & {
    localState: { availability: "ready"; state: WalletStateV1; unlockUntilUnixMs: number };
    snapshot: NonNullable<WalletReadContext["snapshot"]>;
  },
): IndexerTruthKey | null {
  if (
    readContext.snapshot.daemonInstanceId == null
    || readContext.snapshot.snapshotSeq == null
  ) {
    return null;
  }

  return {
    walletRootId: readContext.localState.state.walletRootId,
    daemonInstanceId: readContext.snapshot.daemonInstanceId,
    snapshotSeq: readContext.snapshot.snapshotSeq,
  };
}

async function indexerTruthIsCurrent(options: {
  dataDir: string;
  truthKey: IndexerTruthKey | null;
}): Promise<boolean> {
  if (options.truthKey === null) {
    return false;
  }

  const probe = await probeIndexerDaemon({
    dataDir: options.dataDir,
    walletRootId: options.truthKey.walletRootId,
  });

  try {
    return probe.compatibility === "compatible"
      && probe.status !== null
      && probe.status.state === "synced"
      && probe.status.daemonInstanceId === options.truthKey.daemonInstanceId
      && probe.status.snapshotSeq === options.truthKey.snapshotSeq;
  } finally {
    await probe.client?.close().catch(() => undefined);
  }
}

async function ensureIndexerTruthIsCurrent(options: {
  dataDir: string;
  truthKey: IndexerTruthKey | null;
}): Promise<void> {
  if (!await indexerTruthIsCurrent(options)) {
    throw new Error("mining_generation_stale_indexer_truth");
  }
}

function determineCorePublishState(info: {
  blockchain: Awaited<ReturnType<MiningRpcClient["getBlockchainInfo"]>>;
  network: Awaited<ReturnType<MiningRpcClient["getNetworkInfo"]>>;
  mempool: Awaited<ReturnType<MiningRpcClient["getMempoolInfo"]>>;
}): MiningRuntimeStatusV1["corePublishState"] {
  if (info.network.networkactive === false) {
    return "network-inactive";
  }

  if ((info.network.connections_out ?? 0) <= 0) {
    return "no-outbound-peers";
  }

  if (info.blockchain.initialblockdownload === true) {
    return "ibd";
  }

  if (info.mempool.loaded === false) {
    return "mempool-loading";
  }

  return "healthy";
}

function createMiningPlan(options: {
  state: WalletStateV1;
  candidate: MiningCandidate;
  conflictOutpoint: OutpointRecord;
  allUtxos: Awaited<ReturnType<MiningRpcClient["listUnspent"]>>;
  feeRateSatVb: number;
}): {
  sender: MutationSender;
  fixedInputs: FixedWalletInput[];
  outputs: unknown[];
  changeAddress: string;
  changePosition: number;
  expectedOpReturnScriptHex: string;
  expectedAnchorScriptHex: string;
  expectedAnchorValueSats: bigint;
  allowedFundingScriptPubKeyHex: string;
  eligibleFundingOutpointKeys: Set<string>;
  expectedConflictOutpoint: OutpointRecord;
  feeRateSatVb: number;
} {
  const fundingUtxos = options.allUtxos.filter((entry) =>
    entry.scriptPubKey === options.state.funding.scriptPubKeyHex
    && entry.confirmations >= 1
    && entry.spendable !== false
    && entry.safe !== false
    && !(entry.txid === options.conflictOutpoint.txid && entry.vout === options.conflictOutpoint.vout)
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
    fixedInputs: [
      options.candidate.anchorOutpoint,
      options.conflictOutpoint,
    ],
    outputs: [
      { data: Buffer.from(opReturnData).toString("hex") },
      { [options.candidate.sender.address]: satsToBtc(BigInt(options.state.anchorValueSats)) },
    ],
    changeAddress: options.state.funding.address,
    changePosition: 2,
    expectedOpReturnScriptHex,
    expectedAnchorScriptHex: options.candidate.sender.scriptPubKeyHex,
    expectedAnchorValueSats: BigInt(options.state.anchorValueSats),
    allowedFundingScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
    eligibleFundingOutpointKeys: new Set(fundingUtxos.map((entry) => walletMutationOutpointKey({ txid: entry.txid, vout: entry.vout }))),
    expectedConflictOutpoint: options.conflictOutpoint,
    feeRateSatVb: options.feeRateSatVb,
  };
}

function validateMiningDraft(
  decoded: Awaited<ReturnType<MiningRpcClient["decodePsbt"]>>,
  funded: Awaited<ReturnType<MiningRpcClient["walletCreateFundedPsbt"]>>,
  plan: ReturnType<typeof createMiningPlan>,
): void {
  const inputs = decoded.tx.vin;
  const outputs = decoded.tx.vout;

  if (inputs.length < 2) {
    throw new Error("wallet_mining_missing_inputs");
  }

  assertFixedInputPrefixMatches(inputs, plan.fixedInputs, "wallet_mining_missing_inputs");

  if (inputs[0]?.prevout?.scriptPubKey?.hex !== plan.sender.scriptPubKeyHex) {
    throw new Error("wallet_mining_sender_input_mismatch");
  }

  if (inputs[1]?.prevout?.scriptPubKey?.hex !== plan.allowedFundingScriptPubKeyHex
    || inputs[1]?.txid !== plan.expectedConflictOutpoint.txid
    || (inputs[1] as { vout?: unknown }).vout !== plan.expectedConflictOutpoint.vout) {
    throw new Error("wallet_mining_conflict_input_mismatch");
  }

  assertFundingInputsAfterFixedPrefix({
    inputs,
    fixedInputs: plan.fixedInputs,
    allowedFundingScriptPubKeyHex: plan.allowedFundingScriptPubKeyHex,
    eligibleFundingOutpointKeys: plan.eligibleFundingOutpointKeys,
    errorCode: "wallet_mining_unexpected_funding_input",
  });

  if (outputs[0]?.scriptPubKey?.hex !== plan.expectedOpReturnScriptHex) {
    throw new Error("wallet_mining_opreturn_mismatch");
  }

  if (outputs[1]?.scriptPubKey?.hex !== plan.expectedAnchorScriptHex) {
    throw new Error("wallet_mining_anchor_output_mismatch");
  }

  if (numberToSats(outputs[1]?.value ?? 0) !== plan.expectedAnchorValueSats) {
    throw new Error("wallet_mining_anchor_value_mismatch");
  }

  if (funded.changepos !== -1 && (funded.changepos !== plan.changePosition || outputs[funded.changepos]?.scriptPubKey?.hex !== plan.allowedFundingScriptPubKeyHex)) {
    throw new Error("wallet_mining_change_output_mismatch");
  }
}

async function buildMiningTransaction(options: {
  rpc: MiningRpcClient;
  walletName: string;
  state: WalletStateV1;
  plan: ReturnType<typeof createMiningPlan>;
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
  });
}

function resolveEligibleAnchoredRoots(context: WalletReadContext): Array<{
  domainId: number;
  domainName: string;
  localIndex: number;
  sender: MutationSender;
  anchorOutpoint: OutpointRecord;
}> {
  const state = context.localState.state;
  const model = context.model;
  const snapshot = context.snapshot;

  if (state === null || model === null || snapshot === null) {
    return [];
  }

  const domains: Array<{
    domainId: number;
    domainName: string;
    localIndex: number;
    sender: MutationSender;
    anchorOutpoint: OutpointRecord;
  }> = [];

  for (const domain of model.domains) {
    if (!isMineableWalletDomain(context, domain)) {
      continue;
    }

    const localRecord = state.domains.find((entry) => entry.name === domain.name);
    const ownerIdentity = model.identities.find((identity) => identity.index === domain.ownerLocalIndex);
    const domainId = domain.domainId;

    if (
      domainId === null
      || domainId === undefined
      || localRecord?.currentCanonicalAnchorOutpoint === null
      || localRecord?.currentCanonicalAnchorOutpoint === undefined
      || ownerIdentity?.address == null
      || ownerIdentity.readOnly
    ) {
      continue;
    }

    const chainDomain = lookupDomain(snapshot.state, domain.name);
    if (chainDomain === null || !chainDomain.anchored) {
      continue;
    }

    domains.push({
      domainId,
      domainName: domain.name,
      localIndex: ownerIdentity.index,
      sender: {
        localIndex: ownerIdentity.index,
        scriptPubKeyHex: ownerIdentity.scriptPubKeyHex,
        address: ownerIdentity.address,
      },
      anchorOutpoint: {
        txid: localRecord.currentCanonicalAnchorOutpoint.txid,
        vout: localRecord.currentCanonicalAnchorOutpoint.vout,
      },
    });
  }

  return domains.sort((left, right) => left.domainId - right.domainId || left.domainName.localeCompare(right.domainName));
}

async function persistCustomHookRuntimeOutcome(options: {
  readContext: WalletReadContext & {
    localState: { availability: "ready"; state: WalletStateV1; unlockUntilUnixMs: number };
  };
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  nowUnixMs: number;
  success: boolean;
}): Promise<boolean> {
  const hookState = options.readContext.localState.state.hookClientState.mining;

  if (hookState.mode !== "custom") {
    return false;
  }

  if (options.success) {
    if ((hookState.consecutiveFailureCount ?? 0) === 0 && hookState.cooldownUntilUnixMs === null) {
      return false;
    }

    options.readContext.localState.state.hookClientState.mining = {
      ...hookState,
      consecutiveFailureCount: 0,
      cooldownUntilUnixMs: null,
    };
    await saveWalletStatePreservingUnlock({
      state: options.readContext.localState.state,
      provider: options.provider,
      unlockUntilUnixMs: options.readContext.localState.unlockUntilUnixMs,
      nowUnixMs: options.nowUnixMs,
      paths: options.paths,
    });
    return false;
  }

  const consecutiveFailureCount = (hookState.consecutiveFailureCount ?? 0) + 1;
  const cooldownUntilUnixMs = consecutiveFailureCount >= MINING_HOOK_FAILURE_THRESHOLD
    ? options.nowUnixMs + MINING_HOOK_COOLDOWN_MS
    : null;

  options.readContext.localState.state.hookClientState.mining = {
    ...hookState,
    consecutiveFailureCount,
    cooldownUntilUnixMs,
  };
  await saveWalletStatePreservingUnlock({
    state: options.readContext.localState.state,
    provider: options.provider,
    unlockUntilUnixMs: options.readContext.localState.unlockUntilUnixMs,
    nowUnixMs: options.nowUnixMs,
    paths: options.paths,
  });
  return cooldownUntilUnixMs !== null && cooldownUntilUnixMs > options.nowUnixMs;
}

async function generateCandidatesForDomains(options: {
  rpc: MiningRpcClient;
  readContext: WalletReadContext & {
    localState: { availability: "ready"; state: WalletStateV1; unlockUntilUnixMs: number };
    snapshot: NonNullable<WalletReadContext["snapshot"]>;
    model: NonNullable<WalletReadContext["model"]>;
  };
  domains: ReturnType<typeof resolveEligibleAnchoredRoots>;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  indexerTruthKey: IndexerTruthKey | null;
  runId?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<MiningCandidate[]> {
  const bestBlockHash = options.readContext.nodeStatus?.nodeBestHashHex;

  if (bestBlockHash === null || bestBlockHash === undefined) {
    return [];
  }

  const targetBlockHeight = (options.readContext.nodeStatus?.nodeBestHeight ?? 0) + 1;
  const referencedBlockHashInternal = Buffer.from(displayToInternalBlockhash(bestBlockHash), "hex");
  const rootDomains = options.domains.map((domain) => ({
    ...domain,
    requiredWords: getWords(domain.domainId, referencedBlockHashInternal) as [string, string, string, string, string],
  }));
  const abortController = new AbortController();
  let stale = false;
  let staleIndexerTruth = false;
  let preempted = false;
  const timer = setInterval(async () => {
    try {
      const [current, truthCurrent] = await Promise.all([
        options.rpc.getBlockchainInfo(),
        indexerTruthIsCurrent({
          dataDir: options.readContext.dataDir,
          truthKey: options.indexerTruthKey,
        }),
      ]);

      if (current.bestblockhash !== bestBlockHash) {
        stale = true;
        abortController.abort();
        return;
      }

      if (!truthCurrent) {
        staleIndexerTruth = true;
        abortController.abort();
        return;
      }

      if (await isMiningGenerationAbortRequested(options.paths)) {
        preempted = true;
        abortController.abort();
      }
    } catch {
      // Ignore transient polling failures and let the main cycle degrade on the next tick.
    }
  }, BEST_BLOCK_POLL_INTERVAL_MS);

  try {
    await markMiningGenerationActive({
      paths: options.paths,
      runId: options.runId ?? null,
      pid: process.pid ?? null,
    });
    const generationRequest: MiningSentenceGenerationRequest = {
      schemaVersion: 1,
      requestId: `mining-${targetBlockHeight}-${randomBytes(8).toString("hex")}`,
      targetBlockHeight,
      referencedBlockHashDisplay: bestBlockHash,
      generatedAtUnixMs: Date.now(),
      extraPrompt: null,
      limits: createGenerateSentencesHookLimits(),
      rootDomains: rootDomains.map((domain) => ({
        domainId: domain.domainId,
        domainName: domain.domainName,
        requiredWords: domain.requiredWords,
      })),
    };
    let generated;

    try {
      generated = await generateMiningSentences(generationRequest, {
        paths: options.paths,
        provider: options.provider,
        hookState: options.readContext.localState.state.hookClientState.mining,
        signal: abortController.signal,
        fetchImpl: options.fetchImpl,
      });
    } catch (error) {
      if (stale) {
        throw new Error("mining_generation_stale_tip");
      }

      if (staleIndexerTruth) {
        throw new Error("mining_generation_stale_indexer_truth");
      }

      if (preempted) {
        throw new Error("mining_generation_preempted");
      }

      throw error;
    }

    if (stale) {
      throw new Error("mining_generation_stale_tip");
    }

    if (staleIndexerTruth) {
      throw new Error("mining_generation_stale_indexer_truth");
    }

    if (preempted) {
      throw new Error("mining_generation_preempted");
    }

    await ensureIndexerTruthIsCurrent({
      dataDir: options.readContext.dataDir,
      truthKey: options.indexerTruthKey,
    });

    if (generated.hookMode === "custom") {
      await persistCustomHookRuntimeOutcome({
        readContext: options.readContext,
        provider: options.provider,
        paths: options.paths,
        nowUnixMs: Date.now(),
        success: true,
      });
    }

    const sentencesByDomain = new Map<number, string[]>();
    for (const candidate of generated.candidates) {
      const existing = sentencesByDomain.get(candidate.domainId) ?? [];
      existing.push(candidate.sentence);
      sentencesByDomain.set(candidate.domainId, existing);
    }

    const candidates: MiningCandidate[] = [];

    for (const domain of rootDomains) {
      const domainSentences = sentencesByDomain.get(domain.domainId) ?? [];

      if (domainSentences.length === 0) {
        continue;
      }

      const assayed = await assaySentences(domain.domainId, referencedBlockHashInternal, domainSentences);
      const best = assayed.find((entry) => entry.gatesPass && entry.encodedSentenceBytes !== null && entry.rank === 1);

      if (best === undefined || best.encodedSentenceBytes === null || best.canonicalBlend === null) {
        continue;
      }

      candidates.push({
        domainId: domain.domainId,
        domainName: domain.domainName,
        localIndex: domain.localIndex,
        sender: domain.sender,
        anchorOutpoint: domain.anchorOutpoint,
        sentence: best.sentence,
        encodedSentenceBytes: best.encodedSentenceBytes,
        bip39WordIndices: [...best.bip39WordIndices],
        bip39Words: best.bip39Words,
        canonicalBlend: best.canonicalBlend,
        referencedBlockHashDisplay: bestBlockHash,
        referencedBlockHashInternal,
        targetBlockHeight,
      });
    }

    return candidates;
  } finally {
    clearInterval(timer);
    await markMiningGenerationInactive({
      paths: options.paths,
      runId: options.runId ?? null,
      pid: process.pid ?? null,
    }).catch(() => undefined);
  }
}

async function chooseBestLocalCandidate(candidates: MiningCandidate[]): Promise<MiningCandidate | null> {
  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length === 1) {
    return candidates[0]!;
  }

  const blendSeed = deriveBlendSeed(candidates[0]!.referencedBlockHashInternal);
  const winners = await settleBlock({
    blendSeed,
    blockRewardCogtoshi: 100n,
    submissions: candidates
      .slice()
      .sort((left, right) => left.domainId - right.domainId || left.domainName.localeCompare(right.domainName))
      .map((candidate, index) => ({
        miningDomainId: candidate.domainId,
        rawSentenceBytes: candidate.encodedSentenceBytes,
        recipientScriptPubKey: Buffer.from(candidate.sender.scriptPubKeyHex, "hex"),
        bip39WordIndices: candidate.bip39WordIndices,
        txIndex: index,
      })),
  });
  const winner = winners[0];

  if (winner === undefined) {
    return null;
  }

  return candidates.find((candidate) => candidate.domainId === winner.miningDomainId) ?? null;
}

async function runCompetitivenessGate(options: {
  rpc: MiningRpcClient;
  readContext: WalletReadContext & {
    snapshot: NonNullable<WalletReadContext["snapshot"]>;
  };
  candidate: MiningCandidate;
  currentTxid: string | null;
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
  });
  const walletRootId = options.readContext.localState.walletRootId ?? "uninitialized-wallet-root";
  const indexerTruthKey = getIndexerTruthKey(
    options.readContext as WalletReadContext & {
      localState: { availability: "ready"; state: WalletStateV1; unlockUntilUnixMs: number };
      snapshot: NonNullable<WalletReadContext["snapshot"]>;
    },
  );
  const localFeeTarget = DEFAULT_WALLET_MUTATION_FEE_RATE_SAT_VB;
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
    && cached.currentFeeTargetSatVb === localFeeTarget
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

  for (const txid of visibleTxids) {
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
  for (const txid of visibleTxids) {
    const context = txContexts.get(txid);

    if (context === undefined || context.effectiveFeeRate < localFeeTarget || context.payload === null || context.senderScriptHex === null) {
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
        currentFeeTargetSatVb: localFeeTarget,
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

    const assayed = await assaySentences(
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
      senderScriptHex: context.senderScriptHex,
      encodedSentenceBytesHex: Buffer.from(scored.encodedSentenceBytes).toString("hex"),
      bip39WordIndices: [...scored.bip39WordIndices],
      canonicalBlend: scored.canonicalBlend,
    });
  }

  const sameDomainCompetitors = [...entries.values()].filter((entry) => entry.domainId === options.candidate.domainId);
  const sameDomainCompetitorSuppressed = sameDomainCompetitors.some((competitor) =>
    competitor.canonicalBlend > options.candidate.canonicalBlend
    || competitor.canonicalBlend === options.candidate.canonicalBlend,
  );

  let decision: CompetitivenessDecision;
  const otherDomainBest = new Map<number, CachedCompetitorEntry>();
  for (const entry of entries.values()) {
    if (entry.domainId === options.candidate.domainId) {
      continue;
    }

    const best = otherDomainBest.get(entry.domainId);
    if (
      best === undefined
      || entry.canonicalBlend > best.canonicalBlend
      || (entry.canonicalBlend === best.canonicalBlend && entry.effectiveFeeRate > best.effectiveFeeRate)
      || (entry.canonicalBlend === best.canonicalBlend && entry.effectiveFeeRate === best.effectiveFeeRate && entry.txid.localeCompare(best.txid) < 0)
    ) {
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
    });
  } else {
    try {
      const submissions = [
        {
          miningDomainId: options.candidate.domainId,
          rawSentenceBytes: options.candidate.encodedSentenceBytes,
          recipientScriptPubKey: Buffer.from(options.candidate.sender.scriptPubKeyHex, "hex"),
          bip39WordIndices: options.candidate.bip39WordIndices,
          txIndex: 0,
        },
        ...[...otherDomainBest.values()]
          .sort((left, right) => left.domainId - right.domainId || left.txid.localeCompare(right.txid))
          .map((entry, index) => ({
            miningDomainId: entry.domainId,
            rawSentenceBytes: Buffer.from(entry.encodedSentenceBytesHex, "hex"),
            recipientScriptPubKey: Buffer.from(entry.senderScriptHex, "hex"),
            bip39WordIndices: entry.bip39WordIndices,
            txIndex: index + 1,
          })),
      ];
      const winners = await settleBlock({
        blendSeed: deriveBlendSeed(options.candidate.referencedBlockHashInternal),
        blockRewardCogtoshi: 100n,
        submissions,
      });
      const localWinner = winners.find((winner) => winner.miningDomainId === options.candidate.domainId);
      const higherRankedCompetitorDomainCount = localWinner === undefined
        ? Math.max(0, winners.length - 1)
        : Math.max(0, localWinner.rank - 1);

      if (higherRankedCompetitorDomainCount >= 5) {
        decision = createDecision({
          allowed: false,
          decision: "suppressed-top5-mempool",
          sameDomainCompetitorSuppressed: false,
          higherRankedCompetitorDomainCount,
          dedupedCompetitorDomainCount: otherDomainBest.size,
          competitivenessGateIndeterminate: false,
          mempoolSequenceCacheStatus: "refreshed",
          lastMempoolSequence: mempoolSequence,
        });
      } else {
        decision = createDecision({
          allowed: true,
          decision: "publish",
          sameDomainCompetitorSuppressed: false,
          higherRankedCompetitorDomainCount,
          dedupedCompetitorDomainCount: otherDomainBest.size,
          competitivenessGateIndeterminate: false,
          mempoolSequenceCacheStatus: "refreshed",
          lastMempoolSequence: mempoolSequence,
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
      });
    }
  }

  miningGateCache.set(walletRootId, {
    indexerDaemonInstanceId: indexerTruthKey?.daemonInstanceId ?? "none",
    indexerSnapshotSeq: indexerTruthKey?.snapshotSeq ?? "none",
    referencedBlockHashDisplay: options.candidate.referencedBlockHashDisplay,
    localAssayTupleKey,
    currentFeeTargetSatVb: localFeeTarget,
    excludedTxidsKey: excludedTxids.join(","),
    mempoolSequence,
    txids: [...visibleTxids],
    txContexts,
    decision,
  });

  return decision;
}

function candidateOutranksLive(options: {
  liveState: MiningStateRecord;
  candidate: MiningCandidate;
}): boolean {
  const liveState = normalizeMiningStateRecord(options.liveState);
  const nextSentenceHex = Buffer.from(options.candidate.encodedSentenceBytes).toString("hex");

  if (liveState.currentEncodedSentenceBytesHex === null) {
    return true;
  }

  if (liveState.currentDomainId === options.candidate.domainId) {
    if (liveState.currentEncodedSentenceBytesHex === nextSentenceHex) {
      return false;
    }

    const currentScore = liveState.currentScore === null ? null : BigInt(liveState.currentScore);
    return currentScore === null || options.candidate.canonicalBlend > currentScore;
  }

  return true;
}

function candidateMatchesLiveFamily(options: {
  liveState: MiningStateRecord;
  candidate: MiningCandidate;
}): boolean {
  const liveState = normalizeMiningStateRecord(options.liveState);
  return liveState.currentDomainId === options.candidate.domainId
    && liveState.currentEncodedSentenceBytesHex === Buffer.from(options.candidate.encodedSentenceBytes).toString("hex")
    && liveState.currentSenderScriptPubKeyHex === options.candidate.sender.scriptPubKeyHex
    && liveState.currentReferencedBlockHashDisplay === options.candidate.referencedBlockHashDisplay
    && liveState.currentBlockTargetHeight === options.candidate.targetBlockHeight;
}

function candidateNeedsFeeMaintenance(options: {
  liveState: MiningStateRecord;
  candidate: MiningCandidate;
}): boolean {
  const liveState = normalizeMiningStateRecord(options.liveState);
  return candidateMatchesLiveFamily(options)
    && liveState.currentTxid !== null
    && liveState.currentFeeRateSatVb !== null
    && liveState.currentPublishState === "in-mempool"
    && liveState.liveMiningFamilyInMempool === true;
}

async function candidateWinsAgainstLive(options: {
  liveState: MiningStateRecord;
  candidate: MiningCandidate;
}): Promise<boolean> {
  const liveState = normalizeMiningStateRecord(options.liveState);

  if (liveState.currentDomainId === null || liveState.currentEncodedSentenceBytesHex === null) {
    return true;
  }

  if (liveState.currentDomainId === options.candidate.domainId) {
    return candidateOutranksLive(options);
  }

  if (liveState.currentBip39WordIndices === null || liveState.currentSenderScriptPubKeyHex === null || liveState.currentBlendSeedHex === null) {
    return true;
  }

  const settled = await settleBlock({
    blendSeed: Buffer.from(liveState.currentBlendSeedHex, "hex"),
    blockRewardCogtoshi: 100n,
    submissions: [
      {
        miningDomainId: liveState.currentDomainId,
        rawSentenceBytes: Buffer.from(liveState.currentEncodedSentenceBytesHex, "hex"),
        recipientScriptPubKey: Buffer.from(liveState.currentSenderScriptPubKeyHex, "hex"),
        bip39WordIndices: liveState.currentBip39WordIndices,
        txIndex: 0,
      },
      {
        miningDomainId: options.candidate.domainId,
        rawSentenceBytes: options.candidate.encodedSentenceBytes,
        recipientScriptPubKey: Buffer.from(options.candidate.sender.scriptPubKeyHex, "hex"),
        bip39WordIndices: options.candidate.bip39WordIndices,
        txIndex: 1,
      },
    ],
  });
  const incumbent = settled.find((entry) => entry.miningDomainId === liveState.currentDomainId);
  const challenger = settled.find((entry) => entry.miningDomainId === options.candidate.domainId);
  return challenger !== undefined
    && incumbent !== undefined
    && challenger.rank < incumbent.rank;
}

function miningCandidateIsCurrent(options: {
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

async function rebuildPersistentAnchorLocks(options: {
  state: WalletStateV1;
  rpc: MiningRpcClient;
}): Promise<void> {
  const walletName = options.state.managedCoreWallet.walletName;
  const [locked, spendable] = await Promise.all([
    options.rpc.listLockUnspent(walletName).catch(() => []),
    options.rpc.listUnspent(walletName, 0).catch(() => []),
  ]);
  const spendableKeys = new Set(spendable.map((entry) => `${entry.txid}:${entry.vout}`));
  const expected = options.state.domains
    .map((domain) => domain.currentCanonicalAnchorOutpoint)
    .filter((outpoint): outpoint is NonNullable<WalletStateV1["domains"][number]["currentCanonicalAnchorOutpoint"]> => outpoint !== null)
    .map((outpoint) => ({ txid: outpoint.txid, vout: outpoint.vout }))
    .filter((outpoint) => spendableKeys.has(`${outpoint.txid}:${outpoint.vout}`));
  const expectedKeys = new Set(expected.map((outpoint) => `${outpoint.txid}:${outpoint.vout}`));
  const lockedKeys = new Set(locked.map((outpoint) => `${outpoint.txid}:${outpoint.vout}`));
  const staleLocked = locked.filter((outpoint) =>
    !expectedKeys.has(`${outpoint.txid}:${outpoint.vout}`)
    || !spendableKeys.has(`${outpoint.txid}:${outpoint.vout}`),
  );
  const missingLocked = expected.filter((outpoint) => !lockedKeys.has(`${outpoint.txid}:${outpoint.vout}`));

  if (staleLocked.length > 0) {
    await options.rpc.lockUnspent(walletName, true, staleLocked).catch(() => undefined);
  }

  if (missingLocked.length > 0) {
    await options.rpc.lockUnspent(walletName, false, missingLocked).catch(() => undefined);
  }
}

async function reconcileLiveMiningState(options: {
  state: WalletStateV1;
  rpc: MiningRpcClient;
  nodeBestHash: string | null;
  nodeBestHeight: number | null;
}): Promise<WalletStateV1> {
  let state = {
    ...options.state,
    miningState: normalizeMiningStateRecord(options.state.miningState),
  };
  const currentTxid = state.miningState.currentTxid;

  if (currentTxid === null || !miningFamilyMayStillExist(state.miningState)) {
    await rebuildPersistentAnchorLocks({ state, rpc: options.rpc });
    return state;
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
    state = {
      ...state,
      miningState: {
        ...clearMiningFamilyState(state.miningState),
        currentPublishDecision: "tx-confirmed-while-down",
      },
    };
    await rebuildPersistentAnchorLocks({ state, rpc: options.rpc });
    return state;
  }

  if (inMempool) {
    const stale = !miningCandidateIsCurrent({
      state: state.miningState,
      nodeBestHash: options.nodeBestHash,
      nodeBestHeight: options.nodeBestHeight,
    });
    state = defaultMiningStatePatch(state, {
      liveMiningFamilyInMempool: true,
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
      currentPublishDecision: stale ? "paused-stale-mempool" : "restored-live-family",
    });
    await rebuildPersistentAnchorLocks({ state, rpc: options.rpc });
    return state;
  }

  if ((walletTx?.walletconflicts?.length ?? 0) > 0) {
    state = defaultMiningStatePatch(state, {
      state: "repair-required",
      pauseReason: state.miningState.currentPublishState === "broadcast-unknown"
        ? "broadcast-unknown-conflict"
        : "wallet-conflict-observed",
      liveMiningFamilyInMempool: false,
      currentPublishDecision: state.miningState.currentPublishState === "broadcast-unknown"
        ? "repair-required-broadcast-conflict"
        : "repair-required-wallet-conflict",
    });
    await rebuildPersistentAnchorLocks({ state, rpc: options.rpc });
    return state;
  }

  state = defaultMiningStatePatch(state, {
    ...clearMiningFamilyState(state.miningState),
    currentPublishDecision: state.miningState.currentPublishState === "broadcast-unknown"
      ? "broadcast-unknown-not-seen"
      : "live-family-not-seen",
  });
  await rebuildPersistentAnchorLocks({ state, rpc: options.rpc });
  return state;
}

async function publishCandidate(options: {
  readContext: WalletReadContext & {
    localState: { availability: "ready"; state: WalletStateV1; unlockUntilUnixMs: number };
    snapshot: NonNullable<WalletReadContext["snapshot"]>;
    model: NonNullable<WalletReadContext["model"]>;
  };
  candidate: MiningCandidate;
  dataDir: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  attachService: typeof attachOrStartManagedBitcoindService;
  rpcFactory: (config: Parameters<typeof createRpcClient>[0]) => MiningRpcClient;
  runId: string | null;
}): Promise<{ state: WalletStateV1; txid: string | null; decision: string }> {
  const service = await options.attachService({
    dataDir: options.dataDir,
    chain: "main",
    startHeight: 0,
    walletRootId: options.readContext.localState.state.walletRootId,
  });
  const rpc = options.rpcFactory(service.rpc);
  let state = await reconcileLiveMiningState({
    state: options.readContext.localState.state,
    rpc,
    nodeBestHash: options.readContext.nodeStatus?.nodeBestHashHex ?? null,
    nodeBestHeight: options.readContext.nodeStatus?.nodeBestHeight ?? null,
  });
  const allUtxos = await rpc.listUnspent(state.managedCoreWallet.walletName, 0);
  const fundingConflict = state.miningState.sharedMiningConflictOutpoint
    ?? allUtxos.find((entry) =>
      entry.scriptPubKey === state.funding.scriptPubKeyHex
      && entry.confirmations >= 1
      && entry.spendable !== false
      && entry.safe !== false
      && !(entry.txid === options.candidate.anchorOutpoint.txid && entry.vout === options.candidate.anchorOutpoint.vout)
    );

  if (fundingConflict === undefined || fundingConflict === null) {
    throw new Error("wallet_mining_missing_conflict_utxo");
  }

  const conflictOutpoint = "txid" in fundingConflict
    ? { txid: fundingConflict.txid, vout: fundingConflict.vout }
    : fundingConflict;
  const priorMiningState = cloneMiningState(state.miningState);
  const nextFeeRate = state.miningState.currentFeeRateSatVb === null
    ? DEFAULT_WALLET_MUTATION_FEE_RATE_SAT_VB
    : state.miningState.currentFeeRateSatVb + 1;
  const shouldFeeBump = candidateNeedsFeeMaintenance({
    liveState: state.miningState,
    candidate: options.candidate,
  });

  if (
    state.miningState.currentPublishState === "in-mempool"
    && state.miningState.liveMiningFamilyInMempool === true
    && !shouldFeeBump
    && !await candidateWinsAgainstLive({
      liveState: state.miningState,
      candidate: options.candidate,
    })
  ) {
    return {
      state: defaultMiningStatePatch(state, {
        currentPublishDecision: "kept-live-family",
      }),
      txid: state.miningState.currentTxid,
      decision: "kept-live-family",
    };
  }

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
    liveMiningFamilyInMempool: null,
    currentPublishDecision: priorMiningState.currentTxid === null
      ? "publishing"
      : shouldFeeBump
        ? "fee-bump"
        : "replacing",
  });
  await saveWalletStatePreservingUnlock({
    state,
    provider: options.provider,
    unlockUntilUnixMs: options.readContext.localState.unlockUntilUnixMs,
    nowUnixMs: Date.now(),
    paths: options.paths,
  });

  try {
    await rpc.sendRawTransaction(built.rawHex);
  } catch (error) {
    if (isAlreadyAcceptedError(error)) {
      state = defaultMiningStatePatch(state, {
        currentPublishState: "in-mempool",
        liveMiningFamilyInMempool: true,
      });
      await saveWalletStatePreservingUnlock({
        state,
        provider: options.provider,
        unlockUntilUnixMs: options.readContext.localState.unlockUntilUnixMs,
        nowUnixMs: Date.now(),
        paths: options.paths,
      });
      await appendEvent(options.paths, createEvent(
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
      return {
        state,
        txid: built.txid,
        decision: state.miningState.currentPublishDecision === "fee-bump"
          ? "fee-bump"
          : state.miningState.currentPublishDecision === "replacing"
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
        unlockUntilUnixMs: options.readContext.localState.unlockUntilUnixMs,
        nowUnixMs: Date.now(),
        paths: options.paths,
      });
      await appendEvent(options.paths, createEvent(
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
      return {
        state,
        txid: built.txid,
        decision: "broadcast-unknown",
      };
    }

    throw error;
  }

  const absoluteFeeSats = numberToSats(built.funded.fee);
  const replacementCount = priorMiningState.currentTxid === null
    ? priorMiningState.replacementCount
    : priorMiningState.replacementCount + 1;
  state = defaultMiningStatePatch(state, {
    currentPublishState: "in-mempool",
    liveMiningFamilyInMempool: true,
    currentPublishDecision: state.miningState.currentPublishDecision === "fee-bump"
      ? "fee-bump"
      : state.miningState.currentPublishDecision === "replacing"
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
    unlockUntilUnixMs: options.readContext.localState.unlockUntilUnixMs,
    nowUnixMs: Date.now(),
    paths: options.paths,
  });
  await appendEvent(options.paths, createEvent(
    state.miningState.currentPublishDecision === "replaced"
      ? "tx-replaced"
      : state.miningState.currentPublishDecision === "fee-bump"
        ? "tx-fee-bump"
        : "tx-broadcast",
    `${state.miningState.currentPublishDecision === "replaced"
      ? "Replaced"
      : state.miningState.currentPublishDecision === "fee-bump"
        ? "Fee-bumped"
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

  return {
    state,
    txid: built.txid,
    decision: state.miningState.currentPublishDecision === "fee-bump"
      ? "fee-bump"
      : state.miningState.currentPublishDecision === "replaced"
        ? "replaced"
        : "broadcast",
  };
}

async function ensureBuiltInSetupIfNeeded(options: {
  provider: WalletSecretProvider;
  prompter: WalletPrompter;
  paths: WalletRuntimePaths;
}): Promise<boolean> {
  const unlocked = await loadOrAutoUnlockWalletState({
    provider: options.provider,
    paths: options.paths,
  });

  if (unlocked?.state.hookClientState.mining.mode === "custom") {
    return true;
  }

  const config = await loadClientConfig({
    path: options.paths.clientConfigPath,
    provider: options.provider,
  }).catch(() => null);

  if (config?.mining.builtIn !== null) {
    return true;
  }

  if (options.prompter.isInteractive === false) {
    return false;
  }

  await setupBuiltInMining({
    provider: options.provider,
    prompter: options.prompter,
    paths: options.paths,
  });
  return true;
}

async function performMiningCycle(options: {
  dataDir: string;
  databasePath: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  runMode: "foreground" | "background";
  backgroundWorkerPid: number | null;
  backgroundWorkerRunId: string | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  openReadContext: typeof openWalletReadContext;
  attachService: typeof attachOrStartManagedBitcoindService;
  rpcFactory: (config: Parameters<typeof createRpcClient>[0]) => MiningRpcClient;
  stdout?: { write(chunk: string): void };
  suspendDetector?: MiningSuspendDetector;
  visualizer?: MiningFollowVisualizer;
}): Promise<void> {
  let readContext: WalletReadContext | null = await options.openReadContext({
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    secretProvider: options.provider,
    paths: options.paths,
  });
  let readContextClosed = false;

  try {
    checkpointMiningSuspendDetector(options.suspendDetector);
    await refreshAndSaveStatus({
      paths: options.paths,
      provider: options.provider,
      readContext,
      overrides: {
        runMode: options.runMode,
        backgroundWorkerPid: options.backgroundWorkerPid,
        backgroundWorkerRunId: options.backgroundWorkerRunId,
        backgroundWorkerHeartbeatAtUnixMs: options.runMode === "background" ? Date.now() : null,
      },
    });

    if (readContext.localState.availability !== "ready" || readContext.localState.state === null || readContext.localState.unlockUntilUnixMs === null) {
      await refreshAndSaveStatus({
        paths: options.paths,
        provider: options.provider,
        readContext,
        overrides: {
          runMode: options.runMode,
          currentPhase: "waiting",
          note: "Wallet must stay unlocked for mining to continue.",
        },
        visualizer: options.visualizer,
      });
      return;
    }

    const service = await options.attachService({
      dataDir: options.dataDir,
      chain: "main",
      startHeight: 0,
      walletRootId: readContext.localState.state.walletRootId,
    });
    checkpointMiningSuspendDetector(options.suspendDetector);
    const rpc = options.rpcFactory(service.rpc);
    const reconciledState = await reconcileLiveMiningState({
      state: readContext.localState.state,
      rpc,
      nodeBestHash: readContext.nodeStatus?.nodeBestHashHex ?? null,
      nodeBestHeight: readContext.nodeStatus?.nodeBestHeight ?? null,
    });
    checkpointMiningSuspendDetector(options.suspendDetector);
    let effectiveReadContext = readContext as WalletReadContext & {
      localState: { availability: "ready"; state: WalletStateV1; unlockUntilUnixMs: number };
    };

    if (JSON.stringify(reconciledState.miningState) !== JSON.stringify(readContext.localState.state.miningState)) {
      await saveWalletStatePreservingUnlock({
        state: reconciledState,
        provider: options.provider,
        unlockUntilUnixMs: readContext.localState.unlockUntilUnixMs,
        nowUnixMs: Date.now(),
        paths: options.paths,
      });
      effectiveReadContext = {
        ...readContext,
        localState: {
          ...readContext.localState,
          availability: "ready",
          unlockUntilUnixMs: readContext.localState.unlockUntilUnixMs,
          state: reconciledState,
        },
      };
    }

    if (effectiveReadContext.localState.state.miningState.state === "repair-required") {
      await refreshAndSaveStatus({
        paths: options.paths,
        provider: options.provider,
        readContext: effectiveReadContext,
        overrides: {
          runMode: options.runMode,
          currentPhase: "waiting",
          note: "Mining is blocked until the current mining family is repaired or reconciled.",
        },
        visualizer: options.visualizer,
      });
      return;
    }

    if (hasBlockingMutation(effectiveReadContext.localState.state)) {
      const nextState = defaultMiningStatePatch(effectiveReadContext.localState.state, {
        state: "paused",
        pauseReason: "wallet-busy",
      });
      await saveWalletStatePreservingUnlock({
        state: nextState,
        provider: options.provider,
        unlockUntilUnixMs: effectiveReadContext.localState.unlockUntilUnixMs,
        nowUnixMs: Date.now(),
        paths: options.paths,
      });
      effectiveReadContext = {
        ...effectiveReadContext,
        localState: {
          ...effectiveReadContext.localState,
          availability: "ready",
          unlockUntilUnixMs: effectiveReadContext.localState.unlockUntilUnixMs,
          state: nextState,
        },
      };
      await refreshAndSaveStatus({
        paths: options.paths,
        provider: options.provider,
        readContext: effectiveReadContext,
        overrides: {
          runMode: options.runMode,
          currentPhase: "waiting",
          note: "Mining is paused while another wallet mutation family is active.",
        },
        visualizer: options.visualizer,
      });
      return;
    }

    const preemptionRequest = await readMiningPreemptionRequest(options.paths);
    if (preemptionRequest !== null) {
      const nextState = defaultMiningStatePatch(effectiveReadContext.localState.state, {
        state: effectiveReadContext.localState.state.miningState.liveMiningFamilyInMempool
          && effectiveReadContext.localState.state.miningState.state === "paused-stale"
          ? "paused-stale"
          : "paused",
        pauseReason: preemptionRequest.reason,
      });
      await saveWalletStatePreservingUnlock({
        state: nextState,
        provider: options.provider,
        unlockUntilUnixMs: effectiveReadContext.localState.unlockUntilUnixMs,
        nowUnixMs: Date.now(),
        paths: options.paths,
      });
      await refreshAndSaveStatus({
        paths: options.paths,
        provider: options.provider,
        readContext: {
          ...effectiveReadContext,
          localState: {
            ...effectiveReadContext.localState,
            state: nextState,
          },
        },
        overrides: {
          runMode: options.runMode,
          currentPhase: "waiting",
          note: "Mining is paused while another wallet command is preempting sentence generation.",
        },
        visualizer: options.visualizer,
      });
      return;
    }

    const [blockchainInfo, networkInfo, mempoolInfo] = await Promise.all([
      rpc.getBlockchainInfo(),
      rpc.getNetworkInfo(),
      rpc.getMempoolInfo(),
    ]);
    checkpointMiningSuspendDetector(options.suspendDetector);
    const corePublishState = determineCorePublishState({
      blockchain: blockchainInfo,
      network: networkInfo,
      mempool: mempoolInfo,
    });

    if (corePublishState !== "healthy") {
      await refreshAndSaveStatus({
        paths: options.paths,
        provider: options.provider,
        readContext: effectiveReadContext,
        overrides: {
          runMode: options.runMode,
          currentPhase: "waiting-bitcoin-network",
          corePublishState,
          note: "Mining is waiting for the local Bitcoin node to become publishable.",
        },
        visualizer: options.visualizer,
      });
      return;
    }

    if (effectiveReadContext.indexer.health !== "synced" || effectiveReadContext.nodeHealth !== "synced") {
      await refreshAndSaveStatus({
        paths: options.paths,
        provider: options.provider,
        readContext: effectiveReadContext,
        overrides: {
          runMode: options.runMode,
          currentPhase: effectiveReadContext.indexer.health !== "synced"
            ? "waiting-indexer"
            : "waiting-bitcoin-network",
          note: effectiveReadContext.indexer.health !== "synced"
            ? "Mining is waiting for Bitcoin Core and the indexer to align."
            : "Mining is waiting for the local Bitcoin node to become publishable.",
        },
        visualizer: options.visualizer,
      });
      return;
    }

    const targetBlockHeight = (effectiveReadContext.nodeStatus?.nodeBestHeight ?? 0) + 1;
    if (getBlockRewardCogtoshi(targetBlockHeight) === 0n) {
      const nextState = defaultMiningStatePatch(effectiveReadContext.localState.state, {
        state: "paused",
        pauseReason: "zero-reward",
      });
      await saveWalletStatePreservingUnlock({
        state: nextState,
        provider: options.provider,
        unlockUntilUnixMs: effectiveReadContext.localState.unlockUntilUnixMs,
        nowUnixMs: Date.now(),
        paths: options.paths,
      });
      await refreshAndSaveStatus({
        paths: options.paths,
        provider: options.provider,
        readContext: {
          ...effectiveReadContext,
          localState: {
            ...effectiveReadContext.localState,
            state: nextState,
          },
        },
        overrides: {
          runMode: options.runMode,
          currentPhase: "idle",
          currentPublishDecision: "publish-skipped-zero-reward",
          note: "Mining is disabled because the target block reward is zero.",
        },
        visualizer: options.visualizer,
      });
      await appendEvent(options.paths, createEvent(
        "publish-skipped-zero-reward",
        "Skipped mining because the target block reward is zero.",
        {
          targetBlockHeight,
          referencedBlockHashDisplay: effectiveReadContext.nodeStatus?.nodeBestHashHex ?? null,
          runId: options.backgroundWorkerRunId,
        },
      ));
      return;
    }

    const domains = resolveEligibleAnchoredRoots(effectiveReadContext);
    if (domains.length === 0) {
      await refreshAndSaveStatus({
        paths: options.paths,
        provider: options.provider,
        readContext: effectiveReadContext,
        overrides: {
          runMode: options.runMode,
          currentPhase: "idle",
          note: "No locally controlled anchored root domains are currently eligible to mine.",
        },
        visualizer: options.visualizer,
      });
      return;
    }

    const indexerTruthKey = getIndexerTruthKey(
      effectiveReadContext as WalletReadContext & {
        localState: { availability: "ready"; state: WalletStateV1; unlockUntilUnixMs: number };
        snapshot: NonNullable<WalletReadContext["snapshot"]>;
      },
    );
    const walletRootId = effectiveReadContext.localState.walletRootId;
    const ensureCurrentIndexerTruthOrRestart = async (): Promise<boolean> => {
      try {
        await ensureIndexerTruthIsCurrent({
          dataDir: effectiveReadContext.dataDir,
          truthKey: indexerTruthKey,
        });
        return true;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "mining_generation_stale_indexer_truth") {
          throw error;
        }

        clearMiningGateCache(walletRootId);
        await appendEvent(options.paths, createEvent(
          "generation-restarted-indexer-truth",
          "Detected updated coherent indexer truth during mining; restarting on the next tick.",
          {
            level: "warn",
            targetBlockHeight,
            referencedBlockHashDisplay: effectiveReadContext.nodeStatus?.nodeBestHashHex ?? null,
            runId: options.backgroundWorkerRunId,
          },
        ));
        return false;
      }
    };

    await refreshAndSaveStatus({
      paths: options.paths,
      provider: options.provider,
      readContext: effectiveReadContext,
      overrides: {
        runMode: options.runMode,
        currentPhase: "generating",
        note: "Generating mining sentences for eligible root domains.",
      },
      visualizer: options.visualizer,
    });

    await appendEvent(options.paths, createEvent(
      "hook-request-start",
      "Started mining sentence generation.",
      {
        targetBlockHeight,
        referencedBlockHashDisplay: effectiveReadContext.nodeStatus?.nodeBestHashHex ?? null,
        runId: options.backgroundWorkerRunId,
      },
    ));
    let candidates: MiningCandidate[];

    try {
      candidates = await generateCandidatesForDomains({
        rpc,
        readContext: effectiveReadContext as WalletReadContext & {
          localState: { availability: "ready"; state: WalletStateV1; unlockUntilUnixMs: number };
          snapshot: NonNullable<WalletReadContext["snapshot"]>;
          model: NonNullable<WalletReadContext["model"]>;
        },
        domains,
        provider: options.provider,
        paths: options.paths,
        indexerTruthKey,
        runId: options.backgroundWorkerRunId,
        fetchImpl: options.fetchImpl,
      });
      checkpointMiningSuspendDetector(options.suspendDetector);
    } catch (error) {
      if (error instanceof MiningProviderRequestError) {
        await refreshAndSaveStatus({
          paths: options.paths,
          provider: options.provider,
          readContext: effectiveReadContext,
          overrides: {
            runMode: options.runMode,
            currentPhase: "waiting-provider",
            providerState: error.providerState,
            lastError: error.message,
            note: "Mining is waiting for the sentence provider to recover.",
          },
          visualizer: options.visualizer,
        });
        await appendEvent(options.paths, createEvent(
          "publish-paused-provider",
          error.message,
          {
            level: "warn",
            targetBlockHeight,
            referencedBlockHashDisplay: effectiveReadContext.nodeStatus?.nodeBestHashHex ?? null,
            runId: options.backgroundWorkerRunId,
          },
        ));
        return;
      }

      if (error instanceof Error && error.message === "mining_generation_stale_tip") {
        await appendEvent(options.paths, createEvent(
          "generation-restarted-new-tip",
          "Detected a new best tip during sentence generation; restarting on the next tick.",
          {
            level: "warn",
            targetBlockHeight,
            referencedBlockHashDisplay: effectiveReadContext.nodeStatus?.nodeBestHashHex ?? null,
            runId: options.backgroundWorkerRunId,
          },
        ));
        return;
      }

      if (error instanceof Error && error.message === "mining_generation_stale_indexer_truth") {
        clearMiningGateCache(walletRootId);
        await appendEvent(options.paths, createEvent(
          "generation-restarted-indexer-truth",
          "Detected updated coherent indexer truth during sentence generation; restarting on the next tick.",
          {
            level: "warn",
            targetBlockHeight,
            referencedBlockHashDisplay: effectiveReadContext.nodeStatus?.nodeBestHashHex ?? null,
            runId: options.backgroundWorkerRunId,
          },
        ));
        return;
      }

      if (error instanceof Error && error.message === "mining_generation_preempted") {
        await appendEvent(options.paths, createEvent(
          "generation-paused-preempted",
          "Stopped sentence generation because another wallet command requested mining preemption.",
          {
            level: "warn",
            targetBlockHeight,
            referencedBlockHashDisplay: effectiveReadContext.nodeStatus?.nodeBestHashHex ?? null,
            runId: options.backgroundWorkerRunId,
          },
        ));
        return;
      }

      const hookCooldownActive = await persistCustomHookRuntimeOutcome({
        readContext: effectiveReadContext as WalletReadContext & {
          localState: { availability: "ready"; state: WalletStateV1; unlockUntilUnixMs: number };
        },
        provider: options.provider,
        paths: options.paths,
        nowUnixMs: Date.now(),
        success: false,
      });
      const failureMessage = error instanceof Error ? error.message : String(error);

      await refreshAndSaveStatus({
        paths: options.paths,
        provider: options.provider,
        readContext: effectiveReadContext,
        overrides: {
          runMode: options.runMode,
          currentPhase: "waiting-provider",
          providerState: effectiveReadContext.localState.state?.hookClientState.mining.mode === "custom"
            ? "hook-error"
            : undefined,
          lastError: failureMessage,
          note: effectiveReadContext.localState.state?.hookClientState.mining.mode === "custom"
            ? (hookCooldownActive
              ? "Custom mining hook launch is paused during the post-failure cooldown window."
              : "Custom mining hook failed during sentence generation. Fix it or rerun `cogcoin hooks enable mining`.")
            : "Mining sentence generation failed for the current tip.",
        },
        visualizer: options.visualizer,
      });
      await appendEvent(options.paths, createEvent(
        "hook-request-failed",
        failureMessage,
        {
          level: "error",
          targetBlockHeight,
          referencedBlockHashDisplay: effectiveReadContext.nodeStatus?.nodeBestHashHex ?? null,
          runId: options.backgroundWorkerRunId,
        },
      ));
      return;
    }

    await refreshAndSaveStatus({
      paths: options.paths,
      provider: options.provider,
      readContext: effectiveReadContext,
      overrides: {
        runMode: options.runMode,
        currentPhase: "scoring",
        note: "Scoring mining candidates for the current tip.",
      },
      visualizer: options.visualizer,
    });

    const best = await chooseBestLocalCandidate(candidates);
    if (best === null) {
      await refreshAndSaveStatus({
        paths: options.paths,
        provider: options.provider,
        readContext: effectiveReadContext,
        overrides: {
          runMode: options.runMode,
          currentPhase: "idle",
          currentPublishDecision: "publish-skipped-no-candidate",
          note: "No publishable mining candidate passed scoring gates for the current tip.",
        },
        visualizer: options.visualizer,
      });
      await appendEvent(options.paths, createEvent(
        "publish-skipped-no-candidate",
        "No publishable mining candidate passed scoring gates.",
        {
          targetBlockHeight,
          referencedBlockHashDisplay: effectiveReadContext.nodeStatus?.nodeBestHashHex ?? null,
          runId: options.backgroundWorkerRunId,
        },
      ));
      return;
    }

    if (!await ensureCurrentIndexerTruthOrRestart()) {
      return;
    }

    writeStdout(options.stdout, `Selected ${best.domainName}: ${best.sentence} (${best.canonicalBlend.toString()})`);
    await appendEvent(options.paths, createEvent(
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

    const gate = await runCompetitivenessGate({
      rpc,
      readContext: effectiveReadContext as WalletReadContext & { snapshot: NonNullable<WalletReadContext["snapshot"]> },
      candidate: best,
      currentTxid: effectiveReadContext.localState.state.miningState.currentTxid,
    });
    checkpointMiningSuspendDetector(options.suspendDetector);

    if (!gate.allowed) {
      await refreshAndSaveStatus({
        paths: options.paths,
        provider: options.provider,
        readContext: effectiveReadContext,
        overrides: {
          runMode: options.runMode,
          currentPhase: "waiting",
          currentPublishDecision: gate.decision,
          sameDomainCompetitorSuppressed: gate.sameDomainCompetitorSuppressed,
          higherRankedCompetitorDomainCount: gate.higherRankedCompetitorDomainCount,
          dedupedCompetitorDomainCount: gate.dedupedCompetitorDomainCount,
          competitivenessGateIndeterminate: gate.competitivenessGateIndeterminate,
          mempoolSequenceCacheStatus: gate.mempoolSequenceCacheStatus,
          lastMempoolSequence: gate.lastMempoolSequence,
          lastCompetitivenessGateAtUnixMs: Date.now(),
          note: gate.decision === "suppressed-same-domain-mempool"
            ? "Best local sentence found, but a same-domain mempool competitor already matches or beats it."
            : gate.decision === "suppressed-top5-mempool"
              ? `Best local sentence found, but ${gate.higherRankedCompetitorDomainCount} stronger competitor root domains are already in mempool.`
              : "Mining skipped this tick because the mempool competitiveness gate could not be verified safely.",
        },
        visualizer: options.visualizer,
      });
      await appendEvent(options.paths, createEvent(
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

    if (!await ensureCurrentIndexerTruthOrRestart()) {
      return;
    }

    await refreshAndSaveStatus({
      paths: options.paths,
      provider: options.provider,
      readContext: effectiveReadContext,
      overrides: {
        runMode: options.runMode,
        currentPhase: effectiveReadContext.localState.state.miningState.currentTxid === null
          ? "publishing"
          : "replacing",
        note: effectiveReadContext.localState.state.miningState.currentTxid === null
          ? "Broadcasting the best mining candidate for the current tip."
          : "Replacing the live mining transaction for the current tip.",
      },
      visualizer: options.visualizer,
    });

    const publishLock = await acquireFileLock(options.paths.walletControlLockPath, {
      purpose: "wallet-mine",
      walletRootId: effectiveReadContext.localState.state.walletRootId,
    });
    checkpointMiningSuspendDetector(options.suspendDetector);

    try {
      if (!await ensureCurrentIndexerTruthOrRestart()) {
        return;
      }

      checkpointMiningSuspendDetector(options.suspendDetector);
      const published = await publishCandidate({
        readContext: effectiveReadContext as WalletReadContext & {
          localState: { availability: "ready"; state: WalletStateV1; unlockUntilUnixMs: number };
          snapshot: NonNullable<WalletReadContext["snapshot"]>;
          model: NonNullable<WalletReadContext["model"]>;
        },
        candidate: best,
        dataDir: options.dataDir,
        provider: options.provider,
        paths: options.paths,
        attachService: options.attachService,
        rpcFactory: options.rpcFactory,
        runId: options.backgroundWorkerRunId,
      });
      checkpointMiningSuspendDetector(options.suspendDetector);

      await refreshAndSaveStatus({
        paths: options.paths,
        provider: options.provider,
        readContext: {
          ...effectiveReadContext,
          localState: {
            ...effectiveReadContext.localState,
            state: published.state,
          },
        },
        overrides: {
          runMode: options.runMode,
          currentPhase: "publishing",
          currentPublishDecision: published.decision,
          sameDomainCompetitorSuppressed: false,
          higherRankedCompetitorDomainCount: gate.higherRankedCompetitorDomainCount,
          dedupedCompetitorDomainCount: gate.dedupedCompetitorDomainCount,
          competitivenessGateIndeterminate: false,
          mempoolSequenceCacheStatus: gate.mempoolSequenceCacheStatus,
          lastMempoolSequence: gate.lastMempoolSequence,
          lastCompetitivenessGateAtUnixMs: Date.now(),
          note: published.txid === null
            ? "Mining candidate was evaluated but the existing live family stayed in place."
            : `Mining candidate ${published.decision === "replaced"
              ? "replaced"
              : published.decision === "fee-bump"
                ? "fee-bumped"
                : "broadcast"} as ${published.txid}.`,
          liveMiningFamilyInMempool: published.state.miningState.liveMiningFamilyInMempool,
        },
        visualizer: options.visualizer,
      });
    } finally {
      await publishLock.release();
    }
  } catch (error) {
    if (error instanceof MiningSuspendDetectedError) {
      if (readContext !== null && !readContextClosed) {
        await readContext.close();
        readContextClosed = true;
      }
      await handleDetectedMiningRuntimeResume({
        dataDir: options.dataDir,
        databasePath: options.databasePath,
        provider: options.provider,
        paths: options.paths,
        runMode: options.runMode,
        backgroundWorkerPid: options.backgroundWorkerPid,
        backgroundWorkerRunId: options.backgroundWorkerRunId,
        detectedAtUnixMs: error.detectedAtUnixMs,
        openReadContext: options.openReadContext,
        visualizer: options.visualizer,
      });
      return;
    }

    throw error;
  } finally {
    if (readContext !== null && !readContextClosed) {
      await readContext.close();
    }
  }
}

async function saveStopSnapshot(options: {
  dataDir: string;
  databasePath: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  runMode: "foreground" | "background";
  backgroundWorkerPid: number | null;
  backgroundWorkerRunId: string | null;
  note: string | null;
}): Promise<void> {
  const readContext = await openWalletReadContext({
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    secretProvider: options.provider,
    paths: options.paths,
  });

  try {
    let localState = readContext.localState;

    if (localState.availability === "ready" && localState.state !== null && localState.unlockUntilUnixMs !== null) {
      const service = await attachOrStartManagedBitcoindService({
        dataDir: options.dataDir,
        chain: "main",
        startHeight: 0,
        walletRootId: localState.state.walletRootId,
      }).catch(() => null);

      if (service !== null) {
        const rpc = createRpcClient(service.rpc) as MiningRpcClient;
        const reconciledState = await reconcileLiveMiningState({
          state: localState.state,
          rpc,
          nodeBestHash: readContext.nodeStatus?.nodeBestHashHex ?? null,
          nodeBestHeight: readContext.nodeStatus?.nodeBestHeight ?? null,
        });
        const stopState = defaultMiningStatePatch(reconciledState, {
          runMode: "stopped",
          state: reconciledState.miningState.liveMiningFamilyInMempool
            ? reconciledState.miningState.state === "paused-stale"
              ? "paused-stale"
              : "paused"
            : reconciledState.miningState.state === "repair-required"
              ? "repair-required"
              : "idle",
          pauseReason: reconciledState.miningState.liveMiningFamilyInMempool
            ? reconciledState.miningState.state === "paused-stale"
              ? "stale-block-context"
              : "user-stopped"
            : reconciledState.miningState.state === "repair-required"
              ? reconciledState.miningState.pauseReason
              : null,
        });
        await saveWalletStatePreservingUnlock({
          state: stopState,
          provider: options.provider,
          unlockUntilUnixMs: localState.unlockUntilUnixMs,
          nowUnixMs: Date.now(),
          paths: options.paths,
        });
        localState = {
          ...localState,
          state: stopState,
        };
      }
    }

    await refreshAndSaveStatus({
      paths: options.paths,
      provider: options.provider,
      readContext: {
        ...readContext,
        localState,
      },
      overrides: {
        runMode: "stopped",
        backgroundWorkerPid: options.runMode === "background" ? null : options.backgroundWorkerPid,
        backgroundWorkerRunId: options.runMode === "background" ? null : options.backgroundWorkerRunId,
        backgroundWorkerHeartbeatAtUnixMs: options.runMode === "background" ? null : Date.now(),
        currentPhase: "idle",
        note: options.note,
      },
    });
  } finally {
    await readContext.close();
  }
}

async function attemptSaveMempool(rpc: MiningRpcClient, paths: WalletRuntimePaths, runId: string | null): Promise<void> {
  try {
    await rpc.saveMempool?.();
  } catch {
    // ignore
  } finally {
    await appendEvent(paths, createEvent(
      "savemempool-attempted",
      "Attempted to persist the local mempool before stopping mining.",
      {
        runId,
      },
    ));
  }
}

async function runMiningLoop(options: {
  dataDir: string;
  databasePath: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  runMode: "foreground" | "background";
  backgroundWorkerPid: number | null;
  backgroundWorkerRunId: string | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  openReadContext: typeof openWalletReadContext;
  attachService: typeof attachOrStartManagedBitcoindService;
  rpcFactory: (config: Parameters<typeof createRpcClient>[0]) => MiningRpcClient;
  stdout?: { write(chunk: string): void };
  visualizer?: MiningFollowVisualizer;
}): Promise<void> {
  const suspendDetector = createMiningSuspendDetector();

  await appendEvent(options.paths, createEvent(
    "runtime-start",
    `Started ${options.runMode} mining runtime.`,
    {
      runId: options.backgroundWorkerRunId,
    },
  ));

  while (!options.signal?.aborted) {
    try {
      checkpointMiningSuspendDetector(suspendDetector);
    } catch (error) {
      if (!(error instanceof MiningSuspendDetectedError)) {
        throw error;
      }

      await handleDetectedMiningRuntimeResume({
        dataDir: options.dataDir,
        databasePath: options.databasePath,
        provider: options.provider,
        paths: options.paths,
        runMode: options.runMode,
        backgroundWorkerPid: options.backgroundWorkerPid,
        backgroundWorkerRunId: options.backgroundWorkerRunId,
        detectedAtUnixMs: error.detectedAtUnixMs,
        openReadContext: options.openReadContext,
        visualizer: options.visualizer,
      });
      continue;
    }

    await performMiningCycle({
      ...options,
      suspendDetector,
    });
    await sleep(Math.min(MINING_LOOP_INTERVAL_MS, MINING_STATUS_HEARTBEAT_INTERVAL_MS), options.signal);
  }

  const service = await options.attachService({
    dataDir: options.dataDir,
    chain: "main",
    startHeight: 0,
    walletRootId: undefined,
  }).catch(() => null);
  if (service !== null) {
    await attemptSaveMempool(options.rpcFactory(service.rpc), options.paths, options.backgroundWorkerRunId);
  }
  await appendEvent(options.paths, createEvent(
    "runtime-stop",
    `Stopped ${options.runMode} mining runtime.`,
    {
      runId: options.backgroundWorkerRunId,
    },
  ));
}

async function waitForBackgroundHealthy(paths: WalletRuntimePaths): Promise<MiningRuntimeStatusV1 | null> {
  const deadline = Date.now() + BACKGROUND_START_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath).catch(() => null);
    if (
      snapshot !== null
      && snapshot.runMode === "background"
      && snapshot.backgroundWorkerHealth === "healthy"
    ) {
      return snapshot;
    }
    await sleep(250);
  }

  return loadMiningRuntimeStatus(paths.miningStatusPath).catch(() => null);
}

export async function runForegroundMining(options: RunForegroundMiningOptions): Promise<void> {
  if (!options.prompter.isInteractive) {
    throw new Error("mine_requires_tty");
  }

  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const openReadContext = options.openReadContext ?? openWalletReadContext;
  const attachService = options.attachService ?? attachOrStartManagedBitcoindService;
  const rpcFactory = options.rpcFactory ?? createRpcClient as (config: Parameters<typeof createRpcClient>[0]) => MiningRpcClient;
  const controlLock = await acquireFileLock(paths.miningControlLockPath, {
    purpose: "mine-foreground",
  });
  let visualizer: MiningFollowVisualizer | null = null;

  try {
    const existing = await loadMiningRuntimeStatus(paths.miningStatusPath).catch(() => null);
    if (existing?.runMode === "background") {
      throw new Error("Background mining is already active. Run `cogcoin mine stop` first.");
    }

    const setupReady = await ensureBuiltInSetupIfNeeded({
      provider,
      prompter: options.prompter,
      paths,
    });
    if (!setupReady) {
      throw new Error("Built-in mining provider is not configured. Run `cogcoin mine setup`.");
    }

    visualizer = new MiningFollowVisualizer({
      progressOutput: options.progressOutput ?? "auto",
      stream: options.stderr,
    });

    const abortController = new AbortController();
    options.signal?.addEventListener("abort", () => {
      abortController.abort();
    }, { once: true });
    process.on("SIGINT", () => abortController.abort());
    process.on("SIGTERM", () => abortController.abort());

    await runMiningLoop({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      provider,
      paths,
      runMode: "foreground",
      backgroundWorkerPid: null,
      backgroundWorkerRunId: null,
      signal: abortController.signal,
      fetchImpl: options.fetchImpl,
      openReadContext,
      attachService,
      rpcFactory,
      stdout: options.stdout,
      visualizer,
    });
    await saveStopSnapshot({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      provider,
      paths,
      runMode: "foreground",
      backgroundWorkerPid: null,
      backgroundWorkerRunId: null,
      note: "Foreground mining stopped cleanly.",
    });
  } finally {
    visualizer?.close();
    await controlLock.release();
  }
}

export async function startBackgroundMining(options: StartBackgroundMiningOptions): Promise<MiningStartResult> {
  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const controlLock = await acquireFileLock(paths.miningControlLockPath, {
    purpose: "mine-start",
  });

  try {
    const existing = await loadMiningRuntimeStatus(paths.miningStatusPath).catch(() => null);
    if (
      existing?.runMode === "background"
      && existing.backgroundWorkerPid !== null
      && await isProcessAlive(existing.backgroundWorkerPid)
    ) {
      return {
        started: false,
        snapshot: existing,
      };
    }

    if (existing?.runMode === "foreground") {
      throw new Error("Foreground mining is already active. Interrupt that process directly.");
    }

    const setupReady = await ensureBuiltInSetupIfNeeded({
      provider,
      prompter: options.prompter,
      paths,
    });
    if (!setupReady) {
      throw new Error("Built-in mining provider is not configured. Run `cogcoin mine setup`.");
    }

    const runId = randomBytes(16).toString("hex");
    const workerMainPath = fileURLToPath(new URL("./worker-main.js", import.meta.url));
    const child = spawn(process.execPath, [
      workerMainPath,
      `--data-dir=${options.dataDir}`,
      `--database-path=${options.databasePath}`,
      `--run-id=${runId}`,
    ], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    const snapshot = await waitForBackgroundHealthy(paths);

    return {
      started: true,
      snapshot,
    };
  } finally {
    await controlLock.release();
  }
}

export async function stopBackgroundMining(options: StopBackgroundMiningOptions): Promise<MiningRuntimeStatusV1 | null> {
  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const controlLock = await acquireFileLock(paths.miningControlLockPath, {
    purpose: "mine-stop",
  });

  try {
    const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath).catch(() => null);
    if (snapshot === null || snapshot.runMode !== "background" || snapshot.backgroundWorkerPid === null) {
      return snapshot;
    }

    const preemption = await requestMiningGenerationPreemption({
      paths,
      reason: "mine-stop",
      timeoutMs: Math.min(MINING_SHUTDOWN_GRACE_MS, 15_000),
    }).catch(() => null);

    process.kill(snapshot.backgroundWorkerPid, "SIGTERM");
    const deadline = Date.now() + MINING_SHUTDOWN_GRACE_MS;

    while (Date.now() < deadline) {
      try {
        process.kill(snapshot.backgroundWorkerPid, 0);
        await sleep(250);
      } catch (error) {
        if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") {
          break;
        }
      }
    }

    try {
      process.kill(snapshot.backgroundWorkerPid, "SIGKILL");
    } catch {
      // ignore
    }

    await saveStopSnapshot({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      provider,
      paths,
      runMode: "background",
      backgroundWorkerPid: snapshot.backgroundWorkerPid,
      backgroundWorkerRunId: snapshot.backgroundWorkerRunId,
      note: snapshot.liveMiningFamilyInMempool
        ? "Background mining stopped. The last mining transaction may still confirm from mempool."
        : "Background mining stopped.",
    });
    await preemption?.release().catch(() => undefined);
    return loadMiningRuntimeStatus(paths.miningStatusPath);
  } finally {
    await controlLock.release();
  }
}

export async function runBackgroundMiningWorker(options: RunnerDependencies & {
  dataDir: string;
  databasePath: string;
  runId: string;
  provider?: WalletSecretProvider;
  paths?: WalletRuntimePaths;
}): Promise<void> {
  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const openReadContext = options.openReadContext ?? openWalletReadContext;
  const attachService = options.attachService ?? attachOrStartManagedBitcoindService;
  const rpcFactory = options.rpcFactory ?? createRpcClient as (config: Parameters<typeof createRpcClient>[0]) => MiningRpcClient;
  const abortController = new AbortController();

  process.on("SIGINT", () => abortController.abort());
  process.on("SIGTERM", () => abortController.abort());

  const initialContext = await openReadContext({
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    secretProvider: provider,
    paths,
  });

  try {
    const initialView = await inspectMiningControlPlane({
      provider,
      localState: initialContext.localState,
      bitcoind: initialContext.bitcoind,
      nodeStatus: initialContext.nodeStatus,
      nodeHealth: initialContext.nodeHealth,
      indexer: initialContext.indexer,
      paths,
    });
    await saveMiningRuntimeStatus(paths.miningStatusPath, {
      ...initialView.runtime,
      walletRootId: initialContext.localState.walletRootId,
      workerApiVersion: MINING_WORKER_API_VERSION,
      workerBinaryVersion: process.version,
      workerBuildId: options.runId,
      runMode: "background",
      backgroundWorkerPid: process.pid,
      backgroundWorkerRunId: options.runId,
      backgroundWorkerHeartbeatAtUnixMs: Date.now(),
      currentPhase: "idle",
      updatedAtUnixMs: Date.now(),
    });
  } finally {
    await initialContext.close();
  }

  await runMiningLoop({
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    provider,
    paths,
    runMode: "background",
    backgroundWorkerPid: process.pid,
    backgroundWorkerRunId: options.runId,
    signal: abortController.signal,
    fetchImpl: options.fetchImpl,
    openReadContext,
    attachService,
    rpcFactory,
  });
  await saveStopSnapshot({
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    provider,
    paths,
    runMode: "background",
    backgroundWorkerPid: process.pid,
    backgroundWorkerRunId: options.runId,
    note: "Background mining worker stopped cleanly.",
  });
}

export async function handleDetectedMiningRuntimeResumeForTesting(options: {
  dataDir: string;
  databasePath: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  runMode: "foreground" | "background";
  backgroundWorkerPid: number | null;
  backgroundWorkerRunId: string | null;
  detectedAtUnixMs: number;
  openReadContext: typeof openWalletReadContext;
}): Promise<void> {
  await handleDetectedMiningRuntimeResume(options);
}

export async function performMiningCycleForTesting(options: {
  dataDir: string;
  databasePath: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  runMode: "foreground" | "background";
  backgroundWorkerPid: number | null;
  backgroundWorkerRunId: string | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  openReadContext: typeof openWalletReadContext;
  attachService: typeof attachOrStartManagedBitcoindService;
  rpcFactory: (config: Parameters<typeof createRpcClient>[0]) => MiningRpcClient;
  stdout?: { write(chunk: string): void };
}): Promise<void> {
  await performMiningCycle(options);
}

export function shouldTreatCandidateAsFeeBumpForTesting(options: {
  liveState: MiningStateRecord;
  candidate: {
    domainId: number;
    sender: MutationSender;
    encodedSentenceBytes: Uint8Array;
    referencedBlockHashDisplay: string;
    targetBlockHeight: number;
  };
}): boolean {
  return candidateNeedsFeeMaintenance(options as {
    liveState: MiningStateRecord;
    candidate: MiningCandidate;
  });
}
