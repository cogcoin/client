import { formatRegisterEconomicEffect, formatRegisterSenderSummary } from "../../mutation-text-format.js";
import {
  workflowMutationNextSteps,
} from "../../mutation-success.js";
import { getRegisterNextSteps } from "../../workflow-hints.js";
import type { WalletMutationCommandSpec } from "./types.js";

export const registerMutationCommandSpec: WalletMutationCommandSpec = {
  id: "register",
  async run(command) {
    const result = await command.context.registerDomain({
      domainName: command.parsed.args[0]!,
      feeRateSatVb: command.parsed.satvb,
      dataDir: command.dataDir,
      databasePath: command.dbPath,
      forceRace: command.parsed.forceRace,
      provider: command.provider,
      prompter: command.prompter,
      assumeYes: command.parsed.assumeYes,
      paths: command.runtimePaths,
    });

    return {
      reusedExisting: result.reusedExisting,
      reusedMessage: "The existing pending registration was reconciled instead of creating a duplicate.",
      fees: result.fees,
      explorerTxid: result.txid,
      nextSteps: workflowMutationNextSteps(
        getRegisterNextSteps(result.domainName, result.registerKind),
      ),
      text: {
        heading: "Registration submitted.",
        fields: [
          { label: "Domain", value: result.domainName },
          { label: "Path", value: result.resolved.path },
          { label: "Parent", value: result.resolved.parentDomainName ?? "", when: result.resolved.parentDomainName !== null },
          { label: "Sender", value: formatRegisterSenderSummary(result) },
          { label: "Economic effect", value: formatRegisterEconomicEffect(result) },
          { label: "Status", value: result.status },
          { label: "Txid", value: result.txid },
        ],
      },
    };
  },
};
