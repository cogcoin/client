import { parseCogAmountToCogtoshi } from "../../../wallet/tx/index.js";
import {
  formatCogClaimPath,
  formatCogSenderSummary,
} from "../../mutation-text-format.js";
import { commandMutationNextSteps } from "../../mutation-success.js";
import type { WalletMutationCommandSpec } from "./types.js";

export const cogMutationCommandSpec: WalletMutationCommandSpec = {
  id: "cog",
  async run(command) {
    if (command.parsed.command === "send") {
      const result = await command.context.sendCog({
        amountCogtoshi: parseCogAmountToCogtoshi(command.parsed.args[0]!),
        target: command.parsed.transferTarget!,
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
        reusedMessage: "The existing pending COG transfer was reconciled instead of creating a duplicate.",
        fees: result.fees,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps("cogcoin balance"),
        text: {
          heading: "COG transfer submitted.",
          fields: [
            { label: "Sender", value: formatCogSenderSummary(result) },
            { label: "Amount", value: `${result.amountCogtoshi?.toString() ?? "unknown"} cogtoshi` },
            { label: "Recipient", value: result.recipientScriptPubKeyHex === null || result.recipientScriptPubKeyHex === undefined ? "unknown" : `spk:${result.recipientScriptPubKeyHex}` },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      };
    }

    if (command.parsed.command === "cog-lock") {
      const result = await command.context.lockCogToDomain({
        amountCogtoshi: parseCogAmountToCogtoshi(command.parsed.args[0]!),
        recipientDomainName: command.parsed.lockRecipientDomain!,
        timeoutBlocksOrDuration: command.parsed.unlockFor,
        timeoutHeight: command.parsed.untilHeight === null ? null : Number.parseInt(command.parsed.untilHeight, 10),
        conditionHex: command.parsed.conditionHex!,
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
        reusedMessage: "The existing pending lock was reconciled instead of creating a duplicate.",
        fees: result.fees,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps("cogcoin locks"),
        text: {
          heading: "COG lock submitted.",
          fields: [
            { label: "Sender", value: formatCogSenderSummary(result) },
            { label: "Amount", value: `${result.amountCogtoshi?.toString() ?? "unknown"} cogtoshi` },
            { label: "Recipient domain", value: result.recipientDomainName ?? "unknown" },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      };
    }

    if (command.parsed.command === "claim") {
      const result = await command.context.claimCogLock({
        lockId: Number.parseInt(command.parsed.args[0]!, 10),
        preimageHex: command.parsed.preimageHex!,
        feeRateSatVb: command.parsed.satvb,
        dataDir: command.dataDir,
        databasePath: command.dbPath,
        provider: command.provider,
        prompter: command.prompter,
        paths: command.runtimePaths,
      });

      return {
        reusedExisting: result.reusedExisting,
        reusedMessage: "The existing pending claim was reconciled instead of creating a duplicate.",
        fees: result.fees,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps("cogcoin locks --claimable"),
        text: {
          heading: "Lock claim submitted.",
          fields: [
            { label: "Lock", value: String(result.lockId ?? "unknown") },
            { label: "Path", value: formatCogClaimPath(result) },
            { label: "Sender", value: formatCogSenderSummary(result) },
            { label: "Amount", value: `${result.amountCogtoshi?.toString() ?? "unknown"} cogtoshi` },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      };
    }

    if (command.parsed.command === "reclaim") {
      const result = await command.context.reclaimCogLock({
        lockId: Number.parseInt(command.parsed.args[0]!, 10),
        feeRateSatVb: command.parsed.satvb,
        dataDir: command.dataDir,
        databasePath: command.dbPath,
        provider: command.provider,
        prompter: command.prompter,
        paths: command.runtimePaths,
      });

      return {
        reusedExisting: result.reusedExisting,
        reusedMessage: "The existing pending reclaim was reconciled instead of creating a duplicate.",
        fees: result.fees,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps("cogcoin locks --reclaimable"),
        text: {
          heading: "Lock reclaim submitted.",
          fields: [
            { label: "Lock", value: String(result.lockId ?? "unknown") },
            { label: "Path", value: formatCogClaimPath(result) },
            { label: "Sender", value: formatCogSenderSummary(result) },
            { label: "Amount", value: `${result.amountCogtoshi?.toString() ?? "unknown"} cogtoshi` },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      };
    }

    throw new Error(`wallet mutation command not implemented: ${command.parsed.command}`);
  },
};
