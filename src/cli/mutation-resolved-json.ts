import type {
  CogMutationResult,
  DomainAdminMutationResult,
  DomainMarketMutationResult,
  FieldMutationResult,
  RegisterDomainResult,
  ReputationMutationResult,
} from "../wallet/tx/index.js";

export function decimalOrNull(value: bigint | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toString();
}

function buildResolvedSenderJson(
  sender: {
    selector: string;
    localIndex: number;
    scriptPubKeyHex: string;
    address: string;
  },
) {
  return {
    selector: sender.selector,
    localIndex: sender.localIndex,
    scriptPubKeyHex: sender.scriptPubKeyHex,
    address: sender.address,
  };
}

function buildScriptTargetJson(
  target: {
    scriptPubKeyHex: string;
    address: string | null;
    opaque: boolean;
  } | null | undefined,
) {
  return target === null || target === undefined
    ? null
    : {
      scriptPubKeyHex: target.scriptPubKeyHex,
      address: target.address,
      opaque: target.opaque,
    };
}

export function buildRegisterResolvedJson(result: RegisterDomainResult) {
  return {
    path: result.resolved.path,
    parentDomainName: result.resolved.parentDomainName,
    sender: buildResolvedSenderJson(result.resolved.sender),
    economicEffect: {
      kind: result.resolved.economicEffect.kind,
      amount: decimalOrNull(result.resolved.economicEffect.amount),
    },
  };
}

export function buildDomainMarketResolvedJson(
  result: DomainMarketMutationResult,
  commandKind: "transfer" | "sell" | "unsell" | "buy",
) {
  if (commandKind === "buy") {
    return {
      buyer: result.resolvedBuyer === null || result.resolvedBuyer === undefined
        ? null
        : buildResolvedSenderJson(result.resolvedBuyer),
      seller: result.resolvedSeller === null || result.resolvedSeller === undefined
        ? null
        : {
          scriptPubKeyHex: result.resolvedSeller.scriptPubKeyHex,
          address: result.resolvedSeller.address,
        },
    };
  }

  if (result.resolved === null || result.resolved === undefined) {
    return null;
  }

  return {
    sender: buildResolvedSenderJson(result.resolved.sender),
    recipient: buildScriptTargetJson(result.resolved.recipient),
    economicEffect: result.resolved.economicEffect.kind === "ownership-transfer"
      ? {
        kind: result.resolved.economicEffect.kind,
        clearsListing: result.resolved.economicEffect.clearsListing,
      }
      : {
        kind: result.resolved.economicEffect.kind,
        listedPriceCogtoshi: result.resolved.economicEffect.listedPriceCogtoshi,
      },
  };
}

export function buildCogResolvedJson(
  result: CogMutationResult,
  commandKind: "send" | "claim" | "reclaim" | "cog-lock",
) {
  return {
    sender: buildResolvedSenderJson(result.resolved.sender),
    ...(commandKind === "claim" || commandKind === "reclaim"
      ? { claimPath: result.resolved.claimPath }
      : {}),
  };
}

export function buildDomainAdminResolvedJson(result: DomainAdminMutationResult) {
  if (result.resolved === null || result.resolved === undefined) {
    return null;
  }

  return {
    sender: buildResolvedSenderJson(result.resolved.sender),
    target: buildScriptTargetJson(result.resolved.target),
    effect: result.resolved.effect.kind === "endpoint-set"
      ? {
        kind: result.resolved.effect.kind,
        byteLength: result.resolved.effect.byteLength,
      }
      : {
        kind: result.resolved.effect.kind,
      },
  };
}

export function buildFieldResolvedJson(result: FieldMutationResult) {
  if (result.resolved === null || result.resolved === undefined) {
    return null;
  }

  return {
    sender: buildResolvedSenderJson(result.resolved.sender),
    path: result.resolved.path,
    value: result.resolved.value === null
      ? null
      : {
        format: result.resolved.value.format,
        byteLength: result.resolved.value.byteLength,
      },
    effect: {
      kind: result.resolved.effect.kind,
      burnCogtoshi: result.resolved.effect.burnCogtoshi,
    },
  };
}

export function buildReputationResolvedJson(result: ReputationMutationResult) {
  if (result.resolved === null || result.resolved === undefined) {
    return null;
  }

  return {
    sender: buildResolvedSenderJson(result.resolved.sender),
    effect: {
      kind: result.resolved.effect.kind,
      burnCogtoshi: result.resolved.effect.burnCogtoshi,
    },
    review: {
      included: result.resolved.review.included,
      byteLength: result.resolved.review.byteLength,
    },
    selfStake: result.resolved.selfStake,
  };
}
