import { createHash } from "node:crypto";

import { lookupDomain } from "@cogcoin/indexer/queries";

import { validateDomainName } from "../../cogop/index.js";
import {
  assertWalletMutationContextReady,
  createFundingMutationSender,
  type MutationSender,
} from "../common.js";
import { normalizeBtcTarget } from "../targets.js";
import type {
  DomainAdminOperation,
  DomainAdminResolvedSenderSummary,
  DomainAdminResolvedTargetSummary,
  ReadyWalletReadContext,
} from "./types.js";

export function normalizeDomainAdminDomainName(domainName: string): string {
  const normalized = domainName.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("wallet_domain_admin_missing_domain");
  }
  validateDomainName(normalized);
  return normalized;
}

export function bytesToHex(value: Uint8Array | null | undefined): string {
  return Buffer.from(value ?? new Uint8Array()).toString("hex");
}

export function createDomainAdminIntentFingerprint(parts: Array<string | number | bigint>): string {
  return createHash("sha256")
    .update(parts.map((part) => String(part)).join("\n"))
    .digest("hex");
}

export function createResolvedDomainAdminSenderSummary(
  sender: MutationSender,
  selector: string,
): DomainAdminResolvedSenderSummary {
  return {
    selector,
    localIndex: sender.localIndex,
    scriptPubKeyHex: sender.scriptPubKeyHex,
    address: sender.address,
  };
}

export function createResolvedDomainAdminTargetSummary(
  target: ReturnType<typeof normalizeBtcTarget>,
): DomainAdminResolvedTargetSummary {
  return {
    scriptPubKeyHex: target.scriptPubKeyHex,
    address: target.address,
    opaque: target.opaque,
  };
}

export function resolveAnchoredDomainOperation(
  context: ReadyWalletReadContext,
  domainName: string,
  errorPrefix: string,
  options: {
    requireRoot?: boolean;
    rejectReadOnly?: boolean;
  } = {},
): DomainAdminOperation {
  void options.rejectReadOnly;
  assertWalletMutationContextReady(context, errorPrefix);
  const chainDomain = lookupDomain(context.snapshot.state, domainName);

  if (chainDomain === null) {
    throw new Error(`${errorPrefix}_domain_not_found`);
  }

  if (!chainDomain.anchored) {
    throw new Error(`${errorPrefix}_domain_not_anchored`);
  }

  if (options.requireRoot && domainName.includes("-")) {
    throw new Error(`${errorPrefix}_root_domain_required`);
  }

  const ownerHex = Buffer.from(chainDomain.ownerScriptPubKey).toString("hex");
  if (ownerHex !== context.localState.state.funding.scriptPubKeyHex || context.model.walletAddress == null) {
    throw new Error(`${errorPrefix}_owner_not_locally_controlled`);
  }

  return {
    readContext: context,
    state: context.localState.state,
    sender: createFundingMutationSender(context.localState.state),
    senderSelector: context.model.walletAddress,
    chainDomain,
  };
}
