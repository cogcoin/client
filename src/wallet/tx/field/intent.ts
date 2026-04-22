import { createHash } from "node:crypto";

import { lookupDomain } from "@cogcoin/indexer/queries";

import { validateFieldName } from "../../cogop/validate-name.js";
import { assertWalletMutationContextReady } from "../common.js";
import type {
  FieldOperation,
  ReadyWalletReadContext,
} from "./types.js";

export function normalizeFieldDomainName(domainName: string): string {
  const normalized = domainName.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("wallet_field_missing_domain");
  }
  return normalized;
}

export function normalizeFieldNameInput(fieldName: string): string {
  const normalized = fieldName.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("wallet_field_missing_field_name");
  }
  validateFieldName(normalized);
  return normalized;
}

export function createFieldIntentFingerprint(parts: Array<string | number | bigint>): string {
  return createHash("sha256")
    .update(parts.map((part) => String(part)).join("\n"))
    .digest("hex");
}

export function resolveAnchoredFieldOperation(
  context: ReadyWalletReadContext,
  domainName: string,
  errorPrefix: string,
): FieldOperation {
  assertWalletMutationContextReady(context, errorPrefix);
  const chainDomain = lookupDomain(context.snapshot.state, domainName);

  if (chainDomain === null) {
    throw new Error(`${errorPrefix}_domain_not_found`);
  }

  if (!chainDomain.anchored) {
    throw new Error(`${errorPrefix}_domain_not_anchored`);
  }

  const ownerHex = Buffer.from(chainDomain.ownerScriptPubKey).toString("hex");
  const state = context.localState.state;

  if (ownerHex !== state.funding.scriptPubKeyHex || state.funding.address.trim() === "") {
    throw new Error(`${errorPrefix}_owner_not_locally_controlled`);
  }

  return {
    readContext: context,
    state,
    sender: {
      localIndex: 0,
      scriptPubKeyHex: state.funding.scriptPubKeyHex,
      address: state.funding.address,
    },
    senderSelector: state.funding.address,
    chainDomain,
  };
}
