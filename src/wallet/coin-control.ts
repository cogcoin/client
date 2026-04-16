import type {
  RpcListUnspentEntry,
  RpcLockedUnspent,
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

export const DEFAULT_PROACTIVE_RESERVE_SATS = 50_000;

export interface WalletCoinControlRpc {
  listUnspent(walletName: string, minConf?: number): Promise<RpcListUnspentEntry[]>;
  listLockUnspent(walletName: string): Promise<RpcLockedUnspent[]>;
  lockUnspent(walletName: string, unlock: boolean, outputs: RpcLockedUnspent[]): Promise<boolean>;
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

  return Math.max(0, Math.trunc(raw));
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
  const proactiveReserveSats = normalizeReserveSats(
    (state as WalletStateV1 & { proactiveReserveSats?: number }).proactiveReserveSats,
  );
  const proactiveReserveOutpoints = normalizeOutpointRecordList(
    (state as WalletStateV1 & { proactiveReserveOutpoints?: OutpointRecord[] }).proactiveReserveOutpoints,
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
  const proactiveReserveSats = normalizeReserveSats(
    (payload as PortableWalletArchivePayloadV1 & { proactiveReserveSats?: number }).proactiveReserveSats,
  );
  const proactiveReserveOutpoints = normalizeOutpointRecordList(
    (payload as PortableWalletArchivePayloadV1 & { proactiveReserveOutpoints?: OutpointRecord[] }).proactiveReserveOutpoints,
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
  let state = normalizeWalletStateRecord(options.state);
  let changed = state !== options.state;

  if (options.cleanupInactiveTemporaryBuilderLocks === true) {
    const cleaned = collectInactiveTemporaryBuilderLockCleanup(state);
    state = cleaned.state;
    changed ||= cleaned.changed;
    if (cleaned.staleOutpoints.length > 0) {
      await options.rpc.lockUnspent(options.walletName, true, cleaned.staleOutpoints).catch(() => undefined);
    }
  }

  const spendableUtxos = options.spendableUtxos ?? await options.rpc.listUnspent(options.walletName, 0).catch(() => []);
  const reserveSynced = syncStateWithComputedReserve(state, spendableUtxos);
  state = reserveSynced.state;
  changed ||= reserveSynced.changed;

  const protectedUniverse = collectPersistentPolicyLockedOutpoints(state, spendableUtxos);
  if (protectedUniverse.length === 0) {
    return {
      state,
      changed,
      spendableUtxos,
    };
  }

  const protectedUniverseKeys = new Set(protectedUniverse.map((outpoint) => outpointKey(outpoint)));
  const fixedInputKeys = new Set((options.fixedInputs ?? []).map((outpoint) => outpointKey(outpoint)));
  const temporarilyUnlockedKeys = new Set((options.temporarilyUnlockedOutpoints ?? []).map((outpoint) => outpointKey(outpoint)));

  const locked = await options.rpc.listLockUnspent(options.walletName).catch(() => []);
  const spendableKeys = new Set(spendableUtxos.map((entry) => outpointKey(entry)));
  const expectedLocked = protectedUniverse.filter((outpoint) => {
    const key = outpointKey(outpoint);
    return spendableKeys.has(key) && !fixedInputKeys.has(key) && !temporarilyUnlockedKeys.has(key);
  });
  const expectedLockedKeys = new Set(expectedLocked.map((outpoint) => outpointKey(outpoint)));
  const lockedProtected = locked.filter((outpoint) => protectedUniverseKeys.has(outpointKey(outpoint)));
  const lockedProtectedKeys = new Set(lockedProtected.map((outpoint) => outpointKey(outpoint)));
  const staleLocked = lockedProtected.filter((outpoint) =>
    !expectedLockedKeys.has(outpointKey(outpoint)) || !spendableKeys.has(outpointKey(outpoint)),
  );
  const missingLocked = expectedLocked.filter((outpoint) => !lockedProtectedKeys.has(outpointKey(outpoint)));

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
