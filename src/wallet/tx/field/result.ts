import type { PendingMutationRecord } from "../../types.js";
import type {
  FieldMutationKind,
  FieldMutationResult,
  FieldResolvedEffect,
  FieldResolvedSenderSummary,
  FieldResolvedSummary,
  FieldResolvedValueSummary,
  StandaloneFieldMutationOperation,
} from "./types.js";
import type {
  MutationSender,
  WalletMutationFeeSummary,
} from "../common.js";

export function createResolvedFieldSenderSummary(
  sender: MutationSender,
  selector: string,
): FieldResolvedSenderSummary {
  return {
    selector,
    localIndex: sender.localIndex,
    scriptPubKeyHex: sender.scriptPubKeyHex,
    address: sender.address,
  };
}

export function createResolvedFieldValueSummary(
  format: number,
  value: Uint8Array | string,
): FieldResolvedValueSummary {
  return {
    format,
    byteLength: typeof value === "string" ? value.length / 2 : value.length,
  };
}

export function createResolvedFieldSummary(options: {
  sender: MutationSender;
  senderSelector: string;
  kind: FieldMutationKind;
  value: FieldResolvedValueSummary | null;
}): FieldResolvedSummary {
  if (options.kind === "field-create") {
    return {
      sender: createResolvedFieldSenderSummary(options.sender, options.senderSelector),
      path: "standalone-field-reg",
      value: null,
      effect: {
        kind: "create-empty-field",
        burnCogtoshi: "100",
      },
    };
  }

  if (options.kind === "field-set") {
    return {
      sender: createResolvedFieldSenderSummary(options.sender, options.senderSelector),
      path: "standalone-data-update",
      value: options.value,
      effect: {
        kind: "write-field-value",
        burnCogtoshi: "1",
      },
    };
  }

  return {
    sender: createResolvedFieldSenderSummary(options.sender, options.senderSelector),
    path: "standalone-data-clear",
    value: null,
    effect: {
      kind: "clear-field-value",
      burnCogtoshi: "0",
    },
  };
}

export function createResolvedFieldValueFromStoredData(
  kind: FieldMutationKind,
  format: number | null | undefined,
  valueHex: string | null | undefined,
): FieldResolvedValueSummary | null {
  if (kind === "field-clear" || format === null || format === undefined || valueHex === null || valueHex === undefined) {
    return null;
  }

  return createResolvedFieldValueSummary(format, valueHex);
}

export function describeFieldEffect(effect: FieldResolvedEffect): string {
  switch (effect.kind) {
    case "create-empty-field":
      return `burn ${effect.burnCogtoshi} cogtoshi to create an empty field`;
    case "write-field-value":
      return `burn ${effect.burnCogtoshi} cogtoshi to write the field value`;
    case "clear-field-value":
      return "clear the field value with no additional COG burn";
  }
}

export function createFieldReuseResult(options: {
  kind: FieldMutationKind;
  operation: StandaloneFieldMutationOperation;
  mutation: PendingMutationRecord;
  resolution: "confirmed" | "live";
  fees: WalletMutationFeeSummary;
}): FieldMutationResult {
  return {
    kind: options.kind,
    domainName: options.operation.normalizedDomainName,
    fieldName: options.operation.normalizedFieldName,
    fieldId: options.mutation.fieldId ?? options.operation.existingObservedField?.fieldId ?? null,
    txid: options.mutation.attemptedTxid ?? "unknown",
    permanent: options.mutation.fieldPermanent ?? options.operation.existingObservedField?.permanent ?? null,
    format: options.mutation.fieldFormat ?? options.operation.existingObservedField?.format ?? null,
    status: options.resolution,
    reusedExisting: true,
    resolved: createResolvedFieldSummary({
      sender: options.operation.sender,
      senderSelector: options.operation.senderSelector,
      kind: options.kind,
      value: createResolvedFieldValueFromStoredData(
        options.kind,
        options.mutation.fieldFormat ?? options.operation.existingObservedField?.format ?? null,
        options.mutation.fieldValueHex,
      ),
    }),
    fees: options.fees,
  };
}

export function createFieldResult(options: {
  kind: FieldMutationKind;
  operation: StandaloneFieldMutationOperation;
  mutation: PendingMutationRecord;
  builtTxid: string | null;
  status: "live" | "confirmed";
  reusedExisting: boolean;
  fees: WalletMutationFeeSummary;
}): FieldMutationResult {
  return {
    kind: options.kind,
    domainName: options.operation.normalizedDomainName,
    fieldName: options.operation.normalizedFieldName,
    fieldId: options.mutation.fieldId ?? options.operation.existingObservedField?.fieldId ?? null,
    txid: options.mutation.attemptedTxid ?? options.builtTxid ?? "unknown",
    permanent: options.mutation.fieldPermanent ?? options.operation.existingObservedField?.permanent ?? null,
    format: options.mutation.fieldFormat ?? options.operation.existingObservedField?.format ?? null,
    status: options.status,
    reusedExisting: options.reusedExisting,
    resolved: createResolvedFieldSummary({
      sender: options.operation.sender,
      senderSelector: options.operation.senderSelector,
      kind: options.kind,
      value: createResolvedFieldValueFromStoredData(
        options.kind,
        options.mutation.fieldFormat ?? options.operation.existingObservedField?.format ?? null,
        options.mutation.fieldValueHex,
      ),
    }),
    fees: options.fees,
  };
}
