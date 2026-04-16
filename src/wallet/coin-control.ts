import { saveUnlockSession } from "./state/session.js";
import { persistWalletStateUpdate } from "./descriptor-normalization.js";
import type { WalletRuntimePaths } from "./runtime.js";
import type {
  OutpointRecord,
  PortableWalletArchivePayloadV1,
  UnlockSessionStateV1,
  WalletStateV1,
} from "./types.js";
import type { RpcListUnspentEntry } from "../bitcoind/types.js";

export const DEFAULT_PROACTIVE_RESERVE_SATS = 0;

export interface WalletCoinControlRpc {
  listUnspent(walletName: string, minConf?: number): Promise<RpcListUnspentEntry[]>;
}

export function outpointKey(outpoint: OutpointRecord): string {
  return `${outpoint.txid}:${outpoint.vout}`;
}

function uniqueStrings(values: readonly string[]): string[] {
  return values.filter((value, index, entries) =>
    typeof value === "string" && value.length > 0 && entries.indexOf(value) === index
  );
}

function uniqueOutpoints(values: readonly OutpointRecord[] | null | undefined): OutpointRecord[] {
  const seen = new Set<string>();
  const normalized: OutpointRecord[] = [];

  for (const value of values ?? []) {
    if (
      value == null
      || typeof value.txid !== "string"
      || value.txid.length === 0
      || typeof value.vout !== "number"
      || !Number.isInteger(value.vout)
      || value.vout < 0
    ) {
      continue;
    }
    const key = outpointKey(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({ txid: value.txid, vout: value.vout });
  }

  return normalized;
}

function normalizeAssignedDomains(state: WalletStateV1): string[] {
  return (state.domains ?? [])
    .filter((domain) => domain.currentOwnerScriptPubKeyHex === state.funding.scriptPubKeyHex)
    .map((domain) => domain.name)
    .sort((left, right) => left.localeCompare(right));
}

function normalizeDomainLocalIndex(state: WalletStateV1, scriptHexes: readonly string[]): WalletStateV1["domains"] {
  return (state.domains ?? []).map((domain) => ({
    ...domain,
    dedicatedIndex: null,
    currentOwnerLocalIndex: scriptHexes.includes(domain.currentOwnerScriptPubKeyHex ?? "")
      ? 0
      : null,
    localAnchorIntent: "none",
  }));
}

export function normalizeWalletStateRecord(state: WalletStateV1): WalletStateV1 {
  const localScriptPubKeyHexes = uniqueStrings([
    state.funding.scriptPubKeyHex,
    ...((state.localScriptPubKeyHexes ?? [])),
    ...((state.identities ?? []).map((identity) => identity.scriptPubKeyHex)),
  ]);

  return {
    ...state,
    schemaVersion: 2,
    localScriptPubKeyHexes,
    proactiveReserveSats: 0,
    proactiveReserveOutpoints: [],
    nextDedicatedIndex: 1,
    fundingIndex: 0,
    managedCoreWallet: {
      ...state.managedCoreWallet,
      walletAddress: state.funding.address,
      walletScriptPubKeyHex: state.funding.scriptPubKeyHex,
      fundingAddress0: state.funding.address,
      fundingScriptPubKeyHex0: state.funding.scriptPubKeyHex,
    },
    identities: [{
      index: 0,
      scriptPubKeyHex: state.funding.scriptPubKeyHex,
      address: state.funding.address,
      status: "funding",
      assignedDomainNames: normalizeAssignedDomains(state),
    }],
    domains: normalizeDomainLocalIndex(state, localScriptPubKeyHexes),
    proactiveFamilies: (state.proactiveFamilies ?? []).filter((family) =>
      family.status === "confirmed" || family.status === "canceled"
    ),
    pendingMutations: (state.pendingMutations ?? []).filter((mutation) =>
      mutation.status === "confirmed" || mutation.status === "canceled"
    ).map((mutation) => ({
      ...mutation,
      senderLocalIndex: mutation.senderScriptPubKeyHex === state.funding.scriptPubKeyHex ? 0 : null,
      senderScriptPubKeyHex: state.funding.scriptPubKeyHex,
      temporaryBuilderLockedOutpoints: [],
    })),
  };
}

export function normalizePortableWalletArchivePayload(
  payload: PortableWalletArchivePayloadV1,
): PortableWalletArchivePayloadV1 {
  const walletScriptPubKeyHex = payload.expected.walletScriptPubKeyHex ?? payload.expected.fundingScriptPubKeyHex0;
  const walletAddress = payload.expected.walletAddress ?? payload.expected.fundingAddress0;
  const localScriptPubKeyHexes = uniqueStrings([
    walletScriptPubKeyHex,
    ...((payload.localScriptPubKeyHexes ?? [])),
    ...((payload.identities ?? []).map((identity) => identity.scriptPubKeyHex)),
  ]);

  return {
    ...payload,
    schemaVersion: 2,
    localScriptPubKeyHexes,
    proactiveReserveSats: 0,
    proactiveReserveOutpoints: [],
    nextDedicatedIndex: 1,
    fundingIndex: 0,
    expected: {
      ...payload.expected,
      walletAddress,
      walletScriptPubKeyHex,
      fundingAddress0: walletAddress,
      fundingScriptPubKeyHex0: walletScriptPubKeyHex,
    },
    identities: [{
      index: 0,
      scriptPubKeyHex: walletScriptPubKeyHex,
      address: walletAddress,
      status: "funding",
      assignedDomainNames: [],
    }],
    domains: (payload.domains ?? []).map((domain) => ({
      ...domain,
      dedicatedIndex: null,
      currentOwnerLocalIndex: null,
      localAnchorIntent: "none",
    })),
    proactiveFamilies: (payload.proactiveFamilies ?? []).filter((family) =>
      family.status === "confirmed" || family.status === "canceled"
    ),
  };
}

export function computeDesignatedProactiveReserveOutpoints(
  _state?: WalletStateV1,
  _spendableUtxos?: readonly RpcListUnspentEntry[],
): OutpointRecord[] {
  return [];
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
  const state = normalizeWalletStateRecord(options.state);
  return {
    state,
    changed: state !== options.state,
    spendableUtxos: options.spendableUtxos ?? await options.rpc.listUnspent(options.walletName, 0).catch(() => []),
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
}): Promise<{
  changed: boolean;
  session: UnlockSessionStateV1 | null;
  state: WalletStateV1;
}> {
  const reconciled = await reconcilePersistentPolicyLocks({
    rpc: options.rpc,
    walletName: options.state.managedCoreWallet.walletName,
    state: options.state,
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
  await saveUnlockSession(options.paths.walletUnlockSessionPath, nextSession, options.access);

  return {
    changed: true,
    session: nextSession,
    state: nextState,
  };
}
