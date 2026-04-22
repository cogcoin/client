import { createHash } from "node:crypto";

import {
  getLock,
  lookupDomain,
} from "@cogcoin/indexer/queries";

import {
  serializeCogClaim,
  serializeCogLock,
  serializeCogTransfer,
} from "../../cogop/index.js";
import {
  assertWalletMutationContextReady,
  createFundingMutationSender,
} from "../common.js";
import {
  getCanonicalIdentitySelector,
  resolveIdentityBySelector,
} from "../identity-selector.js";
import type {
  ClaimCogMutationOperation,
  CogMutationKind,
  CogResolvedSenderSummary,
  CogResolvedSummary,
  LockCogMutationOperation,
  SendCogOperation,
} from "./types.js";
import {
  MAX_LOCK_DURATION_BLOCKS,
  ZERO_PREIMAGE_HEX,
} from "./types.js";

export function normalizeCogDomainName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("wallet_cog_missing_domain");
  }
  return normalized;
}

export function normalizePositiveCogAmount(amountCogtoshi: bigint, errorCode: string): bigint {
  if (amountCogtoshi <= 0n) {
    throw new Error(errorCode);
  }
  return amountCogtoshi;
}

export function createCogIntentFingerprint(parts: Array<string | number | bigint>): string {
  return createHash("sha256")
    .update(parts.map((part) => String(part)).join("\n"))
    .digest("hex");
}

export function parseHex32(value: string, errorCode: string): Buffer {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(errorCode);
  }
  return Buffer.from(normalized, "hex");
}

export function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function ensureUsableSender(
  sender: ReturnType<typeof resolveIdentityBySelector>,
  errorPrefix: string,
  amountCogtoshi: bigint,
): void {
  if (sender.address === null) {
    throw new Error(`${errorPrefix}_sender_address_unavailable`);
  }

  if (sender.readOnly) {
    throw new Error(`${errorPrefix}_sender_read_only`);
  }

  if (sender.observedCogBalance === null || sender.observedCogBalance < amountCogtoshi) {
    throw new Error(`${errorPrefix}_insufficient_cog_balance`);
  }
}

export function createResolvedSenderSummary(
  identity: ReturnType<typeof resolveIdentityBySelector>,
): CogResolvedSenderSummary {
  return {
    selector: getCanonicalIdentitySelector(identity),
    localIndex: identity.index,
    scriptPubKeyHex: identity.scriptPubKeyHex,
    address: identity.address!,
  };
}

export function resolveIdentitySender(
  context: WalletReadContext,
  errorPrefix: string,
  amountCogtoshi: bigint,
  selector: string | null | undefined,
): {
  state: WalletStateV1;
  sender: MutationSender;
  resolved: CogResolvedSummary;
} {
  assertWalletMutationContextReady(context, errorPrefix);
  const identity = resolveIdentityBySelector(
    context,
    selector ?? context.model.walletAddress ?? "",
    errorPrefix,
  );
  ensureUsableSender(identity, errorPrefix, amountCogtoshi);

  return {
    state: context.localState.state,
    sender: createFundingMutationSender(context.localState.state),
    resolved: {
      sender: createResolvedSenderSummary(identity),
      claimPath: null,
    },
  };
}

export function resolveClaimSender(
  context: WalletReadContext,
  lockId: number,
  preimageHex: string,
  reclaim: boolean,
): {
  state: WalletStateV1;
  sender: MutationSender;
  recipientDomainName: string | null;
  amountCogtoshi: bigint;
  lockId: number;
  resolved: CogResolvedSummary;
} {
  const errorPrefix = reclaim ? "wallet_reclaim" : "wallet_claim";
  assertWalletMutationContextReady(context, errorPrefix);
  const currentHeight = context.snapshot.state.history.currentHeight;
  if (currentHeight === null) {
    throw new Error(`${errorPrefix}_current_height_unavailable`);
  }

  const lock = getLock(context.snapshot.state, lockId);
  if (lock === null || lock.status !== "active") {
    throw new Error(`${errorPrefix}_lock_not_found`);
  }

  const recipientDomain = lookupDomain(
    context.snapshot.state,
    context.model.domains.find((domain) => domain.domainId === lock.recipientDomainId)?.name ?? "",
  ) ?? [...context.snapshot.state.consensus.domainsById.values()].find((entry) => entry.domainId === lock.recipientDomainId)
    ?? null;
  const recipientDomainName = recipientDomain?.name ?? null;

  if (reclaim) {
    if (currentHeight < lock.timeoutHeight) {
      throw new Error("wallet_reclaim_before_timeout");
    }

    const lockerHex = Buffer.from(lock.lockerScriptPubKey).toString("hex");
    if (lockerHex !== context.localState.state.funding.scriptPubKeyHex || context.model.walletAddress == null) {
      throw new Error("wallet_reclaim_sender_not_local");
    }
    const senderIdentity = resolveIdentityBySelector(context, context.model.walletAddress, errorPrefix);
    ensureUsableSender(senderIdentity, errorPrefix, 0n);

    return {
      state: context.localState.state,
      sender: createFundingMutationSender(context.localState.state),
      recipientDomainName,
      amountCogtoshi: lock.amount,
      lockId: lock.lockId,
      resolved: {
        sender: createResolvedSenderSummary(senderIdentity),
        claimPath: "timeout-reclaim",
      },
    };
  }

  if (currentHeight >= lock.timeoutHeight) {
    throw new Error("wallet_claim_lock_expired");
  }

  const preimage = parseHex32(preimageHex, "wallet_claim_invalid_preimage");
  if (sha256Hex(preimage) !== Buffer.from(lock.condition).toString("hex")) {
    throw new Error("wallet_claim_preimage_mismatch");
  }

  if (recipientDomain === null) {
    throw new Error("wallet_claim_recipient_domain_missing");
  }

  const recipientOwnerHex = Buffer.from(recipientDomain.ownerScriptPubKey).toString("hex");
  if (recipientOwnerHex !== context.localState.state.funding.scriptPubKeyHex || context.model.walletAddress == null) {
    throw new Error("wallet_claim_sender_not_local");
  }
  const senderIdentity = resolveIdentityBySelector(context, context.model.walletAddress, errorPrefix);
  ensureUsableSender(senderIdentity, errorPrefix, 0n);

  return {
    state: context.localState.state,
    sender: createFundingMutationSender(context.localState.state),
    recipientDomainName,
    amountCogtoshi: lock.amount,
    lockId: lock.lockId,
    resolved: {
      sender: createResolvedSenderSummary(senderIdentity),
      claimPath: "recipient-claim",
    },
  };
}

export function parseTimeoutHeight(
  currentHeight: number,
  rawRelative: string | null | undefined,
  rawAbsolute: number | null | undefined,
): number {
  if ((rawRelative == null) === (rawAbsolute == null)) {
    throw new Error("wallet_lock_timeout_requires_exactly_one_mode");
  }

  if (rawAbsolute != null) {
    if (!Number.isInteger(rawAbsolute)) {
      throw new Error("wallet_lock_invalid_timeout_height");
    }
    return rawAbsolute;
  }

  const trimmed = rawRelative!.trim().toLowerCase();
  let blocks: number;

  if (/^[1-9]\d*$/.test(trimmed)) {
    blocks = Number.parseInt(trimmed, 10);
  } else {
    const match = /^(\d+)(m|h|d|w)$/.exec(trimmed);
    if (match == null) {
      throw new Error("wallet_lock_invalid_timeout_duration");
    }

    const value = Number.parseInt(match[1]!, 10);
    const minutesPerUnit = match[2] === "m" ? 1
      : match[2] === "h" ? 60
      : match[2] === "d" ? 24 * 60
      : 7 * 24 * 60;
    blocks = Math.ceil((value * minutesPerUnit) / 10);
  }

  return currentHeight + blocks;
}

export function createSendCogOpReturnData(operation: SendCogOperation): Uint8Array {
  return serializeCogTransfer(
    operation.amountCogtoshi,
    Buffer.from(operation.recipient.scriptPubKeyHex, "hex"),
  ).opReturnData;
}

export function createLockCogOpReturnData(operation: LockCogMutationOperation): Uint8Array {
  return serializeCogLock(
    operation.amountCogtoshi,
    operation.timeoutHeight,
    operation.recipientDomain.domainId,
    Buffer.from(operation.conditionHex, "hex"),
  ).opReturnData;
}

export function createClaimCogOpReturnData(operation: ClaimCogMutationOperation): Uint8Array {
  return serializeCogClaim(
    operation.lockId,
    Buffer.from(operation.preimageHex, "hex"),
  ).opReturnData;
}

export {
  MAX_LOCK_DURATION_BLOCKS,
  ZERO_PREIMAGE_HEX,
};

import type { WalletReadContext } from "../../read/index.js";
import type { WalletStateV1 } from "../../types.js";
import type { MutationSender } from "../common.js";
