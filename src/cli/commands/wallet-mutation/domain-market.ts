import { parseCogAmountToCogtoshi } from "../../../wallet/tx/index.js";
import {
  formatBuyBuyerSummary,
  formatBuySellerSummary,
  formatBuySettlementSummary,
  formatDomainMarketEconomicEffect,
  formatDomainMarketRecipientSummary,
  formatDomainMarketSenderSummary,
} from "../../mutation-text-format.js";
import {
  commandMutationNextSteps,
} from "../../mutation-success.js";
import type { WalletMutationCommandSpec } from "./types.js";

export const domainMarketMutationCommandSpec: WalletMutationCommandSpec = {
  id: "domain-market",
  async run(command) {
    if (command.parsed.command === "transfer") {
      const result = await command.context.transferDomain({
        domainName: command.parsed.args[0]!,
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
        reusedMessage: "The existing pending transfer was reconciled instead of creating a duplicate.",
        fees: result.fees,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps(`cogcoin show ${result.domainName}`),
        text: {
          heading: "Transfer submitted.",
          fields: [
            { label: "Domain", value: result.domainName },
            { label: "Sender", value: formatDomainMarketSenderSummary(result) },
            { label: "Recipient", value: formatDomainMarketRecipientSummary(result) },
            { label: "Economic effect", value: formatDomainMarketEconomicEffect(result) },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      };
    }

    if (command.parsed.command === "sell" || command.parsed.command === "unsell") {
      const listedPriceCogtoshi = command.parsed.command === "unsell"
        ? 0n
        : parseCogAmountToCogtoshi(command.parsed.args[1]!);
      const result = await command.context.sellDomain({
        domainName: command.parsed.args[0]!,
        listedPriceCogtoshi,
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
        reusedMessage: "The existing pending listing mutation was reconciled instead of creating a duplicate.",
        fees: result.fees,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps(`cogcoin show ${result.domainName}`),
        text: {
          heading: result.listedPriceCogtoshi === 0n
            ? "Listing cancellation submitted."
            : "Listing submitted.",
          fields: [
            { label: "Domain", value: result.domainName },
            { label: "Sender", value: formatDomainMarketSenderSummary(result) },
            { label: "Price", value: `${result.listedPriceCogtoshi?.toString() ?? "0"} cogtoshi` },
            { label: "Economic effect", value: formatDomainMarketEconomicEffect(result) },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      };
    }

    if (command.parsed.command === "buy") {
      const result = await command.context.buyDomain({
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
        reusedMessage: "The existing pending purchase was reconciled instead of creating a duplicate.",
        fees: result.fees,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps(`cogcoin show ${result.domainName}`),
        text: {
          heading: "Purchase submitted.",
          fields: [
            { label: "Domain", value: result.domainName },
            { label: "Buyer", value: formatBuyBuyerSummary(result) },
            { label: "Seller", value: formatBuySellerSummary(result) },
            { label: "Price", value: `${result.listedPriceCogtoshi?.toString() ?? "unknown"} cogtoshi` },
            { label: "Settlement", value: formatBuySettlementSummary() },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      };
    }

    throw new Error(`wallet mutation command not implemented: ${command.parsed.command}`);
  },
};
