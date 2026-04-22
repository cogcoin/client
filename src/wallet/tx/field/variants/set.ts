import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import {
  FIELD_FORMAT_BYTES,
  serializeDataUpdate,
} from "../../../cogop/index.js";
import { getBalance } from "@cogcoin/indexer/queries";
import {
  confirmTyped,
  confirmYesNo,
} from "../confirm.js";
import {
  createFieldIntentFingerprint,
  normalizeFieldDomainName,
  normalizeFieldNameInput,
} from "../intent.js";
import {
  createStandaloneFieldMutation,
  getObservedFieldState,
} from "../draft.js";
import {
  describeFieldEffect,
} from "../result.js";
import type {
  FieldMutationVariant,
  FieldValueInputSource,
  NormalizedFieldValue,
  SetFieldOptions,
} from "../types.js";

function describeRawFormat(format: number): string {
  if (format === FIELD_FORMAT_BYTES.bytes) {
    return "bytes (0x01)";
  }
  if (format === FIELD_FORMAT_BYTES.text) {
    return "text (0x02)";
  }
  if (format === FIELD_FORMAT_BYTES.json) {
    return "json (0x09)";
  }
  return `raw (0x${format.toString(16).padStart(2, "0")})`;
}

async function loadFieldValue(
  source: FieldValueInputSource,
): Promise<NormalizedFieldValue> {
  if (source.kind === "text") {
    if (source.value.length === 0) {
      throw new Error("wallet_field_value_missing");
    }
    const value = new TextEncoder().encode(source.value);
    return {
      format: FIELD_FORMAT_BYTES.text,
      formatLabel: "text (0x02)",
      value,
      valueHex: Buffer.from(value).toString("hex"),
    };
  }

  if (source.kind === "json") {
    if (source.value.length === 0) {
      throw new Error("wallet_field_value_missing");
    }
    try {
      JSON.parse(source.value);
    } catch {
      throw new Error("wallet_field_invalid_json");
    }
    const value = new TextEncoder().encode(source.value);
    return {
      format: FIELD_FORMAT_BYTES.json,
      formatLabel: "json (0x09)",
      value,
      valueHex: Buffer.from(value).toString("hex"),
    };
  }

  if (source.kind === "bytes") {
    let value: Buffer;

    if (source.value.startsWith("hex:")) {
      const payload = source.value.slice(4);
      if (!/^[0-9a-f]+$/.test(payload) || payload.length % 2 !== 0) {
        throw new Error("wallet_field_invalid_bytes");
      }
      value = Buffer.from(payload, "hex");
    } else if (source.value.startsWith("@")) {
      const filePath = source.value.slice(1);
      if (filePath.trim() === "") {
        throw new Error("wallet_field_invalid_bytes");
      }
      value = await readFile(resolvePath(process.cwd(), filePath));
    } else {
      throw new Error("wallet_field_invalid_bytes");
    }

    if (value.length === 0) {
      throw new Error("wallet_field_value_missing");
    }

    return {
      format: FIELD_FORMAT_BYTES.bytes,
      formatLabel: "bytes (0x01)",
      value,
      valueHex: value.toString("hex"),
    };
  }

  const match = /^raw:(\d{1,3})$/.exec(source.format);
  if (match == null) {
    throw new Error("wallet_field_invalid_raw_format");
  }

  const format = Number.parseInt(match[1]!, 10);
  if (!Number.isInteger(format) || format < 0 || format > 0xff || format === FIELD_FORMAT_BYTES.clear) {
    throw new Error("wallet_field_invalid_raw_format");
  }

  let value: Uint8Array;

  if (source.value.startsWith("hex:")) {
    const payload = source.value.slice(4);
    if (!/^[0-9a-f]+$/.test(payload) || payload.length % 2 !== 0) {
      throw new Error("wallet_field_invalid_value");
    }
    value = Buffer.from(payload, "hex");
  } else if (source.value.startsWith("@")) {
    const filePath = source.value.slice(1);
    if (filePath.trim() === "") {
      throw new Error("wallet_field_invalid_value");
    }
    value = await readFile(resolvePath(process.cwd(), filePath));
  } else if (source.value.startsWith("utf8:")) {
    value = new TextEncoder().encode(source.value.slice(5));
  } else {
    throw new Error("wallet_field_invalid_value");
  }

  if (value.length === 0) {
    throw new Error("wallet_field_value_missing");
  }

  return {
    format,
    formatLabel: describeRawFormat(format),
    value,
    valueHex: Buffer.from(value).toString("hex"),
  };
}

export async function createSetFieldVariant(
  options: SetFieldOptions,
): Promise<FieldMutationVariant> {
  const value = await loadFieldValue(options.source);

  return {
    kind: "field-set",
    errorPrefix: "wallet_field_set",
    async createMutation({ operation, existing, feeSelection, nowUnixMs }) {
      const normalizedDomainName = normalizeFieldDomainName(options.domainName);
      const normalizedFieldName = normalizeFieldNameInput(options.fieldName);
      const observedField = getObservedFieldState(operation.readContext, normalizedDomainName, normalizedFieldName);
      if (observedField === null) {
        throw new Error("wallet_field_set_field_not_found");
      }
      if (observedField.permanent && observedField.hasValue) {
        throw new Error("wallet_field_set_permanent_field_frozen");
      }

      const senderBalance = getBalance(
        operation.readContext.snapshot.state,
        Buffer.from(operation.sender.scriptPubKeyHex, "hex"),
      );
      if (senderBalance < 1n) {
        throw new Error("wallet_field_set_insufficient_cog");
      }

      const intentFingerprintHex = createFieldIntentFingerprint([
        "field-set",
        operation.state.walletRootId,
        normalizedDomainName,
        observedField.fieldId,
        value.format,
        value.valueHex,
      ]);
      return {
        opReturnData: serializeDataUpdate(
          operation.chainDomain.domainId,
          observedField.fieldId,
          value.format,
          value.value,
        ).opReturnData,
        mutation: createStandaloneFieldMutation({
          kind: "field-set",
          domainName: normalizedDomainName,
          fieldName: normalizedFieldName,
          sender: operation.sender,
          intentFingerprintHex,
          nowUnixMs,
          feeSelection,
          existing,
          fieldId: observedField.fieldId,
          fieldPermanent: observedField.permanent,
          fieldFormat: value.format,
          fieldValueHex: value.valueHex,
        }),
      };
    },
    async confirm(operation) {
      const normalizedDomainName = normalizeFieldDomainName(options.domainName);
      const normalizedFieldName = normalizeFieldNameInput(options.fieldName);
      const observedField = getObservedFieldState(operation.readContext, normalizedDomainName, normalizedFieldName);
      if (observedField === null) {
        throw new Error("wallet_field_set_field_not_found");
      }
      const fieldRef = `${normalizedDomainName}:${normalizedFieldName}`;
      options.prompter.writeLine(`Updating field "${fieldRef}".`);
      options.prompter.writeLine(`Resolved sender: ${operation.senderSelector} (${operation.sender.address})`);
      options.prompter.writeLine("Path: standalone-data-update");
      options.prompter.writeLine(`Effect: ${describeFieldEffect({ kind: "write-field-value", burnCogtoshi: "1" })}.`);
      options.prompter.writeLine(`Format: ${value.formatLabel}`);
      options.prompter.writeLine(`Value bytes: ${value.value.length}`);
      options.prompter.writeLine("Warning: the field value is public in the mempool and on-chain.");

      if (observedField.permanent && !observedField.hasValue) {
        options.prompter.writeLine("This is the first non-clear value write to a permanent field.");
        await confirmTyped(
          options.prompter,
          fieldRef,
          `Type ${fieldRef} to continue: `,
          "wallet_field_set_confirmation_rejected",
          {
            assumeYes: options.assumeYes,
            requiresTtyErrorCode: "wallet_field_set_requires_tty",
            typedAckRequiredErrorCode: "wallet_field_set_typed_ack_required",
          },
        );
        return;
      }

      await confirmYesNo(
        options.prompter,
        "This publishes a standalone DATA_UPDATE.",
        "wallet_field_set_confirmation_rejected",
        {
          assumeYes: options.assumeYes,
          requiresTtyErrorCode: "wallet_field_set_requires_tty",
        },
      );
    },
  };
}
