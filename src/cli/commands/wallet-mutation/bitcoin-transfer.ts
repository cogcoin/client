import {
  workflowMutationNextSteps,
} from "../../mutation-success.js";
import type { WalletMutationCommandSpec } from "./types.js";

export const bitcoinTransferCommandSpec: WalletMutationCommandSpec = {
  id: "bitcoin-transfer",
  async run(command) {
    const result = await command.context.transferBitcoin({
      amountSatsText: command.parsed.args[0]!,
      target: command.parsed.transferTarget!,
      dataDir: command.dataDir,
      databasePath: command.dbPath,
      provider: command.provider,
      prompter: command.prompter,
      assumeYes: command.parsed.assumeYes,
      paths: command.runtimePaths,
    });

    return {
      reusedExisting: false,
      reusedMessage: "",
      explorerTxid: result.txid,
      nextSteps: workflowMutationNextSteps([]),
      text: {
        heading: "Bitcoin transfer submitted.",
        fields: [
          { label: "Sender", value: result.senderAddress },
          { label: "Recipient", value: result.recipientAddress },
          { label: "Amount", value: `${result.amountSats.toString()} sats` },
          { label: "Fee", value: `${result.feeSats.toString()} sats` },
          { label: "Txid", value: result.txid },
        ],
      },
    };
  },
};
