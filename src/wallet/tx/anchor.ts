import { createHash, randomBytes } from "node:crypto";

import { encodeSentence } from "@cogcoin/scoring";
import { getListing, lookupDomain } from "@cogcoin/indexer/queries";

import { attachOrStartManagedBitcoindService } from "../../bitcoind/service.js";
import { createRpcClient } from "../../bitcoind/node.js";
import type {
  RpcDecodedPsbt,
  RpcListUnspentEntry,
  RpcTransaction,
} from "../../bitcoind/types.js";
import { acquireFileLock } from "../fs/lock.js";
import type { WalletPrompter } from "../lifecycle.js";
import {
  deriveWalletIdentityMaterial,
  type WalletDerivedIdentity,
} from "../material.js";
import { resolveWalletRuntimePathsForTesting, type WalletRuntimePaths } from "../runtime.js";
import {
  createDefaultWalletSecretProvider,
  type WalletSecretProvider,
} from "../state/provider.js";
import type {
  DomainRecord,
  LocalIdentityRecord,
  OutpointRecord,
  PendingMutationRecord,
  ProactiveFamilyStateRecord,
  ProactiveFamilyTransactionRecord,
  WalletStateV1,
} from "../types.js";
import {
  serializeDomainAnchor,
  serializeDomainTransfer,
  validateDomainName,
} from "../cogop/index.js";
import { openWalletReadContext, type WalletReadContext } from "../read/index.js";
import {
  assertFixedInputPrefixMatches,
  assertFundingInputsAfterFixedPrefix,
  assertWalletMutationContextReady,
  buildWalletMutationTransactionWithReserveFallback,
  findSpendableFundingInputsFromTransaction,
  getDecodedInputScriptPubKeyHex,
  isAlreadyAcceptedError,
  isBroadcastUnknownError,
  outpointKey,
  pauseMiningForWalletMutation,
  saveWalletStatePreservingUnlock,
  unlockTemporaryBuilderLocks,
  type BuiltWalletMutationTransaction,
  type FixedWalletInput,
  inputMatchesOutpoint,
  type MutationSender,
  updateMutationRecord,
  type WalletMutationRpcClient,
} from "./common.js";
import { confirmYesNo } from "./confirm.js";
import { findPendingMutationByIntent, upsertPendingMutation } from "./journal.js";

interface WalletAnchorRpcClient extends WalletMutationRpcClient {
  getBlockchainInfo(): Promise<{ blocks: number }>;
  sendRawTransaction(hex: string): Promise<string>;
  getRawMempool(): Promise<string[]>;
  getRawTransaction(txid: string, verbose?: boolean): Promise<RpcTransaction>;
}

interface AnchorTxPlan {
  sender: MutationSender;
  changeAddress: string;
  fixedInputs: FixedWalletInput[];
  outputs: unknown[];
  changePosition: number;
  expectedOpReturnScriptHex: string;
  expectedProvisionalAnchorScriptHex: string;
  expectedProvisionalAnchorValueSats: bigint;
  expectedReplacementAnchorScriptHex: string | null;
  expectedReplacementAnchorValueSats: bigint | null;
  allowedFundingScriptPubKeyHex: string;
  eligibleFundingOutpointKeys: Set<string>;
  requiredSenderOutpoint: OutpointRecord | null;
  requiredProvisionalOutpoint: OutpointRecord | null;
  errorPrefix: string;
}

type BuiltAnchorTransaction = BuiltWalletMutationTransaction;

interface AnchorIdentityTarget extends WalletDerivedIdentity {
  localIndex: number;
}

interface AnchorOperation {
  readContext: WalletReadContext & {
    localState: {
      availability: "ready";
      state: WalletStateV1;
      unlockUntilUnixMs: number;
    };
    snapshot: NonNullable<WalletReadContext["snapshot"]>;
    model: NonNullable<WalletReadContext["model"]>;
  };
  state: WalletStateV1;
  unlockUntilUnixMs: number;
  sourceSender: MutationSender;
  sourceAnchorOutpoint: OutpointRecord | null;
  chainDomain: NonNullable<ReturnType<typeof lookupDomain>>;
  targetIdentity: AnchorIdentityTarget;
  foundingMessageText: string | null;
  foundingMessagePayloadHex: string | null;
  hadListing: boolean;
}

export interface AnchorDomainOptions {
  domainName: string;
  foundingMessageText?: string | null;
  promptForFoundingMessageWhenMissing?: boolean;
  dataDir: string;
  databasePath: string;
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
  openReadContext?: typeof openWalletReadContext;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => WalletAnchorRpcClient;
}

export interface AnchorDomainResult {
  domainName: string;
  txid: string;
  tx1Txid: string;
  tx2Txid: string;
  dedicatedIndex: number;
  status: "live" | "confirmed";
  reusedExisting: boolean;
  foundingMessageText?: string | null;
}

export interface ClearPendingAnchorOptions {
  domainName: string;
  dataDir: string;
  databasePath: string;
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  assumeYes?: boolean;
  force?: boolean;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
  openReadContext?: typeof openWalletReadContext;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => WalletAnchorRpcClient;
}

export interface AnchorClearFamilyActionSummary {
  familyId: string;
  previousStatus: ProactiveFamilyStateRecord["status"];
  previousStep: ProactiveFamilyStateRecord["currentStep"] | null;
  action: "cleared" | "canceled";
}

export interface ClearPendingAnchorResult {
  domainName: string;
  cleared: boolean;
  previousFamilyStatus: ProactiveFamilyStateRecord["status"] | null;
  previousFamilyStep: ProactiveFamilyStateRecord["currentStep"] | null;
  releasedDedicatedIndex: number | null;
  forced: boolean;
  clearedReservedFamilies: number;
  canceledActiveFamilies: number;
  releasedDedicatedIndices: number[];
  affectedFamilies: AnchorClearFamilyActionSummary[];
  previousLocalAnchorIntent: DomainRecord["localAnchorIntent"] | null;
  previousDedicatedIndex: number | null;
  resultingLocalAnchorIntent: DomainRecord["localAnchorIntent"] | null;
  resultingDedicatedIndex: number | null;
}

const ACTIVE_FAMILY_STATUSES = new Set<ProactiveFamilyStateRecord["status"]>([
  "draft",
  "broadcasting",
  "broadcast-unknown",
  "live",
  "repair-required",
]);

function normalizeDomainName(domainName: string): string {
  const normalized = domainName.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("wallet_anchor_missing_domain");
  }
  validateDomainName(normalized);
  return normalized;
}

function encodeOpReturnScript(payload: Uint8Array): string {
  if (payload.length <= 75) {
    return Buffer.concat([
      Buffer.from([0x6a, payload.length]),
      Buffer.from(payload),
    ]).toString("hex");
  }

  return Buffer.concat([
    Buffer.from([0x6a, 0x4c, payload.length]),
    Buffer.from(payload),
  ]).toString("hex");
}

function satsToBtcNumber(value: bigint): number {
  return Number(value) / 100_000_000;
}

function valueToSats(value: number | string): bigint {
  const text = typeof value === "number" ? value.toFixed(8) : value;
  const match = /^(-?)(\d+)(?:\.(\d{0,8}))?$/.exec(text.trim());

  if (match == null) {
    throw new Error(`wallet_anchor_invalid_amount_${text}`);
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2] ?? "0");
  const fraction = BigInt((match[3] ?? "").padEnd(8, "0"));
  return sign * ((whole * 100_000_000n) + fraction);
}

function createIntentFingerprint(parts: Array<string | number | bigint>): string {
  return createHash("sha256")
    .update(parts.map((part) => String(part)).join("\n"))
    .digest("hex");
}

function isSpendableConfirmedUtxo(entry: RpcListUnspentEntry): boolean {
  return entry.confirmations >= 1
    && entry.spendable !== false
    && entry.safe !== false;
}

function sortUtxos(entries: RpcListUnspentEntry[]): RpcListUnspentEntry[] {
  return entries
    .slice()
    .sort((left, right) =>
      right.amount - left.amount
      || left.txid.localeCompare(right.txid)
      || left.vout - right.vout);
}

function createReservedIdentityRecord(target: AnchorIdentityTarget): LocalIdentityRecord {
  return {
    index: target.localIndex,
    scriptPubKeyHex: target.scriptPubKeyHex,
    address: target.address,
    status: "dedicated",
    assignedDomainNames: [],
  };
}

function withUpdatedAssignedDomain(options: {
  identities: LocalIdentityRecord[];
  sourceLocalIndex: number | null;
  targetLocalIndex: number;
  domainName: string;
}): LocalIdentityRecord[] {
  return options.identities.map((identity) => {
    let assigned = identity.assignedDomainNames.filter((name) => name !== options.domainName);

    if (identity.index === options.targetLocalIndex) {
      assigned = [...assigned, options.domainName];
    }

    if (identity.index !== options.sourceLocalIndex && identity.index !== options.targetLocalIndex) {
      assigned = identity.assignedDomainNames.slice();
    }

    return {
      ...identity,
      assignedDomainNames: assigned.sort((left, right) => left.localeCompare(right)),
    };
  });
}

function upsertProactiveFamily(
  state: WalletStateV1,
  family: ProactiveFamilyStateRecord,
): WalletStateV1 {
  const families = state.proactiveFamilies.slice();
  const existingIndex = families.findIndex((entry) => entry.familyId === family.familyId);

  if (existingIndex >= 0) {
    families[existingIndex] = family;
  } else {
    families.push(family);
  }

  return {
    ...state,
    proactiveFamilies: families,
  };
}

function findAnchorFamilyByIntent(
  state: WalletStateV1,
  intentFingerprintHex: string,
): ProactiveFamilyStateRecord | null {
  return state.proactiveFamilies.find((family) =>
    family.type === "anchor" && family.intentFingerprintHex === intentFingerprintHex
  ) ?? null;
}

function findActiveAnchorFamilyByDomain(
  state: WalletStateV1,
  domainName: string,
): ProactiveFamilyStateRecord | null {
  return findActiveAnchorFamiliesByDomain(state, domainName)[0] ?? null;
}

function compareAnchorFamilies(
  left: ProactiveFamilyStateRecord,
  right: ProactiveFamilyStateRecord,
): number {
  return left.createdAtUnixMs - right.createdAtUnixMs
    || (left.lastUpdatedAtUnixMs ?? left.createdAtUnixMs) - (right.lastUpdatedAtUnixMs ?? right.createdAtUnixMs)
    || left.familyId.localeCompare(right.familyId);
}

function findAnchorFamiliesByDomain(
  state: WalletStateV1,
  domainName: string,
): ProactiveFamilyStateRecord[] {
  return state.proactiveFamilies
    .filter((family) => family.type === "anchor" && family.domainName === domainName)
    .sort(compareAnchorFamilies);
}

function findActiveAnchorFamiliesByDomain(
  state: WalletStateV1,
  domainName: string,
): ProactiveFamilyStateRecord[] {
  return findAnchorFamiliesByDomain(state, domainName)
    .filter((family) => ACTIVE_FAMILY_STATUSES.has(family.status));
}

function isClearableReservedAnchorFamily(
  family: ProactiveFamilyStateRecord | null,
): family is ProactiveFamilyStateRecord & {
  status: "draft";
  currentStep: "reserved";
} {
  return family?.type === "anchor"
    && family.status === "draft"
    && family.currentStep === "reserved";
}

function isClearableReservedAnchorFamilyRecord(
  family: ProactiveFamilyStateRecord,
): family is ProactiveFamilyStateRecord & {
  status: "draft";
  currentStep: "reserved";
} {
  return family.status === "draft" && family.currentStep === "reserved";
}

function findAnchorFamilyById(
  state: WalletStateV1,
  familyId: string,
): ProactiveFamilyStateRecord | null {
  return state.proactiveFamilies.find((family) => family.familyId === familyId) ?? null;
}

function collectActivelyReservedDedicatedIndices(
  state: WalletStateV1,
): Set<number> {
  const reservedIndices = new Set<number>();

  for (const domain of state.domains) {
    if (domain.dedicatedIndex !== null && domain.localAnchorIntent !== "none") {
      reservedIndices.add(domain.dedicatedIndex);
    }
  }

  for (const family of state.proactiveFamilies) {
    if (
      family.type === "anchor"
      && ACTIVE_FAMILY_STATUSES.has(family.status)
      && family.reservedDedicatedIndex !== null
      && family.reservedDedicatedIndex !== undefined
    ) {
      reservedIndices.add(family.reservedDedicatedIndex);
    }
  }

  return reservedIndices;
}

function selectReusableDedicatedIdentityTarget(
  state: WalletStateV1,
) : AnchorIdentityTarget | null {
  const reservedIndices = collectActivelyReservedDedicatedIndices(state);
  const reusableIdentity = state.identities
    .filter((identity) =>
      identity.status === "dedicated"
      && identity.address !== null
      && identity.assignedDomainNames.length === 0
      && !reservedIndices.has(identity.index)
    )
    .sort((left, right) => left.index - right.index)[0];

  if (reusableIdentity == null) {
    return null;
  }

  const material = deriveWalletIdentityMaterial(state.keys.accountXprv, reusableIdentity.index);
  const reusableAddress = reusableIdentity.address;

  if (reusableAddress === null) {
    return null;
  }

  return {
    ...material,
    localIndex: reusableIdentity.index,
    address: reusableAddress,
    scriptPubKeyHex: reusableIdentity.scriptPubKeyHex,
  };
}

function selectFreshDedicatedIdentityTarget(
  state: WalletStateV1,
): AnchorIdentityTarget {
  const unavailableIndices = new Set<number>();

  for (const identity of state.identities) {
    unavailableIndices.add(identity.index);
  }

  for (const domain of state.domains) {
    if (domain.dedicatedIndex !== null) {
      unavailableIndices.add(domain.dedicatedIndex);
    }
  }

  for (const index of collectActivelyReservedDedicatedIndices(state)) {
    unavailableIndices.add(index);
  }

  const startIndex = Math.max(1, state.nextDedicatedIndex);
  for (let index = startIndex; index <= state.descriptor.rangeEnd; index += 1) {
    if (unavailableIndices.has(index)) {
      continue;
    }

    const material = deriveWalletIdentityMaterial(state.keys.accountXprv, index);
    return {
      ...material,
      localIndex: index,
    };
  }

  throw new Error("wallet_anchor_no_fresh_dedicated_index");
}

function selectNextDedicatedIdentityTarget(
  state: WalletStateV1,
): AnchorIdentityTarget {
  return selectReusableDedicatedIdentityTarget(state) ?? selectFreshDedicatedIdentityTarget(state);
}

function deriveAnchorTargetIdentityForIndex(
  state: WalletStateV1,
  localIndex: number,
): AnchorIdentityTarget {
  const existingIdentity = state.identities.find((identity) =>
    identity.index === localIndex
    && identity.address !== null
  ) ?? null;

  const material = deriveWalletIdentityMaterial(state.keys.accountXprv, localIndex);

  return {
    ...material,
    localIndex,
    address: existingIdentity?.address ?? material.address,
    scriptPubKeyHex: existingIdentity?.scriptPubKeyHex ?? material.scriptPubKeyHex,
  };
}

function encodeFoundingMessage(
  foundingMessageText: string | null | undefined,
): Promise<{ text: string | null; payloadHex: string | null }> {
  const trimmed = foundingMessageText?.trim() ?? "";
  if (trimmed === "") {
    return Promise.resolve({
      text: null,
      payloadHex: null,
    });
  }

  return encodeSentence(trimmed)
    .then((payload) => ({
      text: trimmed,
      payloadHex: Buffer.from(payload).toString("hex"),
    }))
    .catch((error) => {
      throw new Error(error instanceof Error ? `wallet_anchor_invalid_message_${error.message}` : "wallet_anchor_invalid_message");
    });
}

function extractAnchorInvalidMessageReason(
  error: unknown,
): string | null {
  const message = error instanceof Error ? error.message : String(error);

  if (message === "wallet_anchor_invalid_message") {
    return null;
  }

  if (!message.startsWith("wallet_anchor_invalid_message_")) {
    return null;
  }

  const reason = message.slice("wallet_anchor_invalid_message_".length).trim();
  return reason === "" ? null : reason;
}

async function resolveFoundingMessage(
  options: {
    foundingMessageText: string | null | undefined;
    promptForFoundingMessageWhenMissing?: boolean;
    prompter: WalletPrompter;
  },
): Promise<{ text: string | null; payloadHex: string | null }> {
  if (!options.promptForFoundingMessageWhenMissing || options.foundingMessageText != null) {
    return encodeFoundingMessage(options.foundingMessageText ?? null);
  }

  for (;;) {
    const answer = await options.prompter.prompt("Founding message (optional, press Enter to skip): ");

    try {
      return await encodeFoundingMessage(answer);
    } catch (error) {
      const reason = extractAnchorInvalidMessageReason(error);

      options.prompter.writeLine("Founding message cannot be encoded in canonical Coglex.");
      if (reason !== null) {
        options.prompter.writeLine(`Reason: ${reason}`);
      }
    }
  }
}

function resolveAnchorOutpointForSender(
  state: WalletStateV1,
  senderIndex: number,
): OutpointRecord | null {
  const anchoredDomain = state.domains.find((domain) =>
    domain.currentOwnerLocalIndex === senderIndex
    && domain.canonicalChainStatus === "anchored"
    && domain.currentCanonicalAnchorOutpoint !== null
  ) ?? null;

  if (anchoredDomain?.currentCanonicalAnchorOutpoint === null || anchoredDomain === null) {
    return null;
  }

  return {
    txid: anchoredDomain.currentCanonicalAnchorOutpoint.txid,
    vout: anchoredDomain.currentCanonicalAnchorOutpoint.vout,
  };
}

function isFundingSender(state: WalletStateV1, sender: MutationSender): boolean {
  return sender.scriptPubKeyHex === state.funding.scriptPubKeyHex;
}

async function confirmAnchor(
  prompter: WalletPrompter,
  operation: AnchorOperation,
): Promise<void> {
  prompter.writeLine(`You are anchoring "${operation.chainDomain.name}" onto dedicated index ${operation.targetIdentity.localIndex}.`);
  prompter.writeLine("Anchoring is permanent chain state. This flow uses two transactions and is not rolled back automatically.");
  prompter.writeLine(`Dedicated BTC address: ${operation.targetIdentity.address}`);
  prompter.writeLine(`Dedicated Ethereum address: ${operation.targetIdentity.ethereumAddress}`);
  prompter.writeLine(`Dedicated Nostr npub: ${operation.targetIdentity.nostrNpub}`);

  if (operation.foundingMessageText !== null) {
    prompter.writeLine("The founding message bytes will be public in mempool and on-chain.");
    prompter.writeLine(`Founding message: ${operation.foundingMessageText}`);
  }

  if (operation.hadListing) {
    prompter.writeLine("Warning: Tx1 will cancel the current listing for this domain.");
    prompter.writeLine("That listing-cancel side effect is not rolled back automatically if Tx2 later fails.");
  }

  const answer = (await prompter.prompt("Type the domain name to continue: ")).trim();

  if (answer !== operation.chainDomain.name) {
    throw new Error("wallet_anchor_confirmation_rejected");
  }
}

async function confirmAnchorClear(options: {
  prompter: WalletPrompter;
  domainName: string;
  releasedDedicatedIndices: number[];
  clearedReservedFamilies: number;
  canceledActiveFamilies: number;
  forced?: boolean;
  assumeYes?: boolean;
}): Promise<void> {
  const releasedIndexText = options.releasedDedicatedIndices.length === 0
    ? null
    : options.releasedDedicatedIndices.length === 1
      ? `release dedicated index ${options.releasedDedicatedIndices[0]} for reuse`
      : `release dedicated indices ${options.releasedDedicatedIndices.join(", ")} for reuse`;
  const actionParts: string[] = [];

  if (options.clearedReservedFamilies > 0) {
    actionParts.push(
      options.clearedReservedFamilies === 1
        ? "cancel 1 local pending anchor reservation"
        : `cancel ${options.clearedReservedFamilies} local pending anchor reservations`,
    );
  }
  if (options.canceledActiveFamilies > 0) {
    actionParts.push(
      options.canceledActiveFamilies === 1
        ? "cancel 1 same-domain active anchor family"
        : `cancel ${options.canceledActiveFamilies} same-domain active anchor families`,
    );
  }

  const releaseLine = releasedIndexText === null
    ? `This will ${actionParts.join(" and ")}.`
    : `This will ${actionParts.join(" and ")} and ${releasedIndexText}.`;
  if (options.forced === true && options.canceledActiveFamilies > 0) {
    options.prompter.writeLine("This clears local anchor workflow state only and does not undo chain state.");
  }
  await confirmYesNo(options.prompter, releaseLine, {
    assumeYes: options.assumeYes ?? false,
    errorCode: "wallet_anchor_clear_confirmation_rejected",
    requiresTtyErrorCode: "wallet_anchor_clear_requires_tty",
    prompt: `Clear pending anchor for "${options.domainName}"? [y/N]: `,
  });
}

function resolveAnchorOperation(
  context: WalletReadContext,
  domainName: string,
  foundingMessageText: string | null,
  foundingMessagePayloadHex: string | null,
): AnchorOperation {
  assertWalletMutationContextReady(context, "wallet_anchor");
  const chainDomain = lookupDomain(context.snapshot.state, domainName);

  if (chainDomain === null) {
    throw new Error("wallet_anchor_domain_not_found");
  }

  if (chainDomain.anchored) {
    throw new Error("wallet_anchor_domain_already_anchored");
  }

  const ownerHex = Buffer.from(chainDomain.ownerScriptPubKey).toString("hex");
  const senderIdentity = context.model.identities.find((identity) => identity.scriptPubKeyHex === ownerHex) ?? null;

  if (senderIdentity === null || senderIdentity.address === null) {
    throw new Error("wallet_anchor_owner_not_locally_controlled");
  }

  if (senderIdentity.readOnly) {
    throw new Error("wallet_anchor_owner_read_only");
  }

  const sourceAnchorOutpoint = isFundingSender(context.localState.state, {
    localIndex: senderIdentity.index,
    scriptPubKeyHex: senderIdentity.scriptPubKeyHex,
    address: senderIdentity.address,
  })
    ? null
    : resolveAnchorOutpointForSender(context.localState.state, senderIdentity.index);

  if (sourceAnchorOutpoint === null
    && senderIdentity.scriptPubKeyHex !== context.localState.state.funding.scriptPubKeyHex) {
    throw new Error("wallet_anchor_owner_identity_not_supported");
  }

  const targetIdentity = selectNextDedicatedIdentityTarget(context.localState.state);

  return {
    readContext: context,
    state: context.localState.state,
    unlockUntilUnixMs: context.localState.unlockUntilUnixMs,
    sourceSender: {
      localIndex: senderIdentity.index,
      scriptPubKeyHex: senderIdentity.scriptPubKeyHex,
      address: senderIdentity.address,
    },
    sourceAnchorOutpoint,
    chainDomain,
    targetIdentity,
    foundingMessageText,
    foundingMessagePayloadHex,
    hadListing: getListing(context.snapshot.state, chainDomain.domainId) !== null,
  };
}

function releaseClearedAnchorReservationState(options: {
  state: WalletStateV1;
  familyId: string;
  domainName: string;
  nowUnixMs: number;
}): WalletStateV1 {
  const family = findAnchorFamilyById(options.state, options.familyId);
  const domains: DomainRecord[] = options.state.domains.map((domain) => {
    if (domain.name !== options.domainName) {
      return domain;
    }

    return {
      ...domain,
      dedicatedIndex: null,
      localAnchorIntent: "none",
    };
  });

  const nextState = {
    ...options.state,
    domains,
  };

  if (family === null) {
    return nextState;
  }

  return upsertProactiveFamily(nextState, {
    ...family,
    status: "canceled",
    lastUpdatedAtUnixMs: options.nowUnixMs,
    tx1: family.tx1 == null ? family.tx1 : {
      ...family.tx1,
      status: "canceled",
      temporaryBuilderLockedOutpoints: [],
    },
    tx2: family.tx2 == null ? family.tx2 : {
      ...family.tx2,
      status: "canceled",
      temporaryBuilderLockedOutpoints: [],
    },
  });
}

function cancelAnchorFamilyRecord(
  family: ProactiveFamilyStateRecord,
  nowUnixMs: number,
): ProactiveFamilyStateRecord {
  return {
    ...family,
    status: "canceled",
    lastUpdatedAtUnixMs: nowUnixMs,
    tx1: family.tx1 == null ? family.tx1 : {
      ...family.tx1,
      status: "canceled",
      temporaryBuilderLockedOutpoints: [],
    },
    tx2: family.tx2 == null ? family.tx2 : {
      ...family.tx2,
      status: "canceled",
      temporaryBuilderLockedOutpoints: [],
    },
  };
}

function alignAssignedDomainToOwnerIndex(options: {
  identities: LocalIdentityRecord[];
  domainName: string;
  ownerLocalIndex: number | null;
}): LocalIdentityRecord[] {
  return options.identities.map((identity) => {
    let assigned = identity.assignedDomainNames.filter((name) => name !== options.domainName);
    if (options.ownerLocalIndex !== null && identity.index === options.ownerLocalIndex) {
      assigned = [...assigned, options.domainName];
    }
    return {
      ...identity,
      assignedDomainNames: assigned.sort((left, right) => left.localeCompare(right)),
    };
  });
}

function recomputeDomainAfterAnchorClear(options: {
  state: WalletStateV1;
  snapshot: NonNullable<WalletReadContext["snapshot"]>;
  domainName: string;
}): WalletStateV1 {
  const domain = options.state.domains.find((entry) => entry.name === options.domainName) ?? null;
  if (domain === null) {
    return options.state;
  }

  const chainDomain = lookupDomain(options.snapshot.state, options.domainName);
  const ownerScriptPubKeyHex = chainDomain === null
    ? domain.currentOwnerScriptPubKeyHex
    : Buffer.from(chainDomain.ownerScriptPubKey).toString("hex");
  const ownerIdentity = ownerScriptPubKeyHex === null
    ? null
    : options.state.identities.find((identity) => identity.scriptPubKeyHex === ownerScriptPubKeyHex) ?? null;
  const ownerLocalIndex = ownerIdentity?.index ?? (chainDomain === null ? domain.currentOwnerLocalIndex : null);
  const dedicatedIndex = ownerIdentity?.status === "dedicated" ? ownerIdentity.index : null;
  const canonicalChainStatus = chainDomain === null
    ? domain.canonicalChainStatus
    : chainDomain.anchored ? "anchored" : "registered-unanchored";
  const currentCanonicalAnchorOutpoint = canonicalChainStatus === "anchored"
    ? domain.currentCanonicalAnchorOutpoint
    : null;

  return {
    ...options.state,
    identities: alignAssignedDomainToOwnerIndex({
      identities: options.state.identities,
      domainName: options.domainName,
      ownerLocalIndex,
    }),
    domains: options.state.domains.map((entry) =>
      entry.name !== options.domainName
        ? entry
        : {
          ...entry,
          dedicatedIndex,
          currentOwnerScriptPubKeyHex: ownerScriptPubKeyHex,
          currentOwnerLocalIndex: ownerLocalIndex,
          canonicalChainStatus,
          localAnchorIntent: "none",
          currentCanonicalAnchorOutpoint,
        }
    ),
  };
}

function summarizeAnchorClearFamilies(options: {
  state: WalletStateV1;
  domainName: string;
}) {
  const families = findAnchorFamiliesByDomain(options.state, options.domainName);
  const clearableReserved = families.filter(isClearableReservedAnchorFamilyRecord);
  const activeNonReserved = families.filter((family) =>
    ACTIVE_FAMILY_STATUSES.has(family.status) && !isClearableReservedAnchorFamilyRecord(family)
  );
  const terminal = families.filter((family) => !ACTIVE_FAMILY_STATUSES.has(family.status));
  return {
    families,
    clearableReserved,
    activeNonReserved,
    terminal,
  };
}

function createFamilyTransactionRecord(): ProactiveFamilyTransactionRecord {
  return {
    status: "draft",
    attemptedTxid: null,
    attemptedWtxid: null,
    temporaryBuilderLockedOutpoints: [],
    rawHex: null,
  };
}

function createDraftAnchorFamily(operation: AnchorOperation, nowUnixMs: number): ProactiveFamilyStateRecord {
  return {
    familyId: randomBytes(12).toString("hex"),
    type: "anchor",
    status: "draft",
    intentFingerprintHex: createIntentFingerprint([
      "anchor",
      operation.state.walletRootId,
      operation.chainDomain.name,
      operation.sourceSender.scriptPubKeyHex,
      operation.foundingMessagePayloadHex ?? "",
    ]),
    createdAtUnixMs: nowUnixMs,
    lastUpdatedAtUnixMs: nowUnixMs,
    domainName: operation.chainDomain.name,
    domainId: operation.chainDomain.domainId,
    sourceSenderLocalIndex: operation.sourceSender.localIndex,
    sourceSenderScriptPubKeyHex: operation.sourceSender.scriptPubKeyHex,
    reservedDedicatedIndex: operation.targetIdentity.localIndex,
    reservedScriptPubKeyHex: operation.targetIdentity.scriptPubKeyHex,
    foundingMessageText: operation.foundingMessageText,
    foundingMessagePayloadHex: operation.foundingMessagePayloadHex,
    listingCancelCommitted: false,
    currentStep: "reserved",
    tx1: createFamilyTransactionRecord(),
    tx2: createFamilyTransactionRecord(),
  };
}

function ensureReservedIdentity(
  identities: LocalIdentityRecord[],
  target: AnchorIdentityTarget,
): LocalIdentityRecord[] {
  if (identities.some((identity) => identity.index === target.localIndex)) {
    return identities;
  }

  return [...identities, createReservedIdentityRecord(target)]
    .sort((left, right) => left.index - right.index);
}

function reserveAnchorFamilyState(
  state: WalletStateV1,
  family: ProactiveFamilyStateRecord,
  target: AnchorIdentityTarget,
  foundingMessageText: string | null,
): WalletStateV1 {
  const domains: DomainRecord[] = state.domains.map((domain) => {
    if (domain.name !== family.domainName) {
      return domain;
    }

    return {
      ...domain,
      dedicatedIndex: target.localIndex,
      localAnchorIntent: "reserved",
      foundingMessageText: foundingMessageText ?? domain.foundingMessageText,
    };
  });

  return {
    ...upsertProactiveFamily(state, family),
    nextDedicatedIndex: Math.max(state.nextDedicatedIndex, target.localIndex + 1),
    identities: ensureReservedIdentity(state.identities, target),
    domains,
  };
}

function updateAnchorFamilyState(options: {
  state: WalletStateV1;
  family: ProactiveFamilyStateRecord;
  target: AnchorIdentityTarget;
  status: ProactiveFamilyStateRecord["status"];
  localAnchorIntent: DomainRecord["localAnchorIntent"];
  currentStep: ProactiveFamilyStateRecord["currentStep"];
  tx1?: ProactiveFamilyTransactionRecord | null;
  tx2?: ProactiveFamilyTransactionRecord | null;
  nowUnixMs: number;
  listingCancelCommitted?: boolean;
  moveOwnershipToTarget?: boolean;
  canonicalChainStatus?: DomainRecord["canonicalChainStatus"];
  currentCanonicalAnchorOutpoint?: DomainRecord["currentCanonicalAnchorOutpoint"];
}): WalletStateV1 {
  const nextFamily: ProactiveFamilyStateRecord = {
    ...options.family,
    status: options.status,
    currentStep: options.currentStep,
    lastUpdatedAtUnixMs: options.nowUnixMs,
    listingCancelCommitted: options.listingCancelCommitted ?? options.family.listingCancelCommitted,
    tx1: options.tx1 ?? options.family.tx1 ?? createFamilyTransactionRecord(),
    tx2: options.tx2 ?? options.family.tx2 ?? createFamilyTransactionRecord(),
  };

  let identities = ensureReservedIdentity(options.state.identities, options.target);
  if (options.moveOwnershipToTarget) {
    identities = withUpdatedAssignedDomain({
      identities,
      sourceLocalIndex: options.family.sourceSenderLocalIndex ?? null,
      targetLocalIndex: options.target.localIndex,
      domainName: options.family.domainName ?? "",
    });
  }

  const domains = options.state.domains.map((domain) => {
    if (domain.name !== options.family.domainName) {
      return domain;
    }

    return {
      ...domain,
      dedicatedIndex: options.target.localIndex,
      currentOwnerScriptPubKeyHex: options.moveOwnershipToTarget
        ? options.target.scriptPubKeyHex
        : domain.currentOwnerScriptPubKeyHex,
      currentOwnerLocalIndex: options.moveOwnershipToTarget
        ? options.target.localIndex
        : domain.currentOwnerLocalIndex,
      localAnchorIntent: options.localAnchorIntent,
      canonicalChainStatus: options.canonicalChainStatus ?? domain.canonicalChainStatus,
      currentCanonicalAnchorOutpoint: options.currentCanonicalAnchorOutpoint ?? domain.currentCanonicalAnchorOutpoint,
      foundingMessageText: options.family.foundingMessageText ?? domain.foundingMessageText,
    };
  });

  return {
    ...upsertProactiveFamily(options.state, nextFamily),
    identities,
    domains,
  };
}

function buildTx1Plan(options: {
  state: WalletStateV1;
  allUtxos: RpcListUnspentEntry[];
  operation: AnchorOperation;
}): AnchorTxPlan {
  const fundingUtxos = sortUtxos(options.allUtxos.filter((entry) =>
    entry.scriptPubKey === options.state.funding.scriptPubKeyHex
    && isSpendableConfirmedUtxo(entry)
  ));

  const outputs: unknown[] = [
    { data: Buffer.from(serializeDomainTransfer(options.operation.chainDomain.domainId, Buffer.from(options.operation.targetIdentity.scriptPubKeyHex, "hex")).opReturnData).toString("hex") },
    { [options.operation.targetIdentity.address]: satsToBtcNumber(BigInt(options.state.anchorValueSats)) },
  ];

  if (options.operation.sourceAnchorOutpoint === null) {
    return {
      sender: options.operation.sourceSender,
      changeAddress: options.state.funding.address,
      fixedInputs: [],
      outputs,
      changePosition: 2,
      expectedOpReturnScriptHex: encodeOpReturnScript(
        serializeDomainTransfer(options.operation.chainDomain.domainId, Buffer.from(options.operation.targetIdentity.scriptPubKeyHex, "hex")).opReturnData,
      ),
      expectedProvisionalAnchorScriptHex: options.operation.targetIdentity.scriptPubKeyHex,
      expectedProvisionalAnchorValueSats: BigInt(options.state.anchorValueSats),
      expectedReplacementAnchorScriptHex: null,
      expectedReplacementAnchorValueSats: null,
      allowedFundingScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
      eligibleFundingOutpointKeys: new Set(fundingUtxos.map((entry) => outpointKey({ txid: entry.txid, vout: entry.vout }))),
      requiredSenderOutpoint: null,
      requiredProvisionalOutpoint: null,
      errorPrefix: "wallet_anchor_tx1",
    };
  }

  const sourceAnchor = options.allUtxos.find((entry) =>
    entry.txid === options.operation.sourceAnchorOutpoint?.txid
    && entry.vout === options.operation.sourceAnchorOutpoint.vout
    && entry.scriptPubKey === options.operation.sourceSender.scriptPubKeyHex
    && isSpendableConfirmedUtxo(entry)
  );

  if (sourceAnchor === undefined) {
    throw new Error("wallet_anchor_source_anchor_missing");
  }

  outputs.push({
    [options.operation.sourceSender.address]: satsToBtcNumber(BigInt(options.state.anchorValueSats)),
  });

  return {
    sender: options.operation.sourceSender,
    changeAddress: options.state.funding.address,
    fixedInputs: [{ txid: sourceAnchor.txid, vout: sourceAnchor.vout }],
    outputs,
    changePosition: 3,
    expectedOpReturnScriptHex: encodeOpReturnScript(
      serializeDomainTransfer(options.operation.chainDomain.domainId, Buffer.from(options.operation.targetIdentity.scriptPubKeyHex, "hex")).opReturnData,
    ),
    expectedProvisionalAnchorScriptHex: options.operation.targetIdentity.scriptPubKeyHex,
    expectedProvisionalAnchorValueSats: BigInt(options.state.anchorValueSats),
    expectedReplacementAnchorScriptHex: options.operation.sourceSender.scriptPubKeyHex,
    expectedReplacementAnchorValueSats: BigInt(options.state.anchorValueSats),
    allowedFundingScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
    eligibleFundingOutpointKeys: new Set(fundingUtxos.map((entry) => outpointKey({ txid: entry.txid, vout: entry.vout }))),
    requiredSenderOutpoint: options.operation.sourceAnchorOutpoint,
    requiredProvisionalOutpoint: null,
    errorPrefix: "wallet_anchor_tx1",
  };
}

function buildTx2Plan(options: {
  state: WalletStateV1;
  allUtxos: RpcListUnspentEntry[];
  operation: AnchorOperation;
  family: ProactiveFamilyStateRecord;
}): AnchorTxPlan {
  const tx1Txid = options.family.tx1?.attemptedTxid;
  if (tx1Txid === null || tx1Txid === undefined) {
    throw new Error("wallet_anchor_tx1_missing");
  }

  const provisional = options.allUtxos.find((entry) =>
    entry.txid === tx1Txid
    && entry.vout === 1
    && entry.scriptPubKey === options.operation.targetIdentity.scriptPubKeyHex
    && entry.spendable !== false
    && entry.safe !== false
  );

  if (provisional === undefined) {
    throw new Error("wallet_anchor_provisional_anchor_missing");
  }

  const fundingUtxos = sortUtxos(options.allUtxos.filter((entry) =>
    entry.scriptPubKey === options.state.funding.scriptPubKeyHex
    && isSpendableConfirmedUtxo(entry)
  ));
  const tx1FundingChangeInputs = findSpendableFundingInputsFromTransaction({
    allUtxos: options.allUtxos,
    txid: tx1Txid,
    fundingScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
    minConf: 0,
  });
  const foundingPayload = options.operation.foundingMessagePayloadHex === null
    ? undefined
    : Buffer.from(options.operation.foundingMessagePayloadHex, "hex");
  const opReturnData = serializeDomainAnchor(options.operation.chainDomain.domainId, foundingPayload).opReturnData;

  return {
    sender: {
      localIndex: options.operation.targetIdentity.localIndex,
      scriptPubKeyHex: options.operation.targetIdentity.scriptPubKeyHex,
      address: options.operation.targetIdentity.address,
    },
    changeAddress: options.state.funding.address,
    fixedInputs: [
      { txid: provisional.txid, vout: provisional.vout },
      ...tx1FundingChangeInputs,
    ],
    outputs: [
      { data: Buffer.from(opReturnData).toString("hex") },
      { [options.operation.targetIdentity.address]: satsToBtcNumber(BigInt(options.state.anchorValueSats)) },
    ],
    changePosition: 2,
    expectedOpReturnScriptHex: encodeOpReturnScript(opReturnData),
    expectedProvisionalAnchorScriptHex: options.operation.targetIdentity.scriptPubKeyHex,
    expectedProvisionalAnchorValueSats: BigInt(options.state.anchorValueSats),
    expectedReplacementAnchorScriptHex: null,
    expectedReplacementAnchorValueSats: null,
    allowedFundingScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
    eligibleFundingOutpointKeys: new Set(fundingUtxos.map((entry) => outpointKey({ txid: entry.txid, vout: entry.vout }))),
    requiredSenderOutpoint: null,
    requiredProvisionalOutpoint: {
      txid: provisional.txid,
      vout: provisional.vout,
    },
    errorPrefix: "wallet_anchor_tx2",
  };
}

function validateTx1Draft(
  decoded: RpcDecodedPsbt,
  funded: BuiltAnchorTransaction["funded"],
  plan: AnchorTxPlan,
): void {
  const inputs = decoded.tx.vin;
  const outputs = decoded.tx.vout;

  if (inputs.length === 0) {
    throw new Error(`${plan.errorPrefix}_sender_input_mismatch`);
  }

  assertFixedInputPrefixMatches(inputs, plan.fixedInputs, `${plan.errorPrefix}_sender_input_mismatch`);

  const firstInputScriptPubKeyHex = getDecodedInputScriptPubKeyHex(decoded, 0);
  if (firstInputScriptPubKeyHex !== plan.sender.scriptPubKeyHex) {
    throw new Error(`${plan.errorPrefix}_sender_input_mismatch`);
  }

  if (plan.requiredSenderOutpoint !== null) {
    if (!inputMatchesOutpoint(inputs[0]!, plan.requiredSenderOutpoint)) {
      throw new Error(`${plan.errorPrefix}_sender_input_mismatch`);
    }
  }

  assertFundingInputsAfterFixedPrefix({
    decoded,
    fixedInputs: plan.fixedInputs,
    allowedFundingScriptPubKeyHex: plan.allowedFundingScriptPubKeyHex,
    eligibleFundingOutpointKeys: plan.eligibleFundingOutpointKeys,
    errorCode: `${plan.errorPrefix}_unexpected_funding_input`,
  });

  if (outputs[0]?.scriptPubKey?.hex !== plan.expectedOpReturnScriptHex) {
    throw new Error(`${plan.errorPrefix}_opreturn_mismatch`);
  }

  if (outputs[1]?.scriptPubKey?.hex !== plan.expectedProvisionalAnchorScriptHex) {
    throw new Error(`${plan.errorPrefix}_provisional_anchor_output_mismatch`);
  }

  if (valueToSats(outputs[1]?.value ?? 0) !== plan.expectedProvisionalAnchorValueSats) {
    throw new Error(`${plan.errorPrefix}_provisional_anchor_value_mismatch`);
  }

  const expectedWithoutChange = plan.expectedReplacementAnchorScriptHex === null ? 2 : 3;
  if (plan.expectedReplacementAnchorScriptHex !== null) {
    if (outputs[2]?.scriptPubKey?.hex !== plan.expectedReplacementAnchorScriptHex) {
      throw new Error(`${plan.errorPrefix}_replacement_anchor_output_mismatch`);
    }

    if (valueToSats(outputs[2]?.value ?? 0) !== (plan.expectedReplacementAnchorValueSats ?? 0n)) {
      throw new Error(`${plan.errorPrefix}_replacement_anchor_value_mismatch`);
    }
  }

  if (funded.changepos === -1) {
    if (outputs.length !== expectedWithoutChange) {
      throw new Error(`${plan.errorPrefix}_unexpected_output_count`);
    }
    return;
  }

  if (funded.changepos !== plan.changePosition || outputs.length !== expectedWithoutChange + 1) {
    throw new Error(`${plan.errorPrefix}_change_position_mismatch`);
  }

  if (outputs[funded.changepos]?.scriptPubKey?.hex !== plan.allowedFundingScriptPubKeyHex) {
    throw new Error(`${plan.errorPrefix}_change_output_mismatch`);
  }
}

function validateTx2Draft(
  decoded: RpcDecodedPsbt,
  funded: BuiltAnchorTransaction["funded"],
  plan: AnchorTxPlan,
): void {
  const inputs = decoded.tx.vin;
  const outputs = decoded.tx.vout;

  if (inputs.length === 0 || plan.requiredProvisionalOutpoint === null) {
    throw new Error(`${plan.errorPrefix}_provisional_input_mismatch`);
  }

  assertFixedInputPrefixMatches(inputs, plan.fixedInputs, `${plan.errorPrefix}_provisional_input_mismatch`);

  const firstInputScriptPubKeyHex = getDecodedInputScriptPubKeyHex(decoded, 0);
  if (firstInputScriptPubKeyHex !== plan.sender.scriptPubKeyHex
    || !inputMatchesOutpoint(inputs[0]!, plan.requiredProvisionalOutpoint)) {
    throw new Error(`${plan.errorPrefix}_provisional_input_mismatch`);
  }

  assertFundingInputsAfterFixedPrefix({
    decoded,
    fixedInputs: plan.fixedInputs,
    allowedFundingScriptPubKeyHex: plan.allowedFundingScriptPubKeyHex,
    eligibleFundingOutpointKeys: plan.eligibleFundingOutpointKeys,
    errorCode: `${plan.errorPrefix}_unexpected_funding_input`,
  });

  if (outputs[0]?.scriptPubKey?.hex !== plan.expectedOpReturnScriptHex) {
    throw new Error(`${plan.errorPrefix}_opreturn_mismatch`);
  }

  if (outputs[1]?.scriptPubKey?.hex !== plan.expectedProvisionalAnchorScriptHex) {
    throw new Error(`${plan.errorPrefix}_canonical_anchor_output_mismatch`);
  }

  if (valueToSats(outputs[1]?.value ?? 0) !== plan.expectedProvisionalAnchorValueSats) {
    throw new Error(`${plan.errorPrefix}_canonical_anchor_value_mismatch`);
  }

  const expectedWithoutChange = 2;
  if (funded.changepos === -1) {
    if (outputs.length !== expectedWithoutChange) {
      throw new Error(`${plan.errorPrefix}_unexpected_output_count`);
    }
    return;
  }

  if (funded.changepos !== plan.changePosition || outputs.length !== expectedWithoutChange + 1) {
    throw new Error(`${plan.errorPrefix}_change_position_mismatch`);
  }

  if (outputs[funded.changepos]?.scriptPubKey?.hex !== plan.allowedFundingScriptPubKeyHex) {
    throw new Error(`${plan.errorPrefix}_change_output_mismatch`);
  }
}

async function buildTx1(options: {
  rpc: WalletAnchorRpcClient;
  walletName: string;
  state: WalletStateV1;
  plan: AnchorTxPlan;
}): Promise<BuiltAnchorTransaction> {
  return buildWalletMutationTransactionWithReserveFallback({
    rpc: options.rpc,
    walletName: options.walletName,
    state: options.state,
    plan: options.plan,
    validateFundedDraft: validateTx1Draft,
    finalizeErrorCode: "wallet_anchor_tx1_finalize_failed",
    mempoolRejectPrefix: "wallet_anchor_tx1_mempool_rejected",
    reserveCandidates: options.state.proactiveReserveOutpoints,
  });
}

async function buildTx2(options: {
  rpc: WalletAnchorRpcClient;
  walletName: string;
  state: WalletStateV1;
  plan: AnchorTxPlan;
}): Promise<BuiltAnchorTransaction> {
  return buildWalletMutationTransactionWithReserveFallback({
    rpc: options.rpc,
    walletName: options.walletName,
    state: options.state,
    plan: options.plan,
    validateFundedDraft: validateTx2Draft,
    finalizeErrorCode: "wallet_anchor_tx2_finalize_failed",
    mempoolRejectPrefix: "wallet_anchor_tx2_mempool_rejected",
    availableFundingMinConf: 0,
    reserveCandidates: options.state.proactiveReserveOutpoints,
  });
}

async function relockAnchorOutpoint(
  rpc: WalletAnchorRpcClient,
  walletName: string,
  outpoint: OutpointRecord | null,
): Promise<void> {
  if (outpoint === null || rpc.lockUnspent === undefined) {
    return;
  }

  await rpc.lockUnspent(walletName, false, [outpoint]).catch(() => undefined);
}

function resolveAcceptedFamilyStatus(options: {
  snapshot: WalletReadContext["snapshot"];
  family: ProactiveFamilyStateRecord;
  target: AnchorIdentityTarget;
}): "live" | "confirmed" {
  const chainDomain = options.snapshot === null || options.family.domainName == null
    ? null
    : lookupDomain(options.snapshot.state, options.family.domainName);

  if (chainDomain === null) {
    return "live";
  }

  const ownerHex = Buffer.from(chainDomain.ownerScriptPubKey).toString("hex");
  return chainDomain.anchored && ownerHex === options.target.scriptPubKeyHex
    ? "confirmed"
    : "live";
}

async function reconcileAnchorFamily(options: {
  state: WalletStateV1;
  family: ProactiveFamilyStateRecord;
  operation: AnchorOperation;
  provider: WalletSecretProvider;
  nowUnixMs: number;
  paths: WalletRuntimePaths;
  unlockUntilUnixMs: number;
  rpc: WalletAnchorRpcClient;
  walletName: string;
}): Promise<{
  state: WalletStateV1;
  family: ProactiveFamilyStateRecord;
  resolution: "confirmed" | "live" | "repair-required" | "not-seen" | "continue" | "ready-for-tx2";
}> {
  const chainDomain = lookupDomain(options.operation.readContext.snapshot.state, options.operation.chainDomain.name);
  const targetScript = options.operation.targetIdentity.scriptPubKeyHex;

  if (chainDomain !== null) {
    const ownerHex = Buffer.from(chainDomain.ownerScriptPubKey).toString("hex");
    if (chainDomain.anchored && ownerHex === targetScript) {
      const nextState = updateAnchorFamilyState({
        state: options.state,
        family: options.family,
        target: options.operation.targetIdentity,
        status: "confirmed",
        localAnchorIntent: "none",
        currentStep: "tx2",
        nowUnixMs: options.nowUnixMs,
        tx1: options.family.tx1 == null ? undefined : { ...options.family.tx1, status: "confirmed", temporaryBuilderLockedOutpoints: [] },
        tx2: options.family.tx2 == null ? undefined : { ...options.family.tx2, status: "confirmed", temporaryBuilderLockedOutpoints: [] },
        moveOwnershipToTarget: true,
        canonicalChainStatus: "anchored",
        currentCanonicalAnchorOutpoint: options.family.tx2?.attemptedTxid == null
          ? options.state.domains.find((domain) => domain.name === options.family.domainName)?.currentCanonicalAnchorOutpoint ?? null
          : {
            txid: options.family.tx2.attemptedTxid,
            vout: 1,
            valueSats: options.state.anchorValueSats,
          },
      });
      await saveWalletStatePreservingUnlock({
        state: {
          ...nextState,
          stateRevision: nextState.stateRevision + 1,
          lastWrittenAtUnixMs: options.nowUnixMs,
        },
        provider: options.provider,
        unlockUntilUnixMs: options.unlockUntilUnixMs,
        nowUnixMs: options.nowUnixMs,
        paths: options.paths,
      });

      return {
        state: nextState,
        family: findAnchorFamilyById(nextState, options.family.familyId) ?? {
          ...options.family,
          status: "confirmed",
        },
        resolution: "confirmed",
      };
    }

    if (ownerHex === targetScript && !chainDomain.anchored) {
      const nextState = updateAnchorFamilyState({
        state: options.state,
        family: options.family,
        target: options.operation.targetIdentity,
        status: "repair-required",
        localAnchorIntent: "repair-required",
        currentStep: "tx2",
        nowUnixMs: options.nowUnixMs,
        listingCancelCommitted: true,
        moveOwnershipToTarget: true,
      });
      await saveWalletStatePreservingUnlock({
        state: {
          ...nextState,
          stateRevision: nextState.stateRevision + 1,
          lastWrittenAtUnixMs: options.nowUnixMs,
        },
        provider: options.provider,
        unlockUntilUnixMs: options.unlockUntilUnixMs,
        nowUnixMs: options.nowUnixMs,
        paths: options.paths,
      });

      return {
        state: nextState,
        family: findAnchorFamilyById(nextState, options.family.familyId) ?? {
          ...options.family,
          status: "repair-required",
        },
        resolution: "repair-required",
      };
    }
  }

  const mempool: string[] = await options.rpc.getRawMempool().catch(() => []);

  if (options.family.tx2?.attemptedTxid != null && mempool.includes(options.family.tx2.attemptedTxid)) {
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.family.tx2.temporaryBuilderLockedOutpoints);
    const nextState = updateAnchorFamilyState({
      state: options.state,
      family: options.family,
      target: options.operation.targetIdentity,
      status: "live",
      localAnchorIntent: "tx2-live",
      currentStep: "tx2",
      nowUnixMs: options.nowUnixMs,
      tx2: {
        ...options.family.tx2,
        status: "live",
        temporaryBuilderLockedOutpoints: [],
      },
      listingCancelCommitted: true,
      moveOwnershipToTarget: true,
      currentCanonicalAnchorOutpoint: {
        txid: options.family.tx2.attemptedTxid,
        vout: 1,
        valueSats: options.state.anchorValueSats,
      },
    });
    await relockAnchorOutpoint(options.rpc, options.walletName, {
      txid: options.family.tx2.attemptedTxid,
      vout: 1,
    });
    await saveWalletStatePreservingUnlock({
      state: {
        ...nextState,
        stateRevision: nextState.stateRevision + 1,
        lastWrittenAtUnixMs: options.nowUnixMs,
      },
      provider: options.provider,
      unlockUntilUnixMs: options.unlockUntilUnixMs,
      nowUnixMs: options.nowUnixMs,
      paths: options.paths,
    });

    return {
      state: nextState,
      family: findAnchorFamilyById(nextState, options.family.familyId) ?? {
        ...options.family,
        status: "live",
      },
      resolution: "live",
    };
  }

  if (options.family.tx1?.attemptedTxid != null && mempool.includes(options.family.tx1.attemptedTxid)) {
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.family.tx1.temporaryBuilderLockedOutpoints);
    const nextState = updateAnchorFamilyState({
      state: options.state,
      family: options.family,
      target: options.operation.targetIdentity,
      status: "live",
      localAnchorIntent: "tx1-live",
      currentStep: "tx1",
      nowUnixMs: options.nowUnixMs,
      tx1: {
        ...options.family.tx1,
        status: "live",
        temporaryBuilderLockedOutpoints: [],
      },
      listingCancelCommitted: options.operation.hadListing,
      moveOwnershipToTarget: true,
    });
    if (options.operation.sourceAnchorOutpoint !== null) {
      await relockAnchorOutpoint(options.rpc, options.walletName, {
        txid: options.family.tx1.attemptedTxid,
        vout: 2,
      });
    }
    await saveWalletStatePreservingUnlock({
      state: {
        ...nextState,
        stateRevision: nextState.stateRevision + 1,
        lastWrittenAtUnixMs: options.nowUnixMs,
      },
      provider: options.provider,
      unlockUntilUnixMs: options.unlockUntilUnixMs,
      nowUnixMs: options.nowUnixMs,
      paths: options.paths,
    });

    return {
      state: nextState,
      family: findAnchorFamilyById(nextState, options.family.familyId) ?? {
        ...options.family,
        status: "live",
      },
      resolution: "ready-for-tx2",
    };
  }

  if (options.family.currentStep === "tx2" || options.family.tx2?.attemptedTxid != null) {
    const nextState = updateAnchorFamilyState({
      state: options.state,
      family: options.family,
      target: options.operation.targetIdentity,
      status: "repair-required",
      localAnchorIntent: "repair-required",
      currentStep: "tx2",
      nowUnixMs: options.nowUnixMs,
      listingCancelCommitted: true,
      moveOwnershipToTarget: true,
    });
    await saveWalletStatePreservingUnlock({
      state: {
        ...nextState,
        stateRevision: nextState.stateRevision + 1,
        lastWrittenAtUnixMs: options.nowUnixMs,
      },
      provider: options.provider,
      unlockUntilUnixMs: options.unlockUntilUnixMs,
      nowUnixMs: options.nowUnixMs,
      paths: options.paths,
    });

    return {
      state: nextState,
      family: findAnchorFamilyById(nextState, options.family.familyId) ?? {
        ...options.family,
        status: "repair-required",
      },
      resolution: "repair-required",
    };
  }

  if (ACTIVE_FAMILY_STATUSES.has(options.family.status)) {
    const nextState = updateAnchorFamilyState({
      state: options.state,
      family: options.family,
      target: options.operation.targetIdentity,
      status: "canceled",
      localAnchorIntent: "none",
      currentStep: options.family.currentStep,
      nowUnixMs: options.nowUnixMs,
      tx1: options.family.tx1 == null ? undefined : {
        ...options.family.tx1,
        status: "canceled",
        temporaryBuilderLockedOutpoints: [],
      },
      tx2: options.family.tx2 == null ? undefined : {
        ...options.family.tx2,
        status: "canceled",
        temporaryBuilderLockedOutpoints: [],
      },
    });
    await saveWalletStatePreservingUnlock({
      state: {
        ...nextState,
        stateRevision: nextState.stateRevision + 1,
        lastWrittenAtUnixMs: options.nowUnixMs,
      },
      provider: options.provider,
      unlockUntilUnixMs: options.unlockUntilUnixMs,
      nowUnixMs: options.nowUnixMs,
      paths: options.paths,
    });

    return {
      state: nextState,
      family: findAnchorFamilyById(nextState, options.family.familyId) ?? {
        ...options.family,
        status: "canceled",
      },
      resolution: "not-seen",
    };
  }

  return {
    state: options.state,
    family: options.family,
    resolution: "continue",
  };
}

function createBroadcastingTxRecord(
  built: BuiltAnchorTransaction,
): ProactiveFamilyTransactionRecord {
  return {
    status: "broadcasting",
    attemptedTxid: built.txid,
    attemptedWtxid: built.wtxid,
    temporaryBuilderLockedOutpoints: built.temporaryBuilderLockedOutpoints,
    rawHex: built.rawHex,
  };
}

async function saveState(
  state: WalletStateV1,
  provider: WalletSecretProvider,
  unlockUntilUnixMs: number,
  nowUnixMs: number,
  paths: WalletRuntimePaths,
): Promise<WalletStateV1> {
  const nextState = {
    ...state,
    stateRevision: state.stateRevision + 1,
    lastWrittenAtUnixMs: nowUnixMs,
  };
  await saveWalletStatePreservingUnlock({
    state: nextState,
    provider,
    unlockUntilUnixMs,
    nowUnixMs,
    paths,
  });
  return nextState;
}

async function submitTx2(options: {
  state: WalletStateV1;
  family: ProactiveFamilyStateRecord;
  operation: AnchorOperation;
  readContext: AnchorOperation["readContext"];
  provider: WalletSecretProvider;
  rpc: WalletAnchorRpcClient;
  walletName: string;
  nowUnixMs: number;
  paths: WalletRuntimePaths;
  unlockUntilUnixMs: number;
}): Promise<AnchorDomainResult> {
  let nextState = options.state;
  let family = options.family;

  const tx2Plan = buildTx2Plan({
    state: nextState,
    allUtxos: await options.rpc.listUnspent(options.walletName, 0),
    operation: options.operation,
    family,
  });
  const builtTx2 = await buildTx2({
    rpc: options.rpc,
    walletName: options.walletName,
    state: nextState,
    plan: tx2Plan,
  });

  const broadcastingTx2: ProactiveFamilyTransactionRecord = createBroadcastingTxRecord(builtTx2);
  family = {
    ...family,
    status: "broadcasting",
    currentStep: "tx2",
    tx2: broadcastingTx2,
  };
  nextState = updateAnchorFamilyState({
    state: nextState,
    family,
    target: options.operation.targetIdentity,
    status: "broadcasting",
    localAnchorIntent: "tx1-live",
    currentStep: "tx2",
    nowUnixMs: options.nowUnixMs,
    tx2: broadcastingTx2,
    listingCancelCommitted: true,
    moveOwnershipToTarget: true,
  });
  nextState = await saveState(nextState, options.provider, options.unlockUntilUnixMs, options.nowUnixMs, options.paths);

  ensureSameTipHeight(options.readContext, (await options.rpc.getBlockchainInfo()).blocks, "wallet_anchor_tip_mismatch");

  try {
    await options.rpc.sendRawTransaction(builtTx2.rawHex);
  } catch (error) {
    if (!isAlreadyAcceptedError(error)) {
      if (isBroadcastUnknownError(error)) {
        family = {
          ...family,
          status: "broadcast-unknown",
          tx2: {
            ...broadcastingTx2,
            status: "broadcast-unknown",
          },
        };
        nextState = updateAnchorFamilyState({
          state: nextState,
          family,
          target: options.operation.targetIdentity,
          status: "broadcast-unknown",
          localAnchorIntent: "tx1-live",
          currentStep: "tx2",
          nowUnixMs: options.nowUnixMs,
          tx2: family.tx2!,
          listingCancelCommitted: true,
          moveOwnershipToTarget: true,
        });
        await saveState(nextState, options.provider, options.unlockUntilUnixMs, options.nowUnixMs, options.paths);
        throw new Error("wallet_anchor_tx2_broadcast_unknown");
      }

      await unlockTemporaryBuilderLocks(options.rpc, options.walletName, builtTx2.temporaryBuilderLockedOutpoints);
      family = {
        ...family,
        status: "repair-required",
        tx2: {
          ...broadcastingTx2,
          status: "repair-required",
          temporaryBuilderLockedOutpoints: [],
        },
      };
      nextState = updateAnchorFamilyState({
        state: nextState,
        family,
        target: options.operation.targetIdentity,
        status: "repair-required",
        localAnchorIntent: "repair-required",
        currentStep: "tx2",
        nowUnixMs: options.nowUnixMs,
        tx2: family.tx2!,
        listingCancelCommitted: true,
        moveOwnershipToTarget: true,
      });
      await saveState(nextState, options.provider, options.unlockUntilUnixMs, options.nowUnixMs, options.paths);
      throw error;
    }
  }

  await unlockTemporaryBuilderLocks(options.rpc, options.walletName, builtTx2.temporaryBuilderLockedOutpoints);
  const finalStatus = resolveAcceptedFamilyStatus({
    snapshot: options.readContext.snapshot,
    family,
    target: options.operation.targetIdentity,
  });
  family = {
    ...family,
    status: finalStatus,
    currentStep: "tx2",
    tx2: {
      ...broadcastingTx2,
      status: finalStatus,
      temporaryBuilderLockedOutpoints: [],
    },
  };
  nextState = updateAnchorFamilyState({
    state: nextState,
    family,
    target: options.operation.targetIdentity,
    status: finalStatus,
    localAnchorIntent: finalStatus === "confirmed" ? "none" : "tx2-live",
    currentStep: "tx2",
    nowUnixMs: options.nowUnixMs,
    tx2: family.tx2!,
    listingCancelCommitted: true,
    moveOwnershipToTarget: true,
    canonicalChainStatus: finalStatus === "confirmed" ? "anchored" : undefined,
    currentCanonicalAnchorOutpoint: {
      txid: builtTx2.txid,
      vout: 1,
      valueSats: nextState.anchorValueSats,
    },
  });
  nextState = await saveState(nextState, options.provider, options.unlockUntilUnixMs, options.nowUnixMs, options.paths);
  await relockAnchorOutpoint(options.rpc, options.walletName, {
    txid: builtTx2.txid,
    vout: 1,
  });

  return {
    domainName: options.operation.chainDomain.name,
    txid: builtTx2.txid,
    tx1Txid: family.tx1?.attemptedTxid ?? "unknown",
    tx2Txid: builtTx2.txid,
    dedicatedIndex: options.operation.targetIdentity.localIndex,
    status: finalStatus,
    reusedExisting: false,
    foundingMessageText: options.operation.foundingMessageText,
  };
}

function ensureSameTipHeight(context: WalletReadContext, bestHeight: number, errorCode: string): void {
  if (context.snapshot?.tip?.height !== bestHeight) {
    throw new Error(errorCode);
  }
}

interface DirectAnchorPlan {
  fixedInputs: FixedWalletInput[];
  outputs: unknown[];
  changeAddress: string;
  changePosition: number;
  expectedOpReturnScriptHex: string;
  expectedAnchorScriptHex: string;
  expectedAnchorValueSats: bigint;
  allowedFundingScriptPubKeyHex: string;
  eligibleFundingOutpointKeys: Set<string>;
}

function buildDirectAnchorPlan(options: {
  state: WalletStateV1;
  allUtxos: RpcListUnspentEntry[];
  domainId: number;
  foundingMessagePayloadHex: string | null;
}): DirectAnchorPlan {
  const fundingUtxos = sortUtxos(options.allUtxos.filter((entry) =>
    entry.scriptPubKey === options.state.funding.scriptPubKeyHex
    && isSpendableConfirmedUtxo(entry)
  ));
  const foundingPayload = options.foundingMessagePayloadHex === null
    ? undefined
    : Buffer.from(options.foundingMessagePayloadHex, "hex");
  const opReturnData = serializeDomainAnchor(options.domainId, foundingPayload).opReturnData;

  return {
    fixedInputs: [],
    outputs: [
      { data: Buffer.from(opReturnData).toString("hex") },
      { [options.state.funding.address]: satsToBtcNumber(BigInt(options.state.anchorValueSats)) },
    ],
    changeAddress: options.state.funding.address,
    changePosition: 2,
    expectedOpReturnScriptHex: encodeOpReturnScript(opReturnData),
    expectedAnchorScriptHex: options.state.funding.scriptPubKeyHex,
    expectedAnchorValueSats: BigInt(options.state.anchorValueSats),
    allowedFundingScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
    eligibleFundingOutpointKeys: new Set(fundingUtxos.map((entry) => outpointKey({ txid: entry.txid, vout: entry.vout }))),
  };
}

function validateDirectAnchorDraft(
  decoded: RpcDecodedPsbt,
  funded: BuiltWalletMutationTransaction["funded"],
  plan: DirectAnchorPlan,
): void {
  const outputs = decoded.tx.vout;

  if (outputs[0]?.scriptPubKey?.hex !== plan.expectedOpReturnScriptHex) {
    throw new Error("wallet_anchor_opreturn_mismatch");
  }

  if (outputs[1]?.scriptPubKey?.hex !== plan.expectedAnchorScriptHex) {
    throw new Error("wallet_anchor_anchor_output_mismatch");
  }

  if (valueToSats(outputs[1]?.value ?? 0) !== plan.expectedAnchorValueSats) {
    throw new Error("wallet_anchor_anchor_value_mismatch");
  }

  if (funded.changepos === -1) {
    if (outputs.length !== 2) {
      throw new Error("wallet_anchor_unexpected_output_count");
    }
    return;
  }

  if (funded.changepos !== plan.changePosition || outputs.length !== 3) {
    throw new Error("wallet_anchor_change_position_mismatch");
  }

  if (outputs[funded.changepos]?.scriptPubKey?.hex !== plan.allowedFundingScriptPubKeyHex) {
    throw new Error("wallet_anchor_change_output_mismatch");
  }
}

function createDraftAnchorMutation(options: {
  state: WalletStateV1;
  domainName: string;
  intentFingerprintHex: string;
  nowUnixMs: number;
  existing?: PendingMutationRecord | null;
}): PendingMutationRecord {
  const existing = options.existing ?? null;
  if (existing !== null) {
    return {
      ...existing,
      kind: "anchor",
      domainName: options.domainName,
      parentDomainName: null,
      senderScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
      senderLocalIndex: 0,
      intentFingerprintHex: options.intentFingerprintHex,
      status: "draft",
      lastUpdatedAtUnixMs: options.nowUnixMs,
      attemptedTxid: null,
      attemptedWtxid: null,
      temporaryBuilderLockedOutpoints: [],
    };
  }

  return {
    mutationId: randomBytes(12).toString("hex"),
    kind: "anchor",
    domainName: options.domainName,
    parentDomainName: null,
    senderScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
    senderLocalIndex: 0,
    intentFingerprintHex: options.intentFingerprintHex,
    status: "draft",
    createdAtUnixMs: options.nowUnixMs,
    lastUpdatedAtUnixMs: options.nowUnixMs,
    attemptedTxid: null,
    attemptedWtxid: null,
    temporaryBuilderLockedOutpoints: [],
  };
}

function upsertAnchoredDomainRecord(options: {
  state: WalletStateV1;
  domainName: string;
  domainId: number;
  txid: string;
  foundingMessageText: string | null;
}): WalletStateV1 {
  const domains = options.state.domains.slice();
  const existingIndex = domains.findIndex((entry) => entry.name === options.domainName);
  const current = existingIndex >= 0 ? domains[existingIndex]! : null;
  const nextRecord: DomainRecord = {
    name: options.domainName,
    domainId: options.domainId,
    dedicatedIndex: null,
    currentOwnerScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
    currentOwnerLocalIndex: 0,
    canonicalChainStatus: "anchored",
    localAnchorIntent: "none",
    currentCanonicalAnchorOutpoint: {
      txid: options.txid,
      vout: 1,
      valueSats: options.state.anchorValueSats,
    },
    foundingMessageText: options.foundingMessageText ?? current?.foundingMessageText ?? null,
    birthTime: current?.birthTime ?? options.state.lastWrittenAtUnixMs,
  };

  if (existingIndex >= 0) {
    domains[existingIndex] = nextRecord;
  } else {
    domains.push(nextRecord);
  }

  return {
    ...options.state,
    domains,
  };
}

function anchorConfirmedOnSnapshot(options: {
  snapshot: NonNullable<WalletReadContext["snapshot"]>;
  state: WalletStateV1;
  domainName: string;
}): boolean {
  const chainDomain = lookupDomain(options.snapshot.state, options.domainName);
  if (chainDomain === null || !chainDomain.anchored) {
    return false;
  }

  const ownerHex = Buffer.from(chainDomain.ownerScriptPubKey).toString("hex");
  return ownerHex === options.state.funding.scriptPubKeyHex
    || (options.state.localScriptPubKeyHexes ?? []).includes(ownerHex);
}

async function reconcilePendingAnchorMutation(options: {
  state: WalletStateV1;
  mutation: PendingMutationRecord;
  provider: WalletSecretProvider;
  unlockUntilUnixMs: number;
  nowUnixMs: number;
  paths: WalletRuntimePaths;
  rpc: WalletAnchorRpcClient;
  walletName: string;
  context: WalletReadContext;
  foundingMessageText: string | null;
}): Promise<{
  state: WalletStateV1;
  mutation: PendingMutationRecord;
  resolution: "confirmed" | "live" | "repair-required" | "not-seen" | "continue";
}> {
  if (options.mutation.status === "repair-required") {
    return {
      state: options.state,
      mutation: options.mutation,
      resolution: "repair-required",
    };
  }

  if (options.context.snapshot !== null && anchorConfirmedOnSnapshot({
    snapshot: options.context.snapshot,
    state: options.state,
    domainName: options.mutation.domainName,
  })) {
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
    const confirmedMutation = updateMutationRecord(options.mutation, "confirmed", options.nowUnixMs, {
      temporaryBuilderLockedOutpoints: [],
    });
    const chainDomain = lookupDomain(options.context.snapshot.state, options.mutation.domainName);
    const nextState = upsertAnchoredDomainRecord({
      state: upsertPendingMutation(options.state, confirmedMutation),
      domainName: options.mutation.domainName,
      domainId: chainDomain?.domainId ?? 0,
      txid: options.mutation.attemptedTxid ?? "unknown",
      foundingMessageText: options.foundingMessageText,
    });
    await saveState(nextState, options.provider, options.unlockUntilUnixMs, options.nowUnixMs, options.paths);
    return {
      state: nextState,
      mutation: confirmedMutation,
      resolution: "confirmed",
    };
  }

  if (options.mutation.attemptedTxid !== null) {
    const mempool: string[] = await options.rpc.getRawMempool().catch(() => []);
    if (mempool.includes(options.mutation.attemptedTxid)) {
      await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
      const liveMutation = updateMutationRecord(options.mutation, "live", options.nowUnixMs, {
        temporaryBuilderLockedOutpoints: [],
      });
      const domainId = (options.context.snapshot === null
        ? null
        : lookupDomain(options.context.snapshot.state, options.mutation.domainName)?.domainId)
        ?? options.state.domains.find((domain) => domain.name === options.mutation.domainName)?.domainId
        ?? 0;
      const nextState = upsertAnchoredDomainRecord({
        state: upsertPendingMutation(options.state, liveMutation),
        domainName: options.mutation.domainName,
        domainId,
        txid: options.mutation.attemptedTxid,
        foundingMessageText: options.foundingMessageText,
      });
      await saveState(nextState, options.provider, options.unlockUntilUnixMs, options.nowUnixMs, options.paths);
      return {
        state: nextState,
        mutation: liveMutation,
        resolution: "live",
      };
    }
  }

  if (
    options.mutation.status === "broadcast-unknown"
    || options.mutation.status === "live"
    || options.mutation.status === "draft"
    || options.mutation.status === "broadcasting"
  ) {
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
    const canceledMutation = updateMutationRecord(options.mutation, "canceled", options.nowUnixMs, {
      temporaryBuilderLockedOutpoints: [],
    });
    const nextState = upsertPendingMutation(options.state, canceledMutation);
    await saveState(nextState, options.provider, options.unlockUntilUnixMs, options.nowUnixMs, options.paths);
    return {
      state: nextState,
      mutation: canceledMutation,
      resolution: "not-seen",
    };
  }

  return {
    state: options.state,
    mutation: options.mutation,
    resolution: "continue",
  };
}

async function confirmDirectAnchor(
  prompter: WalletPrompter,
  options: {
    domainName: string;
    walletAddress: string;
    foundingMessageText: string | null;
  },
): Promise<void> {
  prompter.writeLine(`You are anchoring "${options.domainName}".`);
  prompter.writeLine(`Wallet address: ${options.walletAddress}`);
  prompter.writeLine("Anchoring publishes a standalone DOMAIN_ANCHOR from the local wallet address.");

  if (options.foundingMessageText !== null) {
    prompter.writeLine("The founding message bytes will be public in mempool and on-chain.");
    prompter.writeLine(`Founding message: ${options.foundingMessageText}`);
  }

  const answer = (await prompter.prompt("Type the domain name to continue: ")).trim();
  if (answer !== options.domainName) {
    throw new Error("wallet_anchor_confirmation_rejected");
  }
}

export async function anchorDomain(options: AnchorDomainOptions): Promise<AnchorDomainResult> {
  if (!options.prompter.isInteractive) {
    throw new Error("wallet_anchor_requires_tty");
  }

  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const controlLock = await acquireFileLock(paths.walletControlLockPath, {
    purpose: "wallet-anchor",
    walletRootId: null,
  });
  const normalizedDomainName = normalizeDomainName(options.domainName);

  try {
    const miningPreemption = await pauseMiningForWalletMutation({
      paths,
      reason: "wallet-anchor",
    });
    const readContext = await (options.openReadContext ?? openWalletReadContext)({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      secretProvider: provider,
      walletControlLockHeld: true,
      paths,
    });

    try {
      assertWalletMutationContextReady(readContext, "wallet_anchor");
      const message = await resolveFoundingMessage({
        foundingMessageText: options.foundingMessageText,
        promptForFoundingMessageWhenMissing: options.promptForFoundingMessageWhenMissing,
        prompter: options.prompter,
      });
      const state = readContext.localState.state;
      const unlockUntilUnixMs = readContext.localState.unlockUntilUnixMs;
      const chainDomain = lookupDomain(readContext.snapshot.state, normalizedDomainName);

      if (chainDomain === null) {
        throw new Error("wallet_anchor_domain_not_found");
      }
      if (chainDomain.anchored) {
        throw new Error("wallet_anchor_domain_already_anchored");
      }

      const ownerHex = Buffer.from(chainDomain.ownerScriptPubKey).toString("hex");
      const localScriptHexes = new Set([
        state.funding.scriptPubKeyHex,
        ...(state.localScriptPubKeyHexes ?? []),
      ]);

      if (!localScriptHexes.has(ownerHex)) {
        throw new Error("wallet_anchor_owner_not_locally_controlled");
      }

      if (state.funding.address.trim() === "") {
        throw new Error("wallet_anchor_owner_identity_not_supported");
      }

      const intentFingerprintHex = createIntentFingerprint([
        "anchor",
        state.walletRootId,
        normalizedDomainName,
        state.funding.scriptPubKeyHex,
        message.payloadHex ?? "",
      ]);
      const node = await (options.attachService ?? attachOrStartManagedBitcoindService)({
        dataDir: options.dataDir,
        chain: "main",
        startHeight: 0,
        walletRootId: state.walletRootId,
      });
      const rpc = (options.rpcFactory ?? createRpcClient)(node.rpc);
      const walletName = state.managedCoreWallet.walletName;
      const existingMutation = findPendingMutationByIntent(state, intentFingerprintHex);
      let workingState = state;

      if (existingMutation !== null) {
        const reconciled = await reconcilePendingAnchorMutation({
          state,
          mutation: existingMutation,
          provider,
          unlockUntilUnixMs,
          nowUnixMs,
          paths,
          rpc,
          walletName,
          context: readContext,
          foundingMessageText: message.text,
        });
        workingState = reconciled.state;

        if (reconciled.resolution === "confirmed" || reconciled.resolution === "live") {
          return {
            domainName: normalizedDomainName,
            txid: reconciled.mutation.attemptedTxid ?? "unknown",
            tx1Txid: reconciled.mutation.attemptedTxid ?? "unknown",
            tx2Txid: reconciled.mutation.attemptedTxid ?? "unknown",
            dedicatedIndex: 0,
            status: reconciled.resolution,
            reusedExisting: true,
            foundingMessageText: message.text,
          };
        }

        if (reconciled.resolution === "repair-required") {
          throw new Error("wallet_anchor_repair_required");
        }
      }

      await confirmDirectAnchor(options.prompter, {
        domainName: normalizedDomainName,
        walletAddress: state.funding.address,
        foundingMessageText: message.text,
      });

      let nextState = upsertPendingMutation(
        workingState,
        createDraftAnchorMutation({
          state: workingState,
          domainName: normalizedDomainName,
          intentFingerprintHex,
          nowUnixMs,
          existing: existingMutation ?? null,
        }),
      );
      nextState = await saveState(nextState, provider, unlockUntilUnixMs, nowUnixMs, paths);

      const built = await buildWalletMutationTransactionWithReserveFallback({
        rpc,
        walletName,
        state: nextState,
        plan: buildDirectAnchorPlan({
          state: nextState,
          allUtxos: await rpc.listUnspent(walletName, 1),
          domainId: chainDomain.domainId,
          foundingMessagePayloadHex: message.payloadHex,
        }),
        validateFundedDraft: validateDirectAnchorDraft,
        finalizeErrorCode: "wallet_anchor_finalize_failed",
        mempoolRejectPrefix: "wallet_anchor_mempool_rejected",
        reserveCandidates: [],
      });

      const currentMutation = nextState.pendingMutations?.find((mutation) => mutation.intentFingerprintHex === intentFingerprintHex)
        ?? createDraftAnchorMutation({
          state: nextState,
          domainName: normalizedDomainName,
          intentFingerprintHex,
          nowUnixMs,
        });
      const broadcastingMutation = updateMutationRecord(
        currentMutation,
        "broadcasting",
        nowUnixMs,
        {
          attemptedTxid: built.txid,
          attemptedWtxid: built.wtxid,
          temporaryBuilderLockedOutpoints: built.temporaryBuilderLockedOutpoints,
        },
      );
      nextState = await saveState(
        upsertPendingMutation(nextState, broadcastingMutation),
        provider,
        unlockUntilUnixMs,
        nowUnixMs,
        paths,
      );

      ensureSameTipHeight(readContext, (await rpc.getBlockchainInfo()).blocks, "wallet_anchor_tip_mismatch");

      let accepted = false;
      try {
        await rpc.sendRawTransaction(built.rawHex);
        accepted = true;
      } catch (error) {
        if (isAlreadyAcceptedError(error)) {
          accepted = true;
        } else if (isBroadcastUnknownError(error)) {
          const unknownMutation = updateMutationRecord(broadcastingMutation, "broadcast-unknown", nowUnixMs, {
            attemptedTxid: built.txid,
            attemptedWtxid: built.wtxid,
            temporaryBuilderLockedOutpoints: built.temporaryBuilderLockedOutpoints,
          });
          nextState = await saveState(
            upsertPendingMutation(nextState, unknownMutation),
            provider,
            unlockUntilUnixMs,
            nowUnixMs,
            paths,
          );
          throw new Error("wallet_anchor_broadcast_unknown");
        } else {
          await unlockTemporaryBuilderLocks(rpc, walletName, built.temporaryBuilderLockedOutpoints);
          const canceledMutation = updateMutationRecord(broadcastingMutation, "canceled", nowUnixMs, {
            attemptedTxid: built.txid,
            attemptedWtxid: built.wtxid,
            temporaryBuilderLockedOutpoints: [],
          });
          nextState = await saveState(
            upsertPendingMutation(nextState, canceledMutation),
            provider,
            unlockUntilUnixMs,
            nowUnixMs,
            paths,
          );
          throw error;
        }
      }

      if (!accepted) {
        throw new Error("wallet_anchor_broadcast_failed");
      }

      await unlockTemporaryBuilderLocks(rpc, walletName, built.temporaryBuilderLockedOutpoints);
      const finalStatus = anchorConfirmedOnSnapshot({
        snapshot: readContext.snapshot,
        state: nextState,
        domainName: normalizedDomainName,
      }) ? "confirmed" : "live";
      const finalMutation = updateMutationRecord(broadcastingMutation, finalStatus, nowUnixMs, {
        attemptedTxid: built.txid,
        attemptedWtxid: built.wtxid,
        temporaryBuilderLockedOutpoints: [],
      });
      nextState = upsertAnchoredDomainRecord({
        state: upsertPendingMutation(nextState, finalMutation),
        domainName: normalizedDomainName,
        domainId: chainDomain.domainId,
        txid: built.txid,
        foundingMessageText: message.text,
      });
      nextState = await saveState(nextState, provider, unlockUntilUnixMs, nowUnixMs, paths);

      return {
        domainName: normalizedDomainName,
        txid: built.txid,
        tx1Txid: built.txid,
        tx2Txid: built.txid,
        dedicatedIndex: 0,
        status: finalStatus,
        reusedExisting: false,
        foundingMessageText: message.text,
      };
    } finally {
      await readContext.close();
      await miningPreemption.release();
    }
  } finally {
    await controlLock.release();
  }
}

export async function clearPendingAnchor(
  options: ClearPendingAnchorOptions,
): Promise<ClearPendingAnchorResult> {
  void options;
  throw new Error("cli_anchor_clear_removed");
}
