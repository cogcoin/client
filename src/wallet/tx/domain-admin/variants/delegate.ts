import { serializeSetDelegate } from "../../../cogop/index.js";
import { confirmTargetMutation } from "../confirm.js";
import {
  createResolvedDomainAdminSenderSummary,
  createResolvedDomainAdminTargetSummary,
} from "../intent.js";
import { normalizeBtcTarget } from "../../targets.js";
import type {
  ClearDomainDelegateOptions,
  DomainAdminVariant,
  SetDomainDelegateOptions,
} from "../types.js";

export function createSetDelegateVariant(
  options: SetDomainDelegateOptions,
): DomainAdminVariant {
  const target = normalizeBtcTarget(options.target);

  return {
    kind: "delegate",
    errorPrefix: "wallet_domain_delegate",
    intentParts(operation) {
      return [operation.chainDomain.name, target.scriptPubKeyHex];
    },
    async createPayload(operation) {
      if (target.scriptPubKeyHex === operation.sender.scriptPubKeyHex) {
        throw new Error("wallet_domain_delegate_self_target");
      }
      return {
        opReturnData: serializeSetDelegate(
          operation.chainDomain.domainId,
          Buffer.from(target.scriptPubKeyHex, "hex"),
        ).opReturnData,
        recipientScriptPubKeyHex: target.scriptPubKeyHex,
        resolvedTarget: createResolvedDomainAdminTargetSummary(target),
        resolvedEffect: { kind: "delegate-set" },
      };
    },
    async confirm(operation) {
      await confirmTargetMutation(options.prompter, {
        kind: "delegate",
        domainName: operation.chainDomain.name,
        target,
        sender: createResolvedDomainAdminSenderSummary(operation.sender, operation.senderSelector),
        assumeYes: options.assumeYes,
      });
    },
  };
}

export function createClearDelegateVariant(
  options: ClearDomainDelegateOptions,
): DomainAdminVariant {
  return {
    kind: "delegate",
    errorPrefix: "wallet_domain_delegate",
    intentParts(operation) {
      return [operation.chainDomain.name, "clear"];
    },
    async createPayload(operation) {
      return {
        opReturnData: serializeSetDelegate(operation.chainDomain.domainId).opReturnData,
        recipientScriptPubKeyHex: null,
        resolvedTarget: null,
        resolvedEffect: { kind: "delegate-clear" },
      };
    },
    async confirm(operation) {
      await confirmTargetMutation(options.prompter, {
        kind: "delegate",
        domainName: operation.chainDomain.name,
        target: null,
        sender: createResolvedDomainAdminSenderSummary(operation.sender, operation.senderSelector),
        assumeYes: options.assumeYes,
      });
    },
  };
}
