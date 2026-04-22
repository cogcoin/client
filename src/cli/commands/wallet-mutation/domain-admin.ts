import {
  formatDomainAdminEffect,
  formatDomainAdminPayloadSummary,
  formatDomainAdminSenderSummary,
  formatDomainAdminTargetSummary,
} from "../../mutation-text-format.js";
import { commandMutationNextSteps } from "../../mutation-success.js";
import type { WalletMutationCommandSpec } from "./types.js";

export const domainAdminMutationCommandSpec: WalletMutationCommandSpec = {
  id: "domain-admin",
  async run(command) {
    if (command.parsed.command === "domain-endpoint-set" || command.parsed.command === "domain-endpoint-clear") {
      const result = command.parsed.command === "domain-endpoint-set"
        ? await command.context.setDomainEndpoint({
          domainName: command.parsed.args[0]!,
          source: command.parsed.endpointText !== null
            ? { kind: "text", value: command.parsed.endpointText }
            : command.parsed.endpointJson !== null
              ? { kind: "json", value: command.parsed.endpointJson }
              : { kind: "bytes", value: command.parsed.endpointBytes! },
          feeRateSatVb: command.parsed.satvb,
          dataDir: command.dataDir,
          databasePath: command.dbPath,
          provider: command.provider,
          prompter: command.prompter,
          assumeYes: command.parsed.assumeYes,
          paths: command.runtimePaths,
        })
        : await command.context.clearDomainEndpoint({
          domainName: command.parsed.args[0]!,
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
        reusedMessage: "The existing pending endpoint mutation was reconciled instead of creating a duplicate.",
        fees: result.fees,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps(`cogcoin show ${result.domainName}`),
        text: {
          heading: command.parsed.command === "domain-endpoint-set"
            ? "Endpoint update submitted."
            : "Endpoint clear submitted.",
          fields: [
            { label: "Domain", value: result.domainName },
            { label: "Sender", value: formatDomainAdminSenderSummary(result) },
            { label: "Payload", value: formatDomainAdminPayloadSummary(result) },
            { label: "Effect", value: formatDomainAdminEffect(result) },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      };
    }

    if (command.parsed.command === "domain-delegate-set" || command.parsed.command === "domain-delegate-clear") {
      const result = command.parsed.command === "domain-delegate-set"
        ? await command.context.setDomainDelegate({
          domainName: command.parsed.args[0]!,
          target: command.parsed.args[1]!,
          feeRateSatVb: command.parsed.satvb,
          dataDir: command.dataDir,
          databasePath: command.dbPath,
          provider: command.provider,
          prompter: command.prompter,
          assumeYes: command.parsed.assumeYes,
          paths: command.runtimePaths,
        })
        : await command.context.clearDomainDelegate({
          domainName: command.parsed.args[0]!,
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
        reusedMessage: "The existing pending delegate mutation was reconciled instead of creating a duplicate.",
        fees: result.fees,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps(`cogcoin show ${result.domainName}`),
        text: {
          heading: command.parsed.command === "domain-delegate-set"
            ? "Delegate update submitted."
            : "Delegate clear submitted.",
          fields: [
            { label: "Domain", value: result.domainName },
            { label: "Sender", value: formatDomainAdminSenderSummary(result) },
            { label: "Target", value: formatDomainAdminTargetSummary(result) },
            { label: "Effect", value: formatDomainAdminEffect(result) },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      };
    }

    if (command.parsed.command === "domain-miner-set" || command.parsed.command === "domain-miner-clear") {
      const result = command.parsed.command === "domain-miner-set"
        ? await command.context.setDomainMiner({
          domainName: command.parsed.args[0]!,
          target: command.parsed.args[1]!,
          feeRateSatVb: command.parsed.satvb,
          dataDir: command.dataDir,
          databasePath: command.dbPath,
          provider: command.provider,
          prompter: command.prompter,
          assumeYes: command.parsed.assumeYes,
          paths: command.runtimePaths,
        })
        : await command.context.clearDomainMiner({
          domainName: command.parsed.args[0]!,
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
        reusedMessage: "The existing pending miner mutation was reconciled instead of creating a duplicate.",
        fees: result.fees,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps(`cogcoin show ${result.domainName}`),
        text: {
          heading: command.parsed.command === "domain-miner-set"
            ? "Miner update submitted."
            : "Miner clear submitted.",
          fields: [
            { label: "Domain", value: result.domainName },
            { label: "Sender", value: formatDomainAdminSenderSummary(result) },
            { label: "Target", value: formatDomainAdminTargetSummary(result) },
            { label: "Effect", value: formatDomainAdminEffect(result) },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      };
    }

    if (command.parsed.command === "domain-canonical") {
      const result = await command.context.setDomainCanonical({
        domainName: command.parsed.args[0]!,
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
        reusedMessage: "The existing pending canonical mutation was reconciled instead of creating a duplicate.",
        fees: result.fees,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps(`cogcoin show ${result.domainName}`),
        text: {
          heading: "Canonical update submitted.",
          fields: [
            { label: "Domain", value: result.domainName },
            { label: "Sender", value: formatDomainAdminSenderSummary(result) },
            { label: "Effect", value: formatDomainAdminEffect(result) },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      };
    }

    throw new Error(`wallet mutation command not implemented: ${command.parsed.command}`);
  },
};
