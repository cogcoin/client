import { getBalance } from "@cogcoin/indexer/queries";

import { serializeFieldReg } from "../../../cogop/index.js";
import { confirmYesNo } from "../confirm.js";
import {
  createFieldIntentFingerprint,
  normalizeFieldDomainName,
  normalizeFieldNameInput,
} from "../intent.js";
import {
  createStandaloneFieldMutation,
  findActiveFieldCreateMutationByDomain,
  getObservedFieldState,
} from "../draft.js";
import {
  createResolvedFieldSenderSummary,
  describeFieldEffect,
} from "../result.js";
import type {
  CreateFieldOptions,
  FieldMutationVariant,
} from "../types.js";

export function createFieldCreateVariant(
  options: CreateFieldOptions,
): FieldMutationVariant {
  const permanent = options.permanent ?? false;

  return {
    kind: "field-create",
    errorPrefix: "wallet_field_create",
    async createMutation({ operation, existing, feeSelection, nowUnixMs }) {
      const normalizedDomainName = normalizeFieldDomainName(options.domainName);
      const normalizedFieldName = normalizeFieldNameInput(options.fieldName);
      const existingField = getObservedFieldState(operation.readContext, normalizedDomainName, normalizedFieldName);
      if (existingField !== null) {
        throw new Error("wallet_field_create_field_exists");
      }

      if (operation.chainDomain.nextFieldId === 0xffff_ffff) {
        throw new Error("wallet_field_create_field_id_exhausted");
      }

      const senderBalance = getBalance(
        operation.readContext.snapshot.state,
        Buffer.from(operation.sender.scriptPubKeyHex, "hex"),
      );
      if (senderBalance < 100n) {
        throw new Error("wallet_field_create_insufficient_cog");
      }

      const intentFingerprintHex = createFieldIntentFingerprint([
        "field-create",
        operation.state.walletRootId,
        normalizedDomainName,
        normalizedFieldName,
        permanent ? 1 : 0,
      ]);
      const conflictCreate = findActiveFieldCreateMutationByDomain(
        operation.state,
        normalizedDomainName,
        intentFingerprintHex,
      );
      if (conflictCreate !== null) {
        throw new Error("wallet_field_create_registration_already_pending");
      }

      return {
        opReturnData: serializeFieldReg(
          operation.chainDomain.domainId,
          permanent,
          normalizedFieldName,
        ).opReturnData,
        mutation: createStandaloneFieldMutation({
          kind: "field-create",
          domainName: normalizedDomainName,
          fieldName: normalizedFieldName,
          sender: operation.sender,
          intentFingerprintHex,
          nowUnixMs,
          feeSelection,
          existing,
          fieldId: operation.chainDomain.nextFieldId,
          fieldPermanent: permanent,
        }),
      };
    },
    async confirm(operation) {
      const fieldRef = `${normalizeFieldDomainName(options.domainName)}:${normalizeFieldNameInput(options.fieldName)}`;
      options.prompter.writeLine(`Creating field "${fieldRef}" as ${permanent ? "permanent" : "mutable"}.`);
      options.prompter.writeLine(`Resolved sender: ${operation.senderSelector} (${operation.sender.address})`);
      options.prompter.writeLine("Path: standalone-field-reg");
      options.prompter.writeLine(`Effect: ${describeFieldEffect({ kind: "create-empty-field", burnCogtoshi: "100" })}.`);
      options.prompter.writeLine("This publishes a standalone FIELD_REG and burns 0.00000100 COG.");

      await confirmYesNo(
        options.prompter,
        "The field will be created empty and the burn is not reversible.",
        "wallet_field_create_confirmation_rejected",
        {
          assumeYes: options.assumeYes,
          requiresTtyErrorCode: "wallet_field_create_requires_tty",
        },
      );
      void createResolvedFieldSenderSummary;
    },
  };
}
