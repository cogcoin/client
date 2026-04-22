import {
  workflowMutationNextSteps,
} from "../../mutation-success.js";
import { getAnchorNextSteps } from "../../workflow-hints.js";
import type { WalletMutationCommandSpec } from "./types.js";

export const anchorMutationCommandSpec: WalletMutationCommandSpec = {
  id: "anchor",
  async run(command) {
    const result = await command.context.anchorDomain({
      domainName: command.parsed.args[0]!,
      foundingMessageText: command.parsed.anchorMessage,
      promptForFoundingMessageWhenMissing: command.parsed.anchorMessage === null,
      feeRateSatVb: command.parsed.satvb,
      dataDir: command.dataDir,
      databasePath: command.dbPath,
      provider: command.provider,
      prompter: command.prompter,
      paths: command.runtimePaths,
    });

    return {
      reusedExisting: result.reusedExisting,
      reusedMessage: "The existing pending anchor was reconciled instead of creating a duplicate.",
      fees: result.fees,
      explorerTxid: result.txid,
      nextSteps: workflowMutationNextSteps(getAnchorNextSteps(result.domainName)),
      text: {
        heading: "Anchor submitted.",
        fields: [
          { label: "Domain", value: result.domainName },
          { label: "Status", value: result.status },
          { label: "Txid", value: result.txid },
        ],
      },
    };
  },
};
