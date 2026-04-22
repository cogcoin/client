import { parseCogAmountToCogtoshi } from "../../../wallet/tx/index.js";
import {
  formatReputationEffect,
  formatReputationReviewSummary,
  formatReputationSenderSummary,
} from "../../mutation-text-format.js";
import { commandMutationNextSteps } from "../../mutation-success.js";
import type { WalletMutationCommandSpec } from "./types.js";

export const reputationMutationCommandSpec: WalletMutationCommandSpec = {
  id: "reputation",
  async run(command) {
    const result = command.parsed.command === "rep-give"
      ? await command.context.giveReputation({
        sourceDomainName: command.parsed.args[0]!,
        targetDomainName: command.parsed.args[1]!,
        amountCogtoshi: parseCogAmountToCogtoshi(command.parsed.args[2]!),
        reviewText: command.parsed.reviewText,
        feeRateSatVb: command.parsed.satvb,
        dataDir: command.dataDir,
        databasePath: command.dbPath,
        provider: command.provider,
        prompter: command.prompter,
        assumeYes: command.parsed.assumeYes,
        paths: command.runtimePaths,
      })
      : await command.context.revokeReputation({
        sourceDomainName: command.parsed.args[0]!,
        targetDomainName: command.parsed.args[1]!,
        amountCogtoshi: parseCogAmountToCogtoshi(command.parsed.args[2]!),
        reviewText: command.parsed.reviewText,
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
      reusedMessage: "The existing pending reputation mutation was reconciled instead of creating a duplicate.",
      fees: result.fees,
      explorerTxid: result.txid,
      nextSteps: commandMutationNextSteps(`cogcoin show ${result.targetDomainName}`),
      text: {
        heading: command.parsed.command === "rep-give"
          ? "Reputation support submitted."
          : "Reputation revoke submitted.",
        fields: [
          { label: "Source domain", value: result.sourceDomainName },
          { label: "Target domain", value: result.targetDomainName },
          { label: "Sender", value: formatReputationSenderSummary(result) },
          { label: "Amount", value: `${result.amountCogtoshi.toString()} cogtoshi` },
          { label: "Review", value: formatReputationReviewSummary(result) },
          { label: "Effect", value: formatReputationEffect(result) },
          { label: "Status", value: result.status },
          { label: "Txid", value: result.txid },
        ],
      },
    };
  },
};
