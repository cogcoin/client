import type { FieldValueInputSource } from "../../../wallet/tx/index.js";
import {
  formatFieldEffect,
  formatFieldPath,
  formatFieldSenderSummary,
  formatFieldValueSummary,
} from "../../mutation-text-format.js";
import {
  commandMutationNextSteps,
  workflowMutationNextSteps,
} from "../../mutation-success.js";
import type { WalletMutationCommandSpec } from "./types.js";

function createFieldValueSource(
  endpointText: string | null,
  endpointJson: string | null,
  endpointBytes: string | null,
  fieldFormat: string | null,
  fieldValue: string | null,
): FieldValueInputSource {
  if (endpointText !== null) {
    return { kind: "text", value: endpointText };
  }

  if (endpointJson !== null) {
    return { kind: "json", value: endpointJson };
  }

  if (endpointBytes !== null) {
    return { kind: "bytes", value: endpointBytes };
  }

  return {
    kind: "raw",
    format: fieldFormat!,
    value: fieldValue!,
  };
}

export const fieldMutationCommandSpec: WalletMutationCommandSpec = {
  id: "field",
  async run(command) {
    if (command.parsed.command === "field-create") {
      const result = await command.context.createField({
        domainName: command.parsed.args[0]!,
        fieldName: command.parsed.args[1]!,
        permanent: command.parsed.fieldPermanent,
        feeRateSatVb: command.parsed.satvb,
        dataDir: command.dataDir,
        databasePath: command.dbPath,
        provider: command.provider,
        prompter: command.prompter,
        assumeYes: command.parsed.assumeYes,
        paths: command.runtimePaths,
      });

      return {
        reusedExisting: result.reusedExisting,
        reusedMessage: "The existing pending field creation was reconciled instead of creating a duplicate.",
        fees: result.fees,
        explorerTxid: result.txid,
        nextSteps: workflowMutationNextSteps([
          `cogcoin field show ${result.domainName} ${result.fieldName}`,
          `cogcoin field set ${result.domainName} ${result.fieldName} --text <value>`,
        ]),
        text: {
          heading: "Field creation submitted.",
          fields: [
            { label: "Domain", value: result.domainName },
            { label: "Field", value: result.fieldName },
            { label: "Sender", value: formatFieldSenderSummary(result) },
            { label: "Path", value: formatFieldPath(result) },
            { label: "Value", value: formatFieldValueSummary(result), when: result.resolved?.value !== null && result.resolved?.value !== undefined },
            { label: "Effect", value: formatFieldEffect(result) },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      };
    }

    if (command.parsed.command === "field-set") {
      const result = await command.context.setField({
        domainName: command.parsed.args[0]!,
        fieldName: command.parsed.args[1]!,
        source: createFieldValueSource(
          command.parsed.endpointText,
          command.parsed.endpointJson,
          command.parsed.endpointBytes,
          command.parsed.fieldFormat,
          command.parsed.fieldValue,
        ),
        feeRateSatVb: command.parsed.satvb,
        dataDir: command.dataDir,
        databasePath: command.dbPath,
        provider: command.provider,
        prompter: command.prompter,
        assumeYes: command.parsed.assumeYes,
        paths: command.runtimePaths,
      });

      return {
        reusedExisting: result.reusedExisting,
        reusedMessage: "The existing pending field update was reconciled instead of creating a duplicate.",
        fees: result.fees,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps(`cogcoin field show ${result.domainName} ${result.fieldName}`),
        text: {
          heading: "Field update submitted.",
          fields: [
            { label: "Domain", value: result.domainName },
            { label: "Field", value: result.fieldName },
            { label: "Sender", value: formatFieldSenderSummary(result) },
            { label: "Value", value: formatFieldValueSummary(result) },
            { label: "Effect", value: formatFieldEffect(result) },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      };
    }

    if (command.parsed.command === "field-clear") {
      const result = await command.context.clearField({
        domainName: command.parsed.args[0]!,
        fieldName: command.parsed.args[1]!,
        feeRateSatVb: command.parsed.satvb,
        dataDir: command.dataDir,
        databasePath: command.dbPath,
        provider: command.provider,
        prompter: command.prompter,
        assumeYes: command.parsed.assumeYes,
        paths: command.runtimePaths,
      });

      return {
        reusedExisting: result.reusedExisting,
        reusedMessage: "The existing pending field clear was reconciled instead of creating a duplicate.",
        fees: result.fees,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps(`cogcoin field show ${result.domainName} ${result.fieldName}`),
        text: {
          heading: "Field clear submitted.",
          fields: [
            { label: "Domain", value: result.domainName },
            { label: "Field", value: result.fieldName },
            { label: "Sender", value: formatFieldSenderSummary(result) },
            { label: "Effect", value: formatFieldEffect(result) },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      };
    }

    throw new Error(`wallet mutation command not implemented: ${command.parsed.command}`);
  },
};
