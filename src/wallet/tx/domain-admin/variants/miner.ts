import { serializeSetMiner } from "../../../cogop/index.js";
import { confirmTargetMutation } from "../confirm.js";
import {
  createResolvedDomainAdminSenderSummary,
  createResolvedDomainAdminTargetSummary,
} from "../intent.js";
import { normalizeBtcTarget } from "../../targets.js";
import type {
  ClearDomainMinerOptions,
  DomainAdminVariant,
  SetDomainMinerOptions,
} from "../types.js";

export function createSetMinerVariant(
  options: SetDomainMinerOptions,
): DomainAdminVariant {
  const target = normalizeBtcTarget(options.target);

  return {
    kind: "miner",
    errorPrefix: "wallet_domain_miner",
    requireRoot: true,
    intentParts(operation) {
      return [operation.chainDomain.name, target.scriptPubKeyHex];
    },
    async createPayload(operation) {
      return {
        opReturnData: serializeSetMiner(
          operation.chainDomain.domainId,
          Buffer.from(target.scriptPubKeyHex, "hex"),
        ).opReturnData,
        recipientScriptPubKeyHex: target.scriptPubKeyHex,
        resolvedTarget: createResolvedDomainAdminTargetSummary(target),
        resolvedEffect: { kind: "miner-set" },
      };
    },
    async confirm(operation) {
      await confirmTargetMutation(options.prompter, {
        kind: "miner",
        domainName: operation.chainDomain.name,
        target,
        sender: createResolvedDomainAdminSenderSummary(operation.sender, operation.senderSelector),
        assumeYes: options.assumeYes,
      });
    },
  };
}

export function createClearMinerVariant(
  options: ClearDomainMinerOptions,
): DomainAdminVariant {
  return {
    kind: "miner",
    errorPrefix: "wallet_domain_miner",
    requireRoot: true,
    intentParts(operation) {
      return [operation.chainDomain.name, "clear"];
    },
    async createPayload(operation) {
      return {
        opReturnData: serializeSetMiner(operation.chainDomain.domainId).opReturnData,
        recipientScriptPubKeyHex: null,
        resolvedTarget: null,
        resolvedEffect: { kind: "miner-clear" },
      };
    },
    async confirm(operation) {
      await confirmTargetMutation(options.prompter, {
        kind: "miner",
        domainName: operation.chainDomain.name,
        target: null,
        sender: createResolvedDomainAdminSenderSummary(operation.sender, operation.senderSelector),
        assumeYes: options.assumeYes,
      });
    },
  };
}
