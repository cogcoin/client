import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { COG_PREFIX } from "../cogop/constants.js";
import { writeFileAtomic } from "../fs/atomic.js";
import { extractOpReturnPayloadFromScriptHex } from "../tx/register.js";
import type { WalletRuntimePaths } from "../runtime.js";
import type { MiningCooperativeYield, MiningRpcClient } from "./engine-types.js";

const MINING_MEMPOOL_INDEX_SCHEMA_VERSION = 1;
const MINING_MEMPOOL_INDEX_RAW_TX_FETCH_CONCURRENCY = 8;
const MINING_MEMPOOL_INDEX_PROGRESS_REPORT_EVERY = 25;

export interface MiningMempoolTxContext {
  txid: string;
  senderScriptHex: string | null;
  inputTxids: string[];
  payload: Uint8Array | null;
}

export interface MiningMempoolIndexHydrationResult {
  contexts: Map<string, MiningMempoolTxContext>;
  cacheStatus: "indexed" | "index-warming";
  indexedContextCount: number;
  negativeTxidCount: number;
  unknownTxidCount: number;
  hydratedCount: number;
}

export type MiningMempoolIndexHydrationDiagnostics = Omit<MiningMempoolIndexHydrationResult, "contexts">;

export class MiningMempoolIndexHydrationIncompleteError extends Error {
  readonly diagnostics: MiningMempoolIndexHydrationDiagnostics;
  readonly failedTxids: readonly string[];

  constructor(diagnostics: MiningMempoolIndexHydrationDiagnostics, failedTxids: readonly string[]) {
    super("mining_mempool_index_hydration_incomplete");
    this.name = "MiningMempoolIndexHydrationIncompleteError";
    this.diagnostics = diagnostics;
    this.failedTxids = failedTxids;
  }
}

export interface MiningMempoolIndexGateOptions {
  rawTxSupported: boolean;
  cachePath: string;
  serviceIdentity: string;
}

interface PersistedMiningMempoolTxContext {
  txid: string;
  senderScriptHex: string | null;
  inputTxids: string[];
  payloadHex: string | null;
}

interface PersistedMiningMempoolIndexCache {
  schemaVersion: typeof MINING_MEMPOOL_INDEX_SCHEMA_VERSION;
  walletRootId: string;
  serviceIdentity: string;
  contexts: PersistedMiningMempoolTxContext[];
  negativeTxids: string[];
}

interface MiningMempoolIndexState {
  walletRootId: string;
  serviceIdentity: string;
  cachePath: string;
  contexts: Map<string, MiningMempoolTxContext>;
  negativeTxids: Set<string>;
  activeVisibleTxids: Set<string> | null;
  compactionCount: number;
  loaded: boolean;
  savePromise: Promise<void>;
  saveScheduled: ReturnType<typeof setTimeout> | null;
  saveDirty: boolean;
}

interface RawTxSubscriberLike extends AsyncIterable<unknown> {
  close(): void;
  connect(endpoint: string): void;
  subscribe(topic: string): void;
}

interface ZeroMqModuleLike {
  Subscriber: new () => RawTxSubscriberLike;
}

interface RawTxSubscriberState {
  key: string;
  walletRootId: string;
  serviceIdentity: string;
  cachePath: string;
  subscriber: RawTxSubscriberLike;
  loop: Promise<void>;
}

interface ParsedRawTransactionIndexContext {
  txid: string;
  inputTxids: string[];
  payload: Uint8Array | null;
}

const indexStates = new Map<string, MiningMempoolIndexState>();
const rawTxSubscribers = new Map<string, RawTxSubscriberState>();
const RAW_TX_SUBSCRIBER_SAVE_DEBOUNCE_MS = 1_000;

export function resolveMiningMempoolIndexCachePath(paths: Pick<WalletRuntimePaths, "miningRoot">): string {
  return join(paths.miningRoot, "mempool-index.json");
}

export function resolveMiningMempoolServiceIdentity(options: {
  dataDir: string;
  pid: number | null;
  zmqEndpoint: string;
  rawTxTopic?: "rawtx";
}): string {
  return [
    options.dataDir,
    options.pid ?? "unknown-pid",
    options.zmqEndpoint,
    options.rawTxTopic ?? "no-rawtx",
  ].join("|");
}

function cacheKey(walletRootId: string, serviceIdentity: string, cachePath: string): string {
  return `${walletRootId}\n${serviceIdentity}\n${cachePath}`;
}

function isCogPayload(payload: Uint8Array | null): boolean {
  return payload !== null
    && payload.length >= 3
    && payload[0] === COG_PREFIX[0]
    && payload[1] === COG_PREFIX[1]
    && payload[2] === COG_PREFIX[2];
}

function serializeContext(context: MiningMempoolTxContext): PersistedMiningMempoolTxContext {
  return {
    txid: context.txid,
    senderScriptHex: context.senderScriptHex,
    inputTxids: [...context.inputTxids],
    payloadHex: context.payload === null ? null : Buffer.from(context.payload).toString("hex"),
  };
}

function deserializeContext(context: PersistedMiningMempoolTxContext): MiningMempoolTxContext | null {
  if (
    typeof context.txid !== "string"
    || (context.senderScriptHex !== null && typeof context.senderScriptHex !== "string")
    || !Array.isArray(context.inputTxids)
    || (context.payloadHex !== null && typeof context.payloadHex !== "string")
  ) {
    return null;
  }

  return {
    txid: context.txid,
    senderScriptHex: context.senderScriptHex,
    inputTxids: context.inputTxids.filter((txid): txid is string => typeof txid === "string"),
    payload: context.payloadHex === null ? null : Buffer.from(context.payloadHex, "hex"),
  };
}

async function loadStateFromDisk(state: MiningMempoolIndexState): Promise<void> {
  if (state.loaded) {
    return;
  }

  state.loaded = true;
  const raw = await readFile(state.cachePath, "utf8").catch(() => null);
  if (raw === null) {
    return;
  }

  let parsed: PersistedMiningMempoolIndexCache;
  try {
    parsed = JSON.parse(raw) as PersistedMiningMempoolIndexCache;
  } catch {
    return;
  }

  if (
    parsed.schemaVersion !== MINING_MEMPOOL_INDEX_SCHEMA_VERSION
    || parsed.walletRootId !== state.walletRootId
    || parsed.serviceIdentity !== state.serviceIdentity
    || !Array.isArray(parsed.contexts)
    || !Array.isArray(parsed.negativeTxids)
  ) {
    return;
  }

  for (const persistedContext of parsed.contexts) {
    const context = deserializeContext(persistedContext);
    if (context !== null && isCogPayload(context.payload)) {
      state.contexts.set(context.txid, context);
    }
  }

  for (const txid of parsed.negativeTxids) {
    if (typeof txid === "string") {
      state.negativeTxids.add(txid);
    }
  }
}

function getOrCreateState(options: {
  walletRootId: string;
  serviceIdentity: string;
  cachePath: string;
}): MiningMempoolIndexState {
  const key = cacheKey(options.walletRootId, options.serviceIdentity, options.cachePath);
  const existing = indexStates.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const created: MiningMempoolIndexState = {
    walletRootId: options.walletRootId,
    serviceIdentity: options.serviceIdentity,
    cachePath: options.cachePath,
    contexts: new Map(),
    negativeTxids: new Set(),
    activeVisibleTxids: null,
    compactionCount: 0,
    loaded: false,
    savePromise: Promise.resolve(),
    saveScheduled: null,
    saveDirty: false,
  };
  indexStates.set(key, created);
  return created;
}

async function saveState(state: MiningMempoolIndexState): Promise<void> {
  state.savePromise = state.savePromise.catch(() => undefined).then(async () => {
    pruneStateToActiveVisibleTxids(state);
    const payload: PersistedMiningMempoolIndexCache = {
      schemaVersion: MINING_MEMPOOL_INDEX_SCHEMA_VERSION,
      walletRootId: state.walletRootId,
      serviceIdentity: state.serviceIdentity,
      contexts: [...state.contexts.values()]
        .sort((left, right) => left.txid.localeCompare(right.txid))
        .map(serializeContext),
      negativeTxids: [...state.negativeTxids].sort(),
    };

    await mkdir(dirname(state.cachePath), { recursive: true });
    await writeFileAtomic(state.cachePath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  });
  await state.savePromise;
}

function scheduleStateSave(state: MiningMempoolIndexState): void {
  state.saveDirty = true;
  if (state.saveScheduled !== null) {
    return;
  }

  state.saveScheduled = setTimeout(() => {
    state.saveScheduled = null;
    if (!state.saveDirty) {
      return;
    }

    state.saveDirty = false;
    void saveState(state)
      .catch(() => undefined)
      .finally(() => {
        if (state.saveDirty) {
          scheduleStateSave(state);
        }
      });
  }, RAW_TX_SUBSCRIBER_SAVE_DEBOUNCE_MS);
}

function cancelScheduledStateSave(state: MiningMempoolIndexState): void {
  if (state.saveScheduled !== null) {
    clearTimeout(state.saveScheduled);
    state.saveScheduled = null;
  }
  state.saveDirty = false;
}

export async function pruneMiningMempoolIndexServicesForWallet(options: {
  walletRootId: string;
  cachePath: string;
  serviceIdentity: string;
}): Promise<void> {
  const subscriberLoops: Array<Promise<void>> = [];
  for (const [key, subscriberState] of rawTxSubscribers) {
    if (
      subscriberState.walletRootId === options.walletRootId
      && subscriberState.cachePath === options.cachePath
      && subscriberState.serviceIdentity !== options.serviceIdentity
    ) {
      rawTxSubscribers.delete(key);
      subscriberState.subscriber.close();
      subscriberLoops.push(subscriberState.loop.catch(() => undefined));
    }
  }

  for (const [key, state] of indexStates) {
    if (
      state.walletRootId === options.walletRootId
      && state.cachePath === options.cachePath
      && state.serviceIdentity !== options.serviceIdentity
    ) {
      cancelScheduledStateSave(state);
      indexStates.delete(key);
    }
  }

  await Promise.all(subscriberLoops);
}

function pruneStateToVisibleTxids(state: MiningMempoolIndexState, visibleTxids: readonly string[]): boolean {
  const visibleSet = new Set(visibleTxids);
  return pruneStateToVisibleTxidSet(state, visibleSet);
}

function pruneStateToActiveVisibleTxids(state: MiningMempoolIndexState): boolean {
  if (state.activeVisibleTxids === null) {
    return false;
  }

  return pruneStateToVisibleTxidSet(state, state.activeVisibleTxids);
}

function pruneStateToVisibleTxidSet(state: MiningMempoolIndexState, visibleSet: ReadonlySet<string>): boolean {
  let contextChanged = false;
  const retainedContexts = new Map<string, MiningMempoolTxContext>();
  for (const [txid, context] of state.contexts) {
    if (visibleSet.has(txid)) {
      retainedContexts.set(txid, context);
    } else {
      contextChanged = true;
    }
  }

  let negativeChanged = false;
  const retainedNegativeTxids = new Set<string>();
  for (const txid of state.negativeTxids) {
    if (visibleSet.has(txid)) {
      retainedNegativeTxids.add(txid);
    } else {
      negativeChanged = true;
    }
  }

  if (!contextChanged && !negativeChanged) {
    return false;
  }

  if (contextChanged) {
    state.contexts = retainedContexts;
  }
  if (negativeChanged) {
    state.negativeTxids = retainedNegativeTxids;
  }
  state.compactionCount += 1;

  return true;
}

function createContextFromRpcTransaction(
  txid: string,
  tx: Awaited<ReturnType<MiningRpcClient["getRawTransaction"]>>,
): MiningMempoolTxContext | null {
  const payloadHex = tx.vout.find((entry) => entry.scriptPubKey?.hex?.startsWith("6a") === true)?.scriptPubKey?.hex;
  const payload = payloadHex === undefined ? null : extractOpReturnPayloadFromScriptHex(payloadHex);

  if (!isCogPayload(payload)) {
    return null;
  }

  return {
    txid,
    senderScriptHex: tx.vin[0]?.prevout?.scriptPubKey?.hex ?? null,
    inputTxids: tx.vin.map((input) => input.txid).filter((inputTxid): inputTxid is string => inputTxid !== undefined),
    payload,
  };
}

async function maybeYieldDuringIndexHydration(options: {
  iteration: number;
  cooperativeYield?: MiningCooperativeYield;
  cooperativeYieldEvery?: number;
}): Promise<void> {
  const yieldEvery = options.cooperativeYieldEvery ?? MINING_MEMPOOL_INDEX_PROGRESS_REPORT_EVERY;
  if (yieldEvery <= 0 || options.iteration === 0 || (options.iteration % yieldEvery) !== 0) {
    return;
  }

  await (options.cooperativeYield ?? (() => new Promise<void>((resolve) => {
    setImmediate(resolve);
  })))();
}

async function hydrateUnknownTxids(options: {
  state: MiningMempoolIndexState;
  rpc: Pick<MiningRpcClient, "getRawTransaction">;
  unknownTxids: readonly string[];
  cooperativeYield?: MiningCooperativeYield;
  cooperativeYieldEvery?: number;
  throwIfStopping?: () => void;
  onWarmupProgress?: (progress: { processed: number; total: number }) => Promise<void> | void;
}): Promise<string[]> {
  if (options.unknownTxids.length === 0) {
    return [];
  }

  let completed = 0;
  let nextIndex = 0;
  let lastReportedProcessed = -1;
  const failedTxids: string[] = [];
  let reportPromise = Promise.resolve();
  const reportProgress = async (processed: number, force = false): Promise<void> => {
    if (options.onWarmupProgress === undefined) {
      return;
    }

    if (!force && processed !== options.unknownTxids.length && (processed % MINING_MEMPOOL_INDEX_PROGRESS_REPORT_EVERY) !== 0) {
      return;
    }

    if (processed === lastReportedProcessed) {
      return;
    }

    lastReportedProcessed = processed;
    reportPromise = reportPromise.then(async () => {
      await options.onWarmupProgress?.({
        processed,
        total: options.unknownTxids.length,
      });
    });
    await reportPromise;
  };

  await reportProgress(0, true);
  const workerCount = Math.min(MINING_MEMPOOL_INDEX_RAW_TX_FETCH_CONCURRENCY, options.unknownTxids.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const iteration = nextIndex;
      if (iteration >= options.unknownTxids.length) {
        return;
      }
      nextIndex += 1;

      await maybeYieldDuringIndexHydration({
        iteration,
        cooperativeYield: options.cooperativeYield,
        cooperativeYieldEvery: options.cooperativeYieldEvery,
      });
      options.throwIfStopping?.();

      const txid = options.unknownTxids[iteration]!;
      const tx = await options.rpc.getRawTransaction(txid, true).catch(() => null);
      options.throwIfStopping?.();

      if (tx === null) {
        failedTxids.push(txid);
      } else {
        const context = createContextFromRpcTransaction(txid, tx);
        if (context === null) {
          options.state.negativeTxids.add(txid);
        } else {
          options.state.contexts.set(txid, context);
          options.state.negativeTxids.delete(txid);
        }
      }

      completed += 1;
      await reportProgress(completed, completed === options.unknownTxids.length);
    }
  });

  await Promise.all(workers);
  return failedTxids;
}

function createHydrationDiagnostics(options: {
  state: MiningMempoolIndexState;
  unknownTxids: readonly string[];
  cacheStatus: MiningMempoolIndexHydrationResult["cacheStatus"];
}): MiningMempoolIndexHydrationDiagnostics {
  const hydratedCount = options.unknownTxids.filter((txid) =>
    options.state.contexts.has(txid) || options.state.negativeTxids.has(txid)
  ).length;

  return {
    cacheStatus: options.cacheStatus,
    indexedContextCount: options.state.contexts.size,
    negativeTxidCount: options.state.negativeTxids.size,
    unknownTxidCount: options.unknownTxids.length,
    hydratedCount,
  };
}

export async function hydrateMiningMempoolIndex(options: {
  walletRootId: string;
  serviceIdentity: string;
  cachePath: string;
  rpc: Pick<MiningRpcClient, "getRawTransaction">;
  visibleTxids: readonly string[];
  cooperativeYield?: MiningCooperativeYield;
  cooperativeYieldEvery?: number;
  throwIfStopping?: () => void;
  onWarmupProgress?: (progress: { processed: number; total: number }) => Promise<void> | void;
}): Promise<MiningMempoolIndexHydrationResult> {
  const state = getOrCreateState({
    walletRootId: options.walletRootId,
    serviceIdentity: options.serviceIdentity,
    cachePath: options.cachePath,
  });
  await loadStateFromDisk(state);
  state.activeVisibleTxids = new Set(options.visibleTxids);
  let changed = pruneStateToVisibleTxids(state, options.visibleTxids);
  const unknownTxids = options.visibleTxids.filter((txid) =>
    !state.contexts.has(txid) && !state.negativeTxids.has(txid)
  );

  const cacheStatus = unknownTxids.length === 0 ? "indexed" : "index-warming";

  if (unknownTxids.length > 0) {
    let failedTxids: readonly string[];
    try {
      failedTxids = await hydrateUnknownTxids({
        state,
        rpc: options.rpc,
        unknownTxids,
        cooperativeYield: options.cooperativeYield,
        cooperativeYieldEvery: options.cooperativeYieldEvery,
        throwIfStopping: options.throwIfStopping,
        onWarmupProgress: options.onWarmupProgress,
      });
      changed = true;
    } catch {
      pruneStateToVisibleTxids(state, options.visibleTxids);
      changed = true;
      const diagnostics = createHydrationDiagnostics({
        state,
        unknownTxids,
        cacheStatus,
      });
      if (changed) {
        await saveState(state).catch(() => undefined);
      }
      throw new MiningMempoolIndexHydrationIncompleteError(diagnostics, []);
    }

    if (failedTxids.length > 0) {
      changed = pruneStateToVisibleTxids(state, options.visibleTxids) || changed;
      const diagnostics = createHydrationDiagnostics({
        state,
        unknownTxids,
        cacheStatus,
      });
      if (changed) {
        await saveState(state).catch(() => undefined);
      }
      throw new MiningMempoolIndexHydrationIncompleteError(diagnostics, failedTxids);
    }
  }

  changed = pruneStateToVisibleTxids(state, options.visibleTxids) || changed;
  if (changed) {
    await saveState(state);
  }

  return {
    contexts: new Map(state.contexts),
    ...createHydrationDiagnostics({
      state,
      unknownTxids,
      cacheStatus,
    }),
  };
}

function readVarInt(bytes: Buffer, offset: number): { value: number; nextOffset: number; raw: Buffer } | null {
  const first = bytes[offset];
  if (first === undefined) {
    return null;
  }

  if (first < 0xfd) {
    return { value: first, nextOffset: offset + 1, raw: bytes.subarray(offset, offset + 1) };
  }

  if (first === 0xfd && (offset + 3) <= bytes.length) {
    return {
      value: bytes.readUInt16LE(offset + 1),
      nextOffset: offset + 3,
      raw: bytes.subarray(offset, offset + 3),
    };
  }

  if (first === 0xfe && (offset + 5) <= bytes.length) {
    return {
      value: bytes.readUInt32LE(offset + 1),
      nextOffset: offset + 5,
      raw: bytes.subarray(offset, offset + 5),
    };
  }

  if (first === 0xff && (offset + 9) <= bytes.length) {
    const value = bytes.readBigUInt64LE(offset + 1);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }

    return {
      value: Number(value),
      nextOffset: offset + 9,
      raw: bytes.subarray(offset, offset + 9),
    };
  }

  return null;
}

function doubleSha256(bytes: Buffer): Buffer {
  return createHash("sha256").update(createHash("sha256").update(bytes).digest()).digest();
}

function parseRawTransactionForIndex(rawHex: string): ParsedRawTransactionIndexContext | null {
  const bytes = Buffer.from(rawHex, "hex");
  if (bytes.length < 10) {
    return null;
  }

  let offset = 4;
  const txidParts: Buffer[] = [bytes.subarray(0, 4)];
  const segwit = bytes[offset] === 0x00 && bytes[offset + 1] !== undefined && bytes[offset + 1] !== 0x00;
  if (segwit) {
    offset += 2;
  }

  const inputCount = readVarInt(bytes, offset);
  if (inputCount === null) {
    return null;
  }
  txidParts.push(inputCount.raw);
  offset = inputCount.nextOffset;

  const inputTxids: string[] = [];
  for (let index = 0; index < inputCount.value; index += 1) {
    if ((offset + 36) > bytes.length) {
      return null;
    }

    const prevoutHash = bytes.subarray(offset, offset + 32);
    inputTxids.push(Buffer.from(prevoutHash).reverse().toString("hex"));
    const inputFixed = bytes.subarray(offset, offset + 36);
    txidParts.push(inputFixed);
    offset += 36;

    const scriptLength = readVarInt(bytes, offset);
    if (scriptLength === null || (scriptLength.nextOffset + scriptLength.value + 4) > bytes.length) {
      return null;
    }
    txidParts.push(scriptLength.raw);
    offset = scriptLength.nextOffset;
    txidParts.push(bytes.subarray(offset, offset + scriptLength.value + 4));
    offset += scriptLength.value + 4;
  }

  const outputCount = readVarInt(bytes, offset);
  if (outputCount === null) {
    return null;
  }
  txidParts.push(outputCount.raw);
  offset = outputCount.nextOffset;

  let payload: Uint8Array | null = null;
  for (let index = 0; index < outputCount.value; index += 1) {
    if ((offset + 8) > bytes.length) {
      return null;
    }

    txidParts.push(bytes.subarray(offset, offset + 8));
    offset += 8;
    const scriptLength = readVarInt(bytes, offset);
    if (scriptLength === null || (scriptLength.nextOffset + scriptLength.value) > bytes.length) {
      return null;
    }
    txidParts.push(scriptLength.raw);
    offset = scriptLength.nextOffset;
    const script = bytes.subarray(offset, offset + scriptLength.value);
    txidParts.push(script);
    payload ??= extractOpReturnPayloadFromScriptHex(script.toString("hex"));
    offset += scriptLength.value;
  }

  if (segwit) {
    for (let index = 0; index < inputCount.value; index += 1) {
      const witnessCount = readVarInt(bytes, offset);
      if (witnessCount === null) {
        return null;
      }
      offset = witnessCount.nextOffset;
      for (let witnessIndex = 0; witnessIndex < witnessCount.value; witnessIndex += 1) {
        const witnessLength = readVarInt(bytes, offset);
        if (witnessLength === null || (witnessLength.nextOffset + witnessLength.value) > bytes.length) {
          return null;
        }
        offset = witnessLength.nextOffset + witnessLength.value;
      }
    }
  }

  if ((offset + 4) !== bytes.length) {
    return null;
  }

  txidParts.push(bytes.subarray(offset, offset + 4));
  return {
    txid: Buffer.from(doubleSha256(Buffer.concat(txidParts))).reverse().toString("hex"),
    inputTxids,
    payload,
  };
}

function normalizeZmqFrames(frames: unknown): Buffer[] {
  if (Array.isArray(frames)) {
    return frames.filter(Buffer.isBuffer);
  }

  return Buffer.isBuffer(frames) ? [frames] : [];
}

async function loadZeroMqModule(): Promise<ZeroMqModuleLike> {
  return await import("zeromq") as unknown as ZeroMqModuleLike;
}

export async function ensureMiningMempoolRawTxSubscriber(options: {
  walletRootId: string;
  serviceIdentity: string;
  cachePath: string;
  zmqEndpoint: string;
  rawTxTopic?: "rawtx";
  loadZeroMq?: () => Promise<ZeroMqModuleLike>;
}): Promise<boolean> {
  if (options.rawTxTopic !== "rawtx") {
    return false;
  }

  const key = cacheKey(options.walletRootId, options.serviceIdentity, options.cachePath);
  if (rawTxSubscribers.has(key)) {
    return true;
  }

  const state = getOrCreateState({
    walletRootId: options.walletRootId,
    serviceIdentity: options.serviceIdentity,
    cachePath: options.cachePath,
  });
  await loadStateFromDisk(state);

  let subscriber: RawTxSubscriberLike;
  try {
    const zeroMq = options.loadZeroMq === undefined ? await loadZeroMqModule() : await options.loadZeroMq();
    subscriber = new zeroMq.Subscriber();
    subscriber.connect(options.zmqEndpoint);
    subscriber.subscribe(options.rawTxTopic);
  } catch {
    return false;
  }

  const loop = (async () => {
    try {
      for await (const frames of subscriber) {
        const normalized = normalizeZmqFrames(frames);
        if (normalized.length < 2 || normalized[0]?.toString() !== options.rawTxTopic) {
          continue;
        }

        const parsed = parseRawTransactionForIndex(normalized[1]!.toString("hex"));
        if (parsed === null || isCogPayload(parsed.payload)) {
          continue;
        }

        const previousSize = state.negativeTxids.size;
        state.negativeTxids.add(parsed.txid);
        if (
          state.negativeTxids.size !== previousSize
          && state.activeVisibleTxids?.has(parsed.txid) === true
        ) {
          scheduleStateSave(state);
        }
      }
    } catch {
      // The index remains conservative; the gate hydrates unknown txids by RPC.
    }
  })();

  rawTxSubscribers.set(key, {
    key,
    walletRootId: options.walletRootId,
    serviceIdentity: options.serviceIdentity,
    cachePath: options.cachePath,
    subscriber,
    loop,
  });
  return true;
}

export async function closeMiningMempoolIndexSubscribersForTesting(): Promise<void> {
  const subscribers = [...rawTxSubscribers.values()];
  rawTxSubscribers.clear();
  for (const state of subscribers) {
    state.subscriber.close();
    await state.loop.catch(() => undefined);
  }
}

export function clearMiningMempoolIndexCacheForTesting(): void {
  for (const state of indexStates.values()) {
    cancelScheduledStateSave(state);
  }
  indexStates.clear();
}

export function readMiningMempoolIndexStateDiagnosticsForTesting(): Array<{
  walletRootId: string;
  serviceIdentity: string;
  cachePath: string;
  contextCount: number;
  negativeTxidCount: number;
  activeVisibleTxidCount: number | null;
  compactionCount: number;
}> {
  return [...indexStates.values()]
    .sort((left, right) =>
      left.walletRootId.localeCompare(right.walletRootId)
      || left.cachePath.localeCompare(right.cachePath)
      || left.serviceIdentity.localeCompare(right.serviceIdentity)
    )
    .map((state) => ({
      walletRootId: state.walletRootId,
      serviceIdentity: state.serviceIdentity,
      cachePath: state.cachePath,
      contextCount: state.contexts.size,
      negativeTxidCount: state.negativeTxids.size,
      activeVisibleTxidCount: state.activeVisibleTxids?.size ?? null,
      compactionCount: state.compactionCount,
    }));
}

export const parseRawTransactionForMiningMempoolIndexTesting = parseRawTransactionForIndex;
