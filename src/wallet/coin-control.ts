import { saveUnlockSession } from "./state/session.js";
import { persistWalletStateUpdate } from "./descriptor-normalization.js";
import type { WalletRuntimePaths } from "./runtime.js";
import { normalizeMiningStateRecord } from "./mining/state.js";
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

type LegacyManagedCoreWallet = {
  walletAddress?: string | null;
  walletScriptPubKeyHex?: string | null;
  fundingAddress0?: string | null;
  fundingScriptPubKeyHex0?: string | null;
  walletName?: string;
  internalPassphrase?: string;
  descriptorChecksum?: string | null;
  proofStatus?: "not-proven" | "ready" | "missing" | "mismatch";
  lastImportedAtUnixMs?: number | null;
  lastVerifiedAtUnixMs?: number | null;
};

type LegacyWalletStateRecord = Partial<WalletStateV1> & {
  schemaVersion?: number;
  hookClientState?: unknown;
  localScriptPubKeyHexes?: string[] | null;
  funding?: { address?: string | null; scriptPubKeyHex?: string | null } | null;
  identities?: Array<{ scriptPubKeyHex?: string | null }> | null;
  managedCoreWallet?: LegacyManagedCoreWallet | null;
  domains?: Array<Partial<WalletStateV1["domains"][number]> & {
    name?: string | null;
    domainId?: number | null;
    currentOwnerScriptPubKeyHex?: string | null;
    canonicalChainStatus?: WalletStateV1["domains"][number]["canonicalChainStatus"];
    currentCanonicalAnchorOutpoint?: WalletStateV1["domains"][number]["currentCanonicalAnchorOutpoint"];
    foundingMessageText?: string | null;
    birthTime?: number | null;
  }> | null;
  pendingMutations?: WalletStateV1["pendingMutations"] | null;
};

function uniqueLocalScriptPubKeyHexes(state: LegacyWalletStateRecord): string[] {
  return uniqueStrings([
    state.funding?.scriptPubKeyHex ?? "",
    ...(state.localScriptPubKeyHexes ?? []),
    ...((state.identities ?? []).map((identity) => identity?.scriptPubKeyHex ?? "")),
  ]);
}

function normalizeDomains(rawDomains: LegacyWalletStateRecord["domains"]): WalletStateV1["domains"] {
  return (rawDomains ?? [])
    .filter((domain): domain is NonNullable<LegacyWalletStateRecord["domains"]>[number] =>
      typeof domain?.name === "string" && domain.name.trim().length > 0
    )
    .map((domain) => ({
      name: domain.name!.trim().toLowerCase(),
      domainId: domain.domainId ?? null,
      currentOwnerScriptPubKeyHex: domain.currentOwnerScriptPubKeyHex ?? null,
      canonicalChainStatus: domain.canonicalChainStatus ?? "unknown",
      currentCanonicalAnchorOutpoint: domain.currentCanonicalAnchorOutpoint ?? null,
      foundingMessageText: domain.foundingMessageText ?? null,
      birthTime: domain.birthTime ?? null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function normalizeWalletStateRecord(rawState: LegacyWalletStateRecord): WalletStateV1 {
  const fundingAddress = rawState.funding?.address
    ?? rawState.managedCoreWallet?.walletAddress
    ?? rawState.managedCoreWallet?.fundingAddress0
    ?? "";
  const fundingScriptPubKeyHex = rawState.funding?.scriptPubKeyHex
    ?? rawState.managedCoreWallet?.walletScriptPubKeyHex
    ?? rawState.managedCoreWallet?.fundingScriptPubKeyHex0
    ?? "";
  const localScriptPubKeyHexes = uniqueLocalScriptPubKeyHexes(rawState);
  const pendingMutations = (rawState.pendingMutations ?? [])
    .filter((mutation) => mutation.status === "confirmed" || mutation.status === "canceled")
    .map((mutation) => ({
      ...mutation,
      senderLocalIndex: mutation.senderScriptPubKeyHex === fundingScriptPubKeyHex ? 0 : null,
      senderScriptPubKeyHex: mutation.senderScriptPubKeyHex === ""
        ? fundingScriptPubKeyHex
        : mutation.senderScriptPubKeyHex,
      temporaryBuilderLockedOutpoints: [],
    }));

  return {
    schemaVersion: 4,
    stateRevision: rawState.stateRevision ?? 1,
    lastWrittenAtUnixMs: rawState.lastWrittenAtUnixMs ?? 0,
    walletRootId: rawState.walletRootId ?? "",
    network: rawState.network ?? "mainnet",
    anchorValueSats: rawState.anchorValueSats ?? 2_000,
    localScriptPubKeyHexes,
    mnemonic: {
      phrase: rawState.mnemonic?.phrase ?? "",
      language: rawState.mnemonic?.language ?? "english",
    },
    keys: {
      masterFingerprintHex: rawState.keys?.masterFingerprintHex ?? "",
      accountPath: rawState.keys?.accountPath ?? "",
      accountXprv: rawState.keys?.accountXprv ?? "",
      accountXpub: rawState.keys?.accountXpub ?? "",
    },
    descriptor: {
      privateExternal: rawState.descriptor?.privateExternal ?? "",
      publicExternal: rawState.descriptor?.publicExternal ?? "",
      checksum: rawState.descriptor?.checksum ?? null,
      rangeEnd: rawState.descriptor?.rangeEnd ?? 0,
      safetyMargin: rawState.descriptor?.safetyMargin ?? 0,
    },
    funding: {
      address: fundingAddress,
      scriptPubKeyHex: fundingScriptPubKeyHex,
    },
    walletBirthTime: rawState.walletBirthTime ?? 0,
    managedCoreWallet: {
      walletName: rawState.managedCoreWallet?.walletName ?? "",
      internalPassphrase: rawState.managedCoreWallet?.internalPassphrase ?? "",
      descriptorChecksum: rawState.managedCoreWallet?.descriptorChecksum ?? null,
      walletAddress: rawState.managedCoreWallet?.walletAddress ?? fundingAddress,
      walletScriptPubKeyHex: rawState.managedCoreWallet?.walletScriptPubKeyHex ?? fundingScriptPubKeyHex,
      proofStatus: rawState.managedCoreWallet?.proofStatus ?? "not-proven",
      lastImportedAtUnixMs: rawState.managedCoreWallet?.lastImportedAtUnixMs ?? null,
      lastVerifiedAtUnixMs: rawState.managedCoreWallet?.lastVerifiedAtUnixMs ?? null,
    },
    domains: normalizeDomains(rawState.domains),
    miningState: normalizeMiningStateRecord(rawState.miningState as WalletStateV1["miningState"]),
    pendingMutations,
  };
}

export function normalizePortableWalletArchivePayload(
  payload: Partial<PortableWalletArchivePayloadV1> & {
    schemaVersion?: number;
    hookClientState?: unknown;
    localScriptPubKeyHexes?: string[] | null;
    expected?: Partial<PortableWalletArchivePayloadV1["expected"]> & {
      fundingAddress0?: string;
      fundingScriptPubKeyHex0?: string;
    };
    identities?: Array<{ scriptPubKeyHex?: string | null }> | null;
    domains?: LegacyWalletStateRecord["domains"];
  },
): PortableWalletArchivePayloadV1 {
  const walletScriptPubKeyHex = payload.expected?.walletScriptPubKeyHex
    ?? payload.expected?.fundingScriptPubKeyHex0
    ?? "";
  const walletAddress = payload.expected?.walletAddress
    ?? payload.expected?.fundingAddress0
    ?? "";
  const localScriptPubKeyHexes = uniqueStrings([
    walletScriptPubKeyHex,
    ...((payload.localScriptPubKeyHexes ?? [])),
    ...((payload.identities ?? []).map((identity) => identity.scriptPubKeyHex ?? "")),
  ]);

  return {
    schemaVersion: 4,
    exportedAtUnixMs: payload.exportedAtUnixMs ?? 0,
    walletRootId: payload.walletRootId ?? "",
    network: payload.network ?? "mainnet",
    anchorValueSats: payload.anchorValueSats ?? 2_000,
    localScriptPubKeyHexes,
    mnemonic: {
      phrase: payload.mnemonic?.phrase ?? "",
      language: payload.mnemonic?.language ?? "english",
    },
    expected: {
      masterFingerprintHex: payload.expected?.masterFingerprintHex ?? "",
      accountPath: payload.expected?.accountPath ?? "",
      accountXpub: payload.expected?.accountXpub ?? "",
      publicExternalDescriptor: payload.expected?.publicExternalDescriptor ?? "",
      descriptorChecksum: payload.expected?.descriptorChecksum ?? null,
      rangeEnd: payload.expected?.rangeEnd ?? 0,
      safetyMargin: payload.expected?.safetyMargin ?? 0,
      walletAddress,
      walletScriptPubKeyHex,
      walletBirthTime: payload.expected?.walletBirthTime ?? 0,
    },
    domains: normalizeDomains(payload.domains),
    miningState: normalizeMiningStateRecord(payload.miningState as WalletStateV1["miningState"]),
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
