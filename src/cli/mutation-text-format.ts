import type {
  CogMutationResult,
  DomainAdminMutationResult,
  DomainMarketMutationResult,
  FieldMutationResult,
  ReputationMutationResult,
  RegisterDomainResult,
} from "../wallet/tx/index.js";
import { formatCogAmount } from "../wallet/tx/common.js";

export function formatRegisterSenderSummary(result: RegisterDomainResult): string {
  return `${result.resolved.sender.selector} (${result.resolved.sender.address})`;
}

export function formatRegisterEconomicEffect(result: RegisterDomainResult): string {
  if (result.resolved.economicEffect.kind === "treasury-payment") {
    return `send ${result.resolved.economicEffect.amount.toString()} sats to the Cogcoin treasury`;
  }

  return `burn ${formatCogAmount(result.resolved.economicEffect.amount)} from the parent-owner identity`;
}

export function formatBuyBuyerSummary(result: DomainMarketMutationResult): string {
  if (result.resolvedBuyer === null || result.resolvedBuyer === undefined) {
    return "unknown";
  }

  return `${result.resolvedBuyer.selector} (${result.resolvedBuyer.address})`;
}

export function formatBuySellerSummary(result: DomainMarketMutationResult): string {
  if (result.resolvedSeller === null || result.resolvedSeller === undefined) {
    return "unknown";
  }

  return result.resolvedSeller.address ?? `spk:${result.resolvedSeller.scriptPubKeyHex}`;
}

export function formatBuySettlementSummary(): string {
  return "entirely in COG state; no BTC seller output";
}

export function formatDomainMarketSenderSummary(result: DomainMarketMutationResult): string {
  if (result.resolved === null || result.resolved === undefined) {
    return "unknown";
  }

  return `${result.resolved.sender.selector} (${result.resolved.sender.address})`;
}

export function formatDomainMarketRecipientSummary(result: DomainMarketMutationResult): string {
  const recipient = result.resolved?.recipient;
  if (recipient !== null && recipient !== undefined) {
    return recipient.address ?? `spk:${recipient.scriptPubKeyHex}`;
  }

  if (result.recipientScriptPubKeyHex === null || result.recipientScriptPubKeyHex === undefined) {
    return "unknown";
  }

  return `spk:${result.recipientScriptPubKeyHex}`;
}

export function formatDomainMarketEconomicEffect(result: DomainMarketMutationResult): string {
  const economicEffect = result.resolved?.economicEffect;
  if (economicEffect === null || economicEffect === undefined) {
    return "unknown";
  }

  if (economicEffect.kind === "ownership-transfer") {
    return economicEffect.clearsListing
      ? "transfer domain ownership and clear any active listing"
      : "transfer domain ownership";
  }

  if (economicEffect.kind === "listing-set") {
    return `set the listing price to ${economicEffect.listedPriceCogtoshi} cogtoshi in COG state`;
  }

  return "clear the active listing in COG state";
}

export function formatDomainAdminSenderSummary(result: DomainAdminMutationResult): string {
  if (result.resolved === null || result.resolved === undefined) {
    return "unknown";
  }

  return `${result.resolved.sender.selector} (${result.resolved.sender.address})`;
}

export function formatDomainAdminTargetSummary(result: DomainAdminMutationResult): string {
  if (result.resolved?.target !== null && result.resolved?.target !== undefined) {
    return result.resolved.target.address ?? `spk:${result.resolved.target.scriptPubKeyHex}`;
  }

  if (result.recipientScriptPubKeyHex === null) {
    return "clear";
  }

  if (result.recipientScriptPubKeyHex === undefined) {
    return "none";
  }

  return `spk:${result.recipientScriptPubKeyHex}`;
}

export function formatDomainAdminEffect(result: DomainAdminMutationResult): string {
  const effect = result.resolved?.effect;
  if (effect === null || effect === undefined) {
    return "unknown";
  }

  switch (effect.kind) {
    case "endpoint-set":
      return `set the endpoint payload to ${effect.byteLength} bytes`;
    case "endpoint-clear":
      return "clear the endpoint payload";
    case "delegate-set":
      return "set the delegate target";
    case "delegate-clear":
      return "clear the delegate target";
    case "miner-set":
      return "set the designated miner target";
    case "miner-clear":
      return "clear the designated miner target";
    case "canonicalize-owner":
      return "canonicalize the current anchored owner";
  }
}

export function formatDomainAdminPayloadSummary(result: DomainAdminMutationResult): string {
  const effect = result.resolved?.effect;
  if (effect?.kind === "endpoint-set") {
    return `${effect.byteLength} bytes`;
  }

  if (effect?.kind === "endpoint-clear") {
    return "clear";
  }

  if (result.endpointValueHex === null || result.endpointValueHex === undefined) {
    return "none";
  }

  return result.endpointValueHex === "" ? "clear" : `${result.endpointValueHex.length / 2} bytes`;
}

export function formatFieldSenderSummary(result: FieldMutationResult): string {
  if (result.resolved === null || result.resolved === undefined) {
    return "unknown";
  }

  return `${result.resolved.sender.selector} (${result.resolved.sender.address})`;
}

export function formatFieldPath(result: FieldMutationResult): string {
  return result.resolved?.path ?? "unknown";
}

export function formatFieldValueSummary(result: FieldMutationResult): string {
  if (result.resolved?.value !== null && result.resolved?.value !== undefined) {
    return `format ${result.resolved.value.format}, ${result.resolved.value.byteLength} bytes`;
  }

  return "none";
}

export function formatFieldEffect(result: FieldMutationResult): string {
  const effect = result.resolved?.effect;
  if (effect === null || effect === undefined) {
    return "unknown";
  }

  switch (effect.kind) {
    case "create-empty-field":
      return `burn ${effect.burnCogtoshi} cogtoshi to create an empty field`;
    case "create-and-initialize-field":
      return `burn ${effect.tx1BurnCogtoshi} cogtoshi in Tx1 and ${effect.tx2AdditionalBurnCogtoshi} additional cogtoshi in Tx2`;
    case "write-field-value":
      return `burn ${effect.burnCogtoshi} cogtoshi to write the field value`;
    case "clear-field-value":
      return "clear the field value with no additional COG burn";
  }
}

export function formatCogSenderSummary(result: CogMutationResult): string {
  return `${result.resolved.sender.selector} (${result.resolved.sender.address})`;
}

export function formatCogClaimPath(result: CogMutationResult): string {
  return result.resolved.claimPath ?? "unknown";
}

export function formatReputationSenderSummary(result: ReputationMutationResult): string {
  if (result.resolved === null || result.resolved === undefined) {
    return "unknown";
  }

  return `${result.resolved.sender.selector} (${result.resolved.sender.address})`;
}

export function formatReputationReviewSummary(result: ReputationMutationResult): string {
  if (result.resolved === null || result.resolved === undefined) {
    return result.reviewIncluded ? "included" : "none";
  }

  if (!result.resolved.review.included || result.resolved.review.byteLength === null) {
    return "none";
  }

  return `included (${result.resolved.review.byteLength} bytes)`;
}

export function formatReputationEffect(result: ReputationMutationResult): string {
  const effect = result.resolved?.effect;
  if (effect === null || effect === undefined) {
    return "unknown";
  }

  if (effect.kind === "give-support") {
    return `burn ${effect.burnCogtoshi} cogtoshi to publish support`;
  }

  return `revoke visible support with no refund of the previously burned ${effect.burnCogtoshi} cogtoshi`;
}
