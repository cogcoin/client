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
  type WalletMutationRpcClient,
} from "./common.js";
import { confirmYesNo } from "./confirm.js";

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
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
  openReadContext?: typeof openWalletReadContext;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => WalletAnchorRpcClient;
}

export interface ClearPendingAnchorResult {
  domainName: string;
  cleared: boolean;
  previousFamilyStatus: ProactiveFamilyStateRecord["status"] | null;
  previousFamilyStep: ProactiveFamilyStateRecord["currentStep"] | null;
  releasedDedicatedIndex: number | null;
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
  return state.proactiveFamilies.find((family) =>
    family.type === "anchor"
    && family.domainName === domainName
    && ACTIVE_FAMILY_STATUSES.has(family.status)
  ) ?? null;
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

async function confirmAnchorClear(
  prompter: WalletPrompter,
  domainName: string,
  dedicatedIndex: number | null,
  assumeYes = false,
): Promise<void> {
  const releaseLine = dedicatedIndex === null
    ? "This will cancel the local pending anchor reservation."
    : `This will cancel the local pending anchor reservation and release dedicated index ${dedicatedIndex} for reuse.`;
  await confirmYesNo(prompter, releaseLine, {
    assumeYes,
    errorCode: "wallet_anchor_clear_confirmation_rejected",
    requiresTtyErrorCode: "wallet_anchor_clear_requires_tty",
    prompt: `Clear pending anchor for "${domainName}"? [y/N]: `,
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
    fixedInputs: [{ txid: provisional.txid, vout: provisional.vout }],
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
    reserveCandidates: options.state.proactiveReserveOutpoints,
  });
}

async function relockAnchorOutpoint(
  rpc: WalletAnchorRpcClient,
  walletName: string,
  outpoint: OutpointRecord | null,
): Promise<void> {
  if (outpoint === null) {
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
    const message = await resolveFoundingMessage({
      foundingMessageText: options.foundingMessageText,
      promptForFoundingMessageWhenMissing: options.promptForFoundingMessageWhenMissing,
      prompter: options.prompter,
    });
    const readContext = await (options.openReadContext ?? openWalletReadContext)({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      secretProvider: provider,
      walletControlLockHeld: true,
      paths,
    });

    try {
      let operation = resolveAnchorOperation(
        readContext,
        normalizedDomainName,
        message.text,
        message.payloadHex,
      );
      const initialFamily = createDraftAnchorFamily(operation, nowUnixMs);
      const existingFamily = findAnchorFamilyByIntent(operation.state, initialFamily.intentFingerprintHex);
      const conflictingFamily = findActiveAnchorFamilyByDomain(operation.state, normalizedDomainName);

      if (existingFamily === null && isClearableReservedAnchorFamily(conflictingFamily)) {
        throw new Error(`wallet_anchor_clear_pending_first_${conflictingFamily.domainName}`);
      }

      if (existingFamily === null && conflictingFamily !== null) {
        throw new Error("wallet_anchor_prior_family_unresolved");
      }

      const node = await (options.attachService ?? attachOrStartManagedBitcoindService)({
        dataDir: options.dataDir,
        chain: "main",
        startHeight: 0,
        walletRootId: operation.state.walletRootId,
      });
      const rpc = (options.rpcFactory ?? createRpcClient)(node.rpc);
      const walletName = operation.state.managedCoreWallet.walletName;

      let resumedFamily: ProactiveFamilyStateRecord | null = null;
      let resumedExisting = false;
      let workingState = operation.state;

      if (existingFamily !== null) {
        const existingReservedIndex = existingFamily.reservedDedicatedIndex ?? operation.targetIdentity.localIndex;
        const existingTargetIdentity = deriveAnchorTargetIdentityForIndex(
          operation.state,
          existingReservedIndex,
        );
        const reconciled = await reconcileAnchorFamily({
          state: operation.state,
          family: existingFamily,
          operation: {
            ...operation,
            targetIdentity: existingTargetIdentity,
          },
          provider,
          nowUnixMs,
          paths,
          unlockUntilUnixMs: operation.unlockUntilUnixMs,
          rpc,
          walletName,
        });
        workingState = reconciled.state;

        if (reconciled.resolution === "confirmed" || reconciled.resolution === "live") {
          return {
            domainName: normalizedDomainName,
            txid: reconciled.family.tx2?.attemptedTxid ?? reconciled.family.tx1?.attemptedTxid ?? "unknown",
            tx1Txid: reconciled.family.tx1?.attemptedTxid ?? "unknown",
            tx2Txid: reconciled.family.tx2?.attemptedTxid ?? "unknown",
            dedicatedIndex: reconciled.family.reservedDedicatedIndex ?? existingTargetIdentity.localIndex,
            status: reconciled.resolution,
            reusedExisting: true,
            foundingMessageText: reconciled.family.foundingMessageText,
          };
        }

        if (reconciled.resolution === "repair-required") {
          throw new Error("wallet_anchor_repair_required");
        }

        if (reconciled.resolution === "ready-for-tx2") {
          operation = {
            ...operation,
            targetIdentity: existingTargetIdentity,
          };
          resumedFamily = reconciled.family;
          resumedExisting = true;
        }
      }

      let nextState = workingState;
      let family: ProactiveFamilyStateRecord;

      if (resumedFamily !== null) {
        family = resumedFamily;
      } else {
        await confirmAnchor(options.prompter, operation);

        nextState = reserveAnchorFamilyState(nextState, initialFamily, operation.targetIdentity, operation.foundingMessageText);
        nextState = await saveState(nextState, provider, operation.unlockUntilUnixMs, nowUnixMs, paths);

        const tx1Plan = buildTx1Plan({
          state: nextState,
          allUtxos: await rpc.listUnspent(walletName, 1),
          operation,
        });
        const builtTx1 = await buildTx1({
          rpc,
          walletName,
          state: nextState,
          plan: tx1Plan,
        });

        const broadcastingTx1: ProactiveFamilyTransactionRecord = createBroadcastingTxRecord(builtTx1);
        family = {
          ...(findAnchorFamilyByIntent(nextState, initialFamily.intentFingerprintHex) ?? initialFamily),
          status: "broadcasting" as const,
          currentStep: "tx1" as const,
          lastUpdatedAtUnixMs: nowUnixMs,
          tx1: broadcastingTx1,
        };
        nextState = updateAnchorFamilyState({
          state: nextState,
          family,
          target: operation.targetIdentity,
          status: "broadcasting",
          localAnchorIntent: "reserved",
          currentStep: "tx1",
          nowUnixMs,
          tx1: broadcastingTx1,
        });
        nextState = await saveState(nextState, provider, operation.unlockUntilUnixMs, nowUnixMs, paths);

        ensureSameTipHeight(readContext, (await rpc.getBlockchainInfo()).blocks, "wallet_anchor_tip_mismatch");

        try {
          await rpc.sendRawTransaction(builtTx1.rawHex);
        } catch (error) {
          if (!isAlreadyAcceptedError(error)) {
            if (isBroadcastUnknownError(error)) {
              family = {
                ...family,
                status: "broadcast-unknown",
                tx1: {
                  ...broadcastingTx1,
                  status: "broadcast-unknown",
                },
              };
              nextState = updateAnchorFamilyState({
                state: nextState,
                family,
                target: operation.targetIdentity,
                status: "broadcast-unknown",
                localAnchorIntent: "reserved",
                currentStep: "tx1",
                nowUnixMs,
                tx1: family.tx1!,
              });
              await saveState(nextState, provider, operation.unlockUntilUnixMs, nowUnixMs, paths);
              throw new Error("wallet_anchor_tx1_broadcast_unknown");
            }

            await unlockTemporaryBuilderLocks(rpc, walletName, builtTx1.temporaryBuilderLockedOutpoints);
            family = {
              ...family,
              status: "canceled",
              tx1: {
                ...broadcastingTx1,
                status: "canceled",
                temporaryBuilderLockedOutpoints: [],
              },
            };
            nextState = updateAnchorFamilyState({
              state: nextState,
              family,
              target: operation.targetIdentity,
              status: "canceled",
              localAnchorIntent: "none",
              currentStep: "tx1",
              nowUnixMs,
              tx1: family.tx1!,
            });
            await saveState(nextState, provider, operation.unlockUntilUnixMs, nowUnixMs, paths);
            throw error;
          }
        }

        await unlockTemporaryBuilderLocks(rpc, walletName, builtTx1.temporaryBuilderLockedOutpoints);
        family = {
          ...family,
          status: "live",
          currentStep: "tx1",
          tx1: {
            ...broadcastingTx1,
            status: "live",
            temporaryBuilderLockedOutpoints: [],
          },
        };
        nextState = updateAnchorFamilyState({
          state: nextState,
          family,
          target: operation.targetIdentity,
          status: "live",
          localAnchorIntent: "tx1-live",
          currentStep: "tx1",
          nowUnixMs,
          tx1: family.tx1!,
          listingCancelCommitted: operation.hadListing,
          moveOwnershipToTarget: true,
        });
        nextState = await saveState(nextState, provider, operation.unlockUntilUnixMs, nowUnixMs, paths);

        if (operation.sourceAnchorOutpoint !== null) {
          await relockAnchorOutpoint(rpc, walletName, {
            txid: builtTx1.txid,
            vout: 2,
          });
        }
      }

      const result = await submitTx2({
        state: nextState,
        family,
        operation,
        readContext: operation.readContext,
        provider,
        rpc,
        walletName,
        nowUnixMs,
        paths,
        unlockUntilUnixMs: operation.unlockUntilUnixMs,
      });

      return {
        ...result,
        reusedExisting: resumedExisting,
        foundingMessageText: result.foundingMessageText ?? operation.foundingMessageText,
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
  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const controlLock = await acquireFileLock(paths.walletControlLockPath, {
    purpose: "wallet-anchor-clear",
    walletRootId: null,
  });
  const normalizedDomainName = normalizeDomainName(options.domainName);

  try {
    const miningPreemption = await pauseMiningForWalletMutation({
      paths,
      reason: "wallet-anchor-clear",
    });
    const readContext = await (options.openReadContext ?? openWalletReadContext)({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      secretProvider: provider,
      walletControlLockHeld: true,
      paths,
    });

    try {
      assertWalletMutationContextReady(readContext, "wallet_anchor_clear");
      const family = findActiveAnchorFamilyByDomain(readContext.localState.state, normalizedDomainName);
      const domain = readContext.localState.state.domains.find((entry) =>
        entry.name === normalizedDomainName
      ) ?? null;

      if (domain === null && family === null) {
        throw new Error("wallet_anchor_clear_domain_not_found");
      }

      if (family === null) {
        if (domain === null) {
          throw new Error("wallet_anchor_clear_domain_not_found");
        }

        if (domain.localAnchorIntent !== "none") {
          throw new Error("wallet_anchor_clear_inconsistent_state");
        }

        return {
          domainName: normalizedDomainName,
          cleared: false,
          previousFamilyStatus: null,
          previousFamilyStep: null,
          releasedDedicatedIndex: null,
        };
      }

      if (family.type !== "anchor") {
        throw new Error("wallet_anchor_clear_inconsistent_state");
      }

      if (family.status !== "draft" || family.currentStep !== "reserved") {
        throw new Error(`wallet_anchor_clear_not_clearable_${family.status}`);
      }

      const reservedDedicatedIndex = family.reservedDedicatedIndex ?? null;

      if (
        reservedDedicatedIndex === null
        || family.tx1?.attemptedTxid !== null
        || family.tx2?.attemptedTxid !== null
        || (
          domain !== null
          && (
            domain.localAnchorIntent !== "reserved"
            || domain.dedicatedIndex === null
            || domain.dedicatedIndex !== reservedDedicatedIndex
          )
        )
      ) {
        throw new Error("wallet_anchor_clear_inconsistent_state");
      }

      await confirmAnchorClear(
        options.prompter,
        normalizedDomainName,
        reservedDedicatedIndex,
        options.assumeYes ?? false,
      );
      const releasedState = releaseClearedAnchorReservationState({
        state: readContext.localState.state,
        familyId: family.familyId,
        domainName: normalizedDomainName,
        nowUnixMs,
      });
      await saveWalletStatePreservingUnlock({
        state: {
          ...releasedState,
          stateRevision: releasedState.stateRevision + 1,
          lastWrittenAtUnixMs: nowUnixMs,
        },
        provider,
        unlockUntilUnixMs: readContext.localState.unlockUntilUnixMs,
        nowUnixMs,
        paths,
      });

      return {
        domainName: normalizedDomainName,
        cleared: true,
        previousFamilyStatus: family.status,
        previousFamilyStep: family.currentStep ?? null,
        releasedDedicatedIndex: reservedDedicatedIndex,
      };
    } finally {
      await readContext.close();
      await miningPreemption.release();
    }
  } finally {
    await controlLock.release();
  }
}
