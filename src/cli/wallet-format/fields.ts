import {
  findDomainField,
  formatFieldFormat,
  listDomainFields,
} from "../../wallet/read/index.js";
import type {
  WalletFieldView,
  WalletReadContext,
} from "../../wallet/read/index.js";
import { formatServiceHealth } from "./shared.js";
import { listPendingFieldMutations } from "./pending.js";

function renderFieldLine(field: WalletFieldView): string {
  return `${field.name}  id ${field.fieldId}  ${field.permanent ? "permanent" : "mutable"}  ${field.hasValue ? formatFieldFormat(field.format) : "empty"}  ${field.preview ?? "(no value)"}`;
}

export function formatFieldsReport(
  context: WalletReadContext,
  domainName: string,
  options: {
    limit?: number | null;
    all?: boolean;
  } = {},
): string {
  const lines = [`Fields: ${domainName}`];

  if (context.snapshot === null) {
    lines.push(`Field state is unavailable while the indexer is ${formatServiceHealth(context.indexer.health)}.`);
    return lines.join("\n");
  }

  const fields = listDomainFields(context, domainName);

  if (fields === null) {
    lines.push("Domain not found.");
    return lines.join("\n");
  }

  const renderedFields = options.all || options.limit === null || options.limit === undefined
    ? fields
    : fields.slice(0, options.limit);

  if (renderedFields.length === 0) {
    lines.push("No fields found.");
  } else {
    for (const field of renderedFields) {
      lines.push(renderFieldLine(field));
    }
  }

  for (const mutation of listPendingFieldMutations(context, domainName)) {
    lines.push(`Pending field mutation: ${mutation.fieldName ?? "unknown"}  ${mutation.kind}  ${mutation.status}`);
  }

  if (!options.all && options.limit !== null && options.limit !== undefined && fields.length > options.limit) {
    lines.push(`Showing first ${renderedFields.length} of ${fields.length}. Use --limit <n> or --all for more.`);
  }

  return lines.join("\n");
}

export function formatFieldReport(
  context: WalletReadContext,
  domainName: string,
  fieldName: string,
): string {
  const lines = [`Field: ${domainName}.${fieldName}`];

  if (context.snapshot === null) {
    lines.push(`Field state is unavailable while the indexer is ${formatServiceHealth(context.indexer.health)}.`);
    return lines.join("\n");
  }

  const field = findDomainField(context, domainName, fieldName);
  const pendingMutations = listPendingFieldMutations(context, domainName, fieldName);

  if (field === null) {
    lines.push("Field not found.");
  } else {
    lines.push(`Domain ID: ${field.domainId}`);
    lines.push(`Field ID: ${field.fieldId}`);
    lines.push(`Permanent: ${field.permanent ? "yes" : "no"}`);
    lines.push(`Has value: ${field.hasValue ? "yes" : "no"}`);
    lines.push(`Format: ${formatFieldFormat(field.format)}`);
    lines.push(`Preview: ${field.preview ?? "(no value)"}`);
    lines.push(`Raw value hex: ${field.rawValueHex ?? "none"}`);
  }

  for (const mutation of pendingMutations) {
    lines.push(`Pending field mutation: ${mutation.kind}  ${mutation.status}`);
  }

  return lines.join("\n");
}
