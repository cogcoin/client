import type {
  RpcListUnspentEntry,
  RpcLockedUnspent,
  RpcWalletTransaction,
} from "../bitcoind/types.js";
import { saveUnlockSession } from "./state/session.js";
import { persistWalletStateUpdate } from "./descriptor-normalization.js";
import type { WalletRuntimePaths } from "./runtime.js";
import { miningFamilyMayStillExist } from "./mining/state.js";
import type {
  OutpointRecord,
  PortableWalletArchivePayloadV1,
  ProactiveFamilyTransactionRecord,
  UnlockSessionStateV1,
  WalletStateV1,
} from "./types.js";

export const DEFAULT_PROACTIVE_RESERVE_SATS = 1_000;

export interface WalletCoinControlRpc {
  listUnspent(walletName: string, minConf?: number): Promise<RpcListUnspentEntry[]>;
  listLockUnspent(walletName: string): Promise<RpcLockedUnspent[]>;
  lockUnspent(walletName: string, unlock: boolean, outputs: RpcLockedUnspent[]): Promise<boolean>;
  getTransaction?(walletName: string, txid: string): Promise<RpcWalletTransaction>;
}

function btcNumberToSats(value: number): bigint {
  return BigInt(Math.round(value * 100_000_000));
}

export function outpointKey(outpoint: OutpointRecord): string {
  return `${outpoint.txid}:${outpoint.vout}`;
}

function normalizeOutpointRecordList(outpoints: readonly OutpointRecord[] | null | undefined): OutpointRecord[] {
  const normalized: OutpointRecord[] = [];
  const seen = new Set<string>();

  for (const outpoint of outpoints ?? []) {
    if (
      outpoint == null
      || typeof outpoint.txid !== "string"
      || outpoint.txid.length === 0
      || typeof outpoint.vout !== "number"
      || !Number.isInteger(outpoint.vout)
      || outpoint.vout < 0
    ) {
      continue;
    }

    const key = outpointKey(outpoint);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({ txid: outpoint.txid, vout: outpoint.vout });
  }

  return normalized;
}

function normalizeReserveSats(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_PROACTIVE_RESERVE_SATS;
  }

  const normalized = Math.max(0, Math.trunc(raw));
  if (normalized === 0) {
    return 0;
  }

  return DEFAULT_PROACTIVE_RESERVE_SATS;
}

function sameOutpointList(left: readonly OutpointRecord[], right: readonly OutpointRecord[] | null | undefined): boolean {
  if (left.length !== (right?.length ?? 0)) {
    return false;
  }

  return left.every((outpoint, index) =>
    outpoint.txid === right?.[index]?.txid && outpoint.vout === right?.[index]?.vout,
  );
}

export function normalizeWalletStateRecord(state: WalletStateV1): WalletStateV1 {
  const rawProactiveReserveSats = (state as WalletStateV1 & { proactiveReserveSats?: number }).proactiveReserveSats;
  const proactiveReserveSats = normalizeReserveSats(
    rawProactiveReserveSats,
  );
  const reserveValueChanged = proactiveReserveSats !== rawProactiveReserveSats;
  const proactiveReserveOutpoints = normalizeOutpointRecordList(
    proactiveReserveSats <= 0 || reserveValueChanged
      ? []
      : (state as WalletStateV1 & { proactiveReserveOutpoints?: OutpointRecord[] }).proactiveReserveOutpoints,
  );
  const pendingMutations = state.pendingMutations ?? [];

  if (
    proactiveReserveSats === (state as WalletStateV1 & { proactiveReserveSats?: number }).proactiveReserveSats
    && sameOutpointList(
      proactiveReserveOutpoints,
      (state as WalletStateV1 & { proactiveReserveOutpoints?: OutpointRecord[] }).proactiveReserveOutpoints,
    )
    && pendingMutations === state.pendingMutations
  ) {
    return state;
  }

  return {
    ...state,
    proactiveReserveSats,
    proactiveReserveOutpoints,
    pendingMutations,
  };
}

export function normalizePortableWalletArchivePayload(
  payload: PortableWalletArchivePayloadV1,
): PortableWalletArchivePayloadV1 {
  const rawProactiveReserveSats = (payload as PortableWalletArchivePayloadV1 & { proactiveReserveSats?: number }).proactiveReserveSats;
  const proactiveReserveSats = normalizeReserveSats(
    rawProactiveReserveSats,
  );
  const reserveValueChanged = proactiveReserveSats !== rawProactiveReserveSats;
  const proactiveReserveOutpoints = normalizeOutpointRecordList(
    proactiveReserveSats <= 0 || reserveValueChanged
      ? []
      : (payload as PortableWalletArchivePayloadV1 & { proactiveReserveOutpoints?: OutpointRecord[] }).proactiveReserveOutpoints,
  );

  if (
    proactiveReserveSats === (payload as PortableWalletArchivePayloadV1 & { proactiveReserveSats?: number }).proactiveReserveSats
    && sameOutpointList(
      proactiveReserveOutpoints,
      (payload as PortableWalletArchivePayloadV1 & { proactiveReserveOutpoints?: OutpointRecord[] }).proactiveReserveOutpoints,
    )
  ) {
    return payload;
  }

  return {
    ...payload,
    proactiveReserveSats,
    proactiveReserveOutpoints,
  };
}

function isSpendableUtxo(entry: RpcListUnspentEntry): boolean {
  return entry.spendable !== false && entry.safe !== false;
}

function isConfirmedFundingUtxo(state: WalletStateV1, entry: RpcListUnspentEntry): boolean {
  return entry.scriptPubKey === state.funding.scriptPubKeyHex
    && entry.confirmations >= 1
    && isSpendableUtxo(entry);
}

function sortFundingEntriesForReserve(entries: readonly RpcListUnspentEntry[]): RpcListUnspentEntry[] {
  return entries.slice().sort((left, right) => {
    const amount = btcNumberToSats(right.amount) - btcNumberToSats(left.amount);
    if (amount !== 0n) {
      return amount > 0n ? 1 : -1;
    }
    const txid = left.txid.localeCompare(right.txid);
    if (txid !== 0) {
      return txid;
    }
    return left.vout - right.vout;
  });
}

function isActiveTrackedTransaction(record: ProactiveFamilyTransactionRecord | null | undefined): boolean {
  if (record == null) {
    return false;
  }

  return record.status === "broadcasting"
    || record.status === "broadcast-unknown"
    || record.status === "live";
}

function isActiveTrackedStatus(status: string): boolean {
  return status === "broadcasting"
    || status === "broadcast-unknown"
    || status === "live";
}

function deriveLiveProvisionalOutpointKeys(state: WalletStateV1): Set<string> {
  const keys = new Set<string>();

  for (const family of state.proactiveFamilies) {
    if ((family.type !== "anchor" && family.type !== "field") || family.tx1?.attemptedTxid == null) {
      continue;
    }

    if (isActiveTrackedStatus(family.status)) {
      keys.add(outpointKey({ txid: family.tx1.attemptedTxid, vout: 1 }));
    }
  }

  return keys;
}

function deriveAuxiliaryDedicatedOutpoints(
  state: WalletStateV1,
  spendableUtxos: readonly RpcListUnspentEntry[],
): OutpointRecord[] {
  const canonicalAnchorKeys = new Set(
    state.domains
      .map((domain) => domain.currentCanonicalAnchorOutpoint)
      .filter((outpoint): outpoint is NonNullable<WalletStateV1["domains"][number]["currentCanonicalAnchorOutpoint"]> => outpoint !== null)
      .map((outpoint) => outpointKey(outpoint)),
  );
  const dedicatedScriptSet = new Set(
    state.identities
      .filter((identity) => identity.status === "dedicated")
      .map((identity) => identity.scriptPubKeyHex),
  );
  const liveProvisionalKeys = deriveLiveProvisionalOutpointKeys(state);
  const auxiliary: OutpointRecord[] = [];
  const seen = new Set<string>();

  for (const entry of spendableUtxos) {
    if (!isSpendableUtxo(entry) || !dedicatedScriptSet.has(entry.scriptPubKey)) {
      continue;
    }

    const outpoint = { txid: entry.txid, vout: entry.vout };
    const key = outpointKey(outpoint);
    if (canonicalAnchorKeys.has(key) || liveProvisionalKeys.has(key) || seen.has(key)) {
      continue;
    }

    seen.add(key);
    auxiliary.push(outpoint);
  }

  return auxiliary;
}

export function computeDesignatedProactiveReserveOutpoints(
  state: WalletStateV1,
  spendableUtxos: readonly RpcListUnspentEntry[],
): OutpointRecord[] {
  const normalizedState = normalizeWalletStateRecord(state);
  if (normalizedState.proactiveReserveSats <= 0) {
    return [];
  }

  const conflictKey = normalizedState.miningState.sharedMiningConflictOutpoint === null
    ? null
    : outpointKey(normalizedState.miningState.sharedMiningConflictOutpoint);
  const eligible = sortFundingEntriesForReserve(
    spendableUtxos.filter((entry) =>
      isConfirmedFundingUtxo(normalizedState, entry)
      && outpointKey({ txid: entry.txid, vout: entry.vout }) !== conflictKey,
    ),
  );
  const selected: OutpointRecord[] = [];
  let total = 0n;
  const target = BigInt(normalizedState.proactiveReserveSats);

  for (const entry of eligible) {
    selected.push({ txid: entry.txid, vout: entry.vout });
    total += btcNumberToSats(entry.amount);
    if (total >= target) {
      break;
    }
  }

  if (total < target) {
    return [];
  }

  return selected;
}

function syncStateWithComputedReserve(
  state: WalletStateV1,
  spendableUtxos: readonly RpcListUnspentEntry[],
): {
  state: WalletStateV1;
  changed: boolean;
} {
  const normalizedState = normalizeWalletStateRecord(state);
  const proactiveReserveOutpoints = computeDesignatedProactiveReserveOutpoints(normalizedState, spendableUtxos);
  const sameLength = proactiveReserveOutpoints.length === normalizedState.proactiveReserveOutpoints.length;
  const sameKeys = sameLength && proactiveReserveOutpoints.every((outpoint, index) =>
    outpointKey(outpoint) === outpointKey(normalizedState.proactiveReserveOutpoints[index]!),
  );

  if (sameKeys && normalizedState === state) {
    return {
      state,
      changed: false,
    };
  }

  if (sameKeys) {
    return {
      state: normalizedState,
      changed: true,
    };
  }

  return {
    state: {
      ...normalizedState,
      proactiveReserveOutpoints,
    },
    changed: true,
  };
}

function collectInactiveTemporaryBuilderLockCleanup(
  state: WalletStateV1,
): {
  state: WalletStateV1;
  staleOutpoints: OutpointRecord[];
  changed: boolean;
} {
  const normalizedState = normalizeWalletStateRecord(state);
  const stale = new Map<string, OutpointRecord>();
  let familiesChanged = false;
  let mutationsChanged = false;

  const proactiveFamilies = normalizedState.proactiveFamilies.map((family) => {
    let nextFamily = family;

    for (const key of ["tx1", "tx2"] as const) {
      const record = nextFamily[key];
      if (record == null || isActiveTrackedTransaction(record) || record.temporaryBuilderLockedOutpoints.length === 0) {
        continue;
      }

      for (const outpoint of record.temporaryBuilderLockedOutpoints) {
        stale.set(outpointKey(outpoint), outpoint);
      }

      nextFamily = {
        ...nextFamily,
        [key]: {
          ...record,
          temporaryBuilderLockedOutpoints: [],
        },
      };
      familiesChanged = true;
    }

    return nextFamily;
  });

  const pendingMutations = (normalizedState.pendingMutations ?? []).map((mutation) => {
    if (isActiveTrackedStatus(mutation.status) || mutation.temporaryBuilderLockedOutpoints.length === 0) {
      return mutation;
    }

    for (const outpoint of mutation.temporaryBuilderLockedOutpoints) {
      stale.set(outpointKey(outpoint), outpoint);
    }

    mutationsChanged = true;
    return {
      ...mutation,
      temporaryBuilderLockedOutpoints: [],
    };
  });

  if (!familiesChanged && !mutationsChanged && normalizedState === state) {
    return {
      state,
      staleOutpoints: [],
      changed: false,
    };
  }

  return {
    state: familiesChanged || mutationsChanged
      ? {
        ...normalizedState,
        proactiveFamilies,
        pendingMutations,
      }
      : normalizedState,
    staleOutpoints: [...stale.values()],
    changed: familiesChanged || mutationsChanged || normalizedState !== state,
  };
}

function collectPersistentPolicyLockedOutpoints(
  state: WalletStateV1,
  spendableUtxos: readonly RpcListUnspentEntry[],
): OutpointRecord[] {
  const outpoints: OutpointRecord[] = [];
  const seen = new Set<string>();
  const pushUnique = (outpoint: OutpointRecord | null) => {
    if (outpoint === null) {
      return;
    }
    const key = outpointKey(outpoint);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    outpoints.push(outpoint);
  };

  for (const domain of state.domains) {
    pushUnique(domain.currentCanonicalAnchorOutpoint);
  }

  for (const outpoint of deriveAuxiliaryDedicatedOutpoints(state, spendableUtxos)) {
    pushUnique(outpoint);
  }

  for (const outpoint of state.proactiveReserveOutpoints) {
    pushUnique(outpoint);
  }

  if (!miningFamilyMayStillExist(state.miningState)) {
    pushUnique(state.miningState.sharedMiningConflictOutpoint);
  }

  return outpoints;
}

function collectManagedScriptPubKeyHexes(state: WalletStateV1): Set<string> {
  const scripts = new Set<string>();
  const add = (scriptPubKeyHex: string | null | undefined) => {
    if (typeof scriptPubKeyHex === "string" && scriptPubKeyHex.length > 0) {
      scripts.add(scriptPubKeyHex);
    }
  };

  add(state.funding.scriptPubKeyHex);

  for (const identity of state.identities) {
    add(identity.scriptPubKeyHex);
  }

  for (const domain of state.domains) {
    add(domain.currentOwnerScriptPubKeyHex);
  }

  for (const family of state.proactiveFamilies) {
    add(family.sourceSenderScriptPubKeyHex);
    add(family.reservedScriptPubKeyHex);
  }

  add(state.miningState.currentSenderScriptPubKeyHex);

  return scripts;
}

function findWalletTransactionOutputScriptPubKeyHex(
  transaction: RpcWalletTransaction | null,
  vout: number,
): string | null {
  const decodedScriptPubKeyHex = transaction?.decoded?.vout.find((output) => output.n === vout)?.scriptPubKey?.hex;
  return typeof decodedScriptPubKeyHex === "string" && decodedScriptPubKeyHex.length > 0
    ? decodedScriptPubKeyHex
    : null;
}

async function collectManagedInspectionUnlocks(options: {
  rpc: WalletCoinControlRpc;
  walletName: string;
  state: WalletStateV1;
  lockedOutpoints: readonly RpcLockedUnspent[];
  fixedInputKeys: ReadonlySet<string>;
  temporarilyUnlockedKeys: ReadonlySet<string>;
}): Promise<OutpointRecord[]> {
  if (options.rpc.getTransaction === undefined) {
    return [];
  }

  const managedScripts = collectManagedScriptPubKeyHexes(options.state);
  if (managedScripts.size === 0 || options.lockedOutpoints.length === 0) {
    return [];
  }

  const transactionCache = new Map<string, Promise<RpcWalletTransaction | null>>();
  const inspectionUnlocks: OutpointRecord[] = [];

  const loadTransaction = (txid: string): Promise<RpcWalletTransaction | null> => {
    let cached = transactionCache.get(txid);
    if (cached === undefined) {
      cached = options.rpc.getTransaction?.(options.walletName, txid).catch(() => null) ?? Promise.resolve(null);
      transactionCache.set(txid, cached);
    }
    return cached;
  };

  for (const outpoint of options.lockedOutpoints) {
    const key = outpointKey(outpoint);
    if (options.fixedInputKeys.has(key) || options.temporarilyUnlockedKeys.has(key)) {
      continue;
    }

    const transaction = await loadTransaction(outpoint.txid);
    const scriptPubKeyHex = findWalletTransactionOutputScriptPubKeyHex(transaction, outpoint.vout);
    if (scriptPubKeyHex !== null && managedScripts.has(scriptPubKeyHex)) {
      inspectionUnlocks.push({ txid: outpoint.txid, vout: outpoint.vout });
    }
  }

  return inspectionUnlocks;
}

export async function reconcilePersistentPolicyLocks(options: {
  rpc: WalletCoinControlRpc;
  walletName: string;
  state: WalletStateV1;
  fixedInputs?: readonly OutpointRecord[];
  temporarilyUnlockedOutpoints?: readonly OutpointRecord[];
  cleanupInactiveTemporaryBuilderLocks?: boolean;
  spendableUtxos?: readonly RpcListUnspentEntry[];
}): Promise<{
  state: WalletStateV1;
  changed: boolean;
  spendableUtxos: readonly RpcListUnspentEntry[];
}> {
  const rawReserveOutpoints = normalizeOutpointRecordList(
    (options.state as WalletStateV1 & { proactiveReserveOutpoints?: OutpointRecord[] }).proactiveReserveOutpoints,
  );
  let state = normalizeWalletStateRecord(options.state);
  let changed = state !== options.state;
  const fixedInputKeys = new Set((options.fixedInputs ?? []).map((outpoint) => outpointKey(outpoint)));
  const temporarilyUnlockedKeys = new Set((options.temporarilyUnlockedOutpoints ?? []).map((outpoint) => outpointKey(outpoint)));

  if (options.cleanupInactiveTemporaryBuilderLocks === true) {
    const cleaned = collectInactiveTemporaryBuilderLockCleanup(state);
    state = cleaned.state;
    changed ||= cleaned.changed;
    if (cleaned.staleOutpoints.length > 0) {
      await options.rpc.lockUnspent(options.walletName, true, cleaned.staleOutpoints).catch(() => undefined);
    }
  }

  const lockedBeforeReserveInspection = await options.rpc.listLockUnspent(options.walletName).catch(() => []);
  const lockedBeforeReserveInspectionKeys = new Set(lockedBeforeReserveInspection.map((outpoint) => outpointKey(outpoint)));
  const reserveInspectionUnlocks = rawReserveOutpoints.filter((outpoint) => {
    const key = outpointKey(outpoint);
    return lockedBeforeReserveInspectionKeys.has(key) && !fixedInputKeys.has(key);
  });
  const managedInspectionUnlocks = await collectManagedInspectionUnlocks({
    rpc: options.rpc,
    walletName: options.walletName,
    state,
    lockedOutpoints: lockedBeforeReserveInspection,
    fixedInputKeys,
    temporarilyUnlockedKeys,
  });
  const inspectionUnlockMap = new Map<string, OutpointRecord>();
  for (const outpoint of [...reserveInspectionUnlocks, ...managedInspectionUnlocks]) {
    inspectionUnlockMap.set(outpointKey(outpoint), outpoint);
  }
  const inspectionUnlocks = [...inspectionUnlockMap.values()];
  if (inspectionUnlocks.length > 0) {
    await options.rpc.lockUnspent(options.walletName, true, inspectionUnlocks).catch(() => undefined);
  }

  const spendableUtxos = inspectionUnlocks.length > 0 || options.spendableUtxos === undefined
    ? await options.rpc.listUnspent(options.walletName, 0).catch(() => [])
    : options.spendableUtxos;
  const previouslyProtectedUniverse = collectPersistentPolicyLockedOutpoints(state, spendableUtxos);
  const reserveSynced = syncStateWithComputedReserve(state, spendableUtxos);
  state = reserveSynced.state;
  changed ||= reserveSynced.changed;

  const protectedUniverse = collectPersistentPolicyLockedOutpoints(state, spendableUtxos);
  if (protectedUniverse.length === 0 && previouslyProtectedUniverse.length === 0) {
    return {
      state,
      changed,
      spendableUtxos,
    };
  }

  const protectedUniverseKeys = new Set(protectedUniverse.map((outpoint) => outpointKey(outpoint)));
  const previouslyProtectedUniverseKeys = new Set(previouslyProtectedUniverse.map((outpoint) => outpointKey(outpoint)));
  const managedProtectedKeys = new Set([
    ...protectedUniverseKeys,
    ...previouslyProtectedUniverseKeys,
  ]);

  const locked = await options.rpc.listLockUnspent(options.walletName).catch(() => []);
  const spendableKeys = new Set(spendableUtxos.map((entry) => outpointKey(entry)));
  const lockedKeys = new Set(locked.map((outpoint) => outpointKey(outpoint)));
  const expectedLocked = protectedUniverse.filter((outpoint) => {
    const key = outpointKey(outpoint);
    return (spendableKeys.has(key) || lockedKeys.has(key))
      && !fixedInputKeys.has(key)
      && !temporarilyUnlockedKeys.has(key);
  });
  const expectedLockedKeys = new Set(expectedLocked.map((outpoint) => outpointKey(outpoint)));
  const lockedManaged = locked.filter((outpoint) => managedProtectedKeys.has(outpointKey(outpoint)));
  const staleLocked = lockedManaged.filter((outpoint) => !expectedLockedKeys.has(outpointKey(outpoint)));
  const missingLocked = protectedUniverse.filter((outpoint) => {
    const key = outpointKey(outpoint);
    return spendableKeys.has(key)
      && !fixedInputKeys.has(key)
      && !temporarilyUnlockedKeys.has(key)
      && !lockedKeys.has(key);
  });

  if (staleLocked.length > 0) {
    await options.rpc.lockUnspent(options.walletName, true, staleLocked).catch(() => undefined);
  }

  if (missingLocked.length > 0) {
    await options.rpc.lockUnspent(options.walletName, false, missingLocked).catch(() => undefined);
  }

  return {
    state,
    changed,
    spendableUtxos,
  };
}

export async function persistWalletCoinControlStateIfNeeded(options: {
  state: WalletStateV1;
  access: Parameters<typeof persistWalletStateUpdate>[0]["access"];
  session?: UnlockSessionStateV1 | null;
  paths: WalletRuntimePaths;
  nowUnixMs: number;
  replacePrimary?: boolean;
  rpc: WalletCoinControlRpc;
  cleanupInactiveTemporaryBuilderLocks?: boolean;
}): Promise<{
  changed: boolean;
  session: UnlockSessionStateV1 | null;
  state: WalletStateV1;
}> {
  const reconciled = await reconcilePersistentPolicyLocks({
    rpc: options.rpc,
    walletName: options.state.managedCoreWallet.walletName,
    state: options.state,
    cleanupInactiveTemporaryBuilderLocks: options.cleanupInactiveTemporaryBuilderLocks ?? true,
  });

  if (!reconciled.changed) {
    return {
      changed: false,
      session: options.session ?? null,
      state: reconciled.state,
    };
  }

  const nextState = await persistWalletStateUpdate({
    state: reconciled.state,
    access: options.access,
    paths: options.paths,
    nowUnixMs: options.nowUnixMs,
    replacePrimary: options.replacePrimary,
  });

  if (options.session == null) {
    return {
      changed: true,
      session: null,
      state: nextState,
    };
  }

  const nextSession: UnlockSessionStateV1 = {
    ...options.session,
    walletRootId: nextState.walletRootId,
    sourceStateRevision: nextState.stateRevision,
  };
  await saveUnlockSession(
    options.paths.walletUnlockSessionPath,
    nextSession,
    options.access as UnlockSessionSaveAccess,
  );

  return {
    changed: true,
    session: nextSession,
    state: nextState,
  };
}

type UnlockSessionSaveAccess = Parameters<typeof saveUnlockSession>[2];
