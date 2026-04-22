import { serializeSetCanonical } from "../../../cogop/index.js";
import { confirmCanonicalMutation } from "../confirm.js";
import { createResolvedDomainAdminSenderSummary } from "../intent.js";
import type {
  DomainAdminVariant,
  SetDomainCanonicalOptions,
} from "../types.js";

export function createCanonicalVariant(
  options: SetDomainCanonicalOptions,
): DomainAdminVariant {
  return {
    kind: "canonical",
    errorPrefix: "wallet_domain_canonical",
    intentParts(operation) {
      return [operation.chainDomain.name, operation.sender.scriptPubKeyHex];
    },
    async createPayload(operation) {
      return {
        opReturnData: serializeSetCanonical(operation.chainDomain.domainId).opReturnData,
        resolvedTarget: null,
        resolvedEffect: { kind: "canonicalize-owner" },
      };
    },
    async confirm(operation) {
      await confirmCanonicalMutation(
        options.prompter,
        operation.chainDomain.name,
        createResolvedDomainAdminSenderSummary(operation.sender, operation.senderSelector),
        options.assumeYes,
      );
    },
  };
}
