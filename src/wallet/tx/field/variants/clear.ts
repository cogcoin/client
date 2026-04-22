import { FIELD_FORMAT_BYTES, serializeDataUpdate } from "../../../cogop/index.js";
import {
  createFieldIntentFingerprint,
  normalizeFieldDomainName,
  normalizeFieldNameInput,
} from "../intent.js";
import {
  createStandaloneFieldMutation,
  getObservedFieldState,
} from "../draft.js";
import { describeFieldEffect } from "../result.js";
import type {
  ClearFieldOptions,
  FieldMutationVariant,
} from "../types.js";

export function createClearFieldVariant(
  options: ClearFieldOptions,
): FieldMutationVariant {
  return {
    kind: "field-clear",
    errorPrefix: "wallet_field_clear",
    async createMutation({ operation, existing, feeSelection, nowUnixMs }) {
      const normalizedDomainName = normalizeFieldDomainName(options.domainName);
      const normalizedFieldName = normalizeFieldNameInput(options.fieldName);
      const observedField = getObservedFieldState(operation.readContext, normalizedDomainName, normalizedFieldName);
      if (observedField === null) {
        throw new Error("wallet_field_clear_field_not_found");
      }
      if (observedField.permanent && !observedField.hasValue) {
        throw new Error("wallet_field_clear_noop_permanent_clear");
      }

      const intentFingerprintHex = createFieldIntentFingerprint([
        "field-clear",
        operation.state.walletRootId,
        normalizedDomainName,
        observedField.fieldId,
      ]);
      return {
        opReturnData: serializeDataUpdate(
          operation.chainDomain.domainId,
          observedField.fieldId,
          FIELD_FORMAT_BYTES.clear,
        ).opReturnData,
        mutation: createStandaloneFieldMutation({
          kind: "field-clear",
          domainName: normalizedDomainName,
          fieldName: normalizedFieldName,
          sender: operation.sender,
          intentFingerprintHex,
          nowUnixMs,
          feeSelection,
          existing,
          fieldId: observedField.fieldId,
          fieldPermanent: observedField.permanent,
          fieldFormat: FIELD_FORMAT_BYTES.clear,
          fieldValueHex: "",
        }),
      };
    },
    async confirm(operation) {
      const normalizedDomainName = normalizeFieldDomainName(options.domainName);
      const normalizedFieldName = normalizeFieldNameInput(options.fieldName);
      const observedField = getObservedFieldState(operation.readContext, normalizedDomainName, normalizedFieldName);
      if (observedField === null) {
        throw new Error("wallet_field_clear_field_not_found");
      }
      if (observedField.permanent && !observedField.hasValue) {
        throw new Error("wallet_field_clear_noop_permanent_clear");
      }
      options.prompter.writeLine(`Clearing field "${normalizedDomainName}:${normalizedFieldName}".`);
      options.prompter.writeLine(`Resolved sender: ${operation.senderSelector} (${operation.sender.address})`);
      options.prompter.writeLine("Path: standalone-data-clear");
      options.prompter.writeLine(`Effect: ${describeFieldEffect({ kind: "clear-field-value", burnCogtoshi: "0" })}.`);
      options.prompter.writeLine("This publishes a standalone DATA_UPDATE clear.");
    },
  };
}
