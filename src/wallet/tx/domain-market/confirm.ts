import type { WalletPrompter } from "../../lifecycle.js";
import {
  confirmTypedAcknowledgement,
  confirmYesNo,
} from "../confirm.js";
import type {
  DomainMarketResolvedBuyerSummary,
  DomainMarketResolvedEconomicEffect,
  DomainMarketResolvedRecipientSummary,
  DomainMarketResolvedSenderSummary,
} from "./types.js";
import type { MutationSender } from "../common.js";

export async function confirmTransfer(
  prompter: WalletPrompter,
  domainName: string,
  sender: DomainMarketResolvedSenderSummary,
  recipient: DomainMarketResolvedRecipientSummary,
  economicEffect: DomainMarketResolvedEconomicEffect,
  assumeYes = false,
): Promise<void> {
  prompter.writeLine(`You are transferring "${domainName}".`);
  prompter.writeLine(`Resolved sender: ${sender.selector} (${sender.address})`);
  prompter.writeLine(`Resolved recipient: ${recipient.address ?? `spk:${recipient.scriptPubKeyHex}`}`);
  prompter.writeLine(
    `Economic effect: ${economicEffect.kind === "ownership-transfer" && economicEffect.clearsListing
      ? "transfer domain ownership and clear any active listing."
      : "transfer domain ownership."}`,
  );

  if (recipient.opaque) {
    prompter.writeLine(`Target script length: ${recipient.scriptPubKeyHex.length / 2} bytes`);
    prompter.writeLine("Cogcoin identity is exact raw-script equality. Different script templates are different identities.");
    const acknowledgement = `RAW-SCRIPT:${recipient.scriptPubKeyHex.slice(0, 16)}`;
    await confirmTypedAcknowledgement(prompter, {
      assumeYes,
      expected: acknowledgement,
      prompt: `Type ${acknowledgement} to continue: `,
      errorCode: "wallet_transfer_confirmation_rejected",
      requiresTtyErrorCode: "wallet_transfer_requires_tty",
      typedAckRequiredErrorCode: "wallet_transfer_typed_ack_required",
    });
    return;
  }

  await confirmYesNo(prompter, "This publishes a standalone DOMAIN_TRANSFER.", {
    assumeYes,
    errorCode: "wallet_transfer_confirmation_rejected",
    requiresTtyErrorCode: "wallet_transfer_requires_tty",
  });
}

export async function confirmSell(
  prompter: WalletPrompter,
  domainName: string,
  sender: DomainMarketResolvedSenderSummary,
  listedPriceCogtoshi: bigint,
  assumeYes = false,
): Promise<void> {
  prompter.writeLine(`You are listing "${domainName}".`);
  prompter.writeLine(`Resolved sender: ${sender.selector} (${sender.address})`);
  prompter.writeLine(`Exact listing price: ${listedPriceCogtoshi.toString()} cogtoshi.`);
  prompter.writeLine(`Economic effect: set the listing price to ${listedPriceCogtoshi.toString()} cogtoshi in COG state.`);
  prompter.writeLine("Settlement: entirely in COG state. No BTC payment output will be added.");
  await confirmYesNo(prompter, "This publishes a standalone DOMAIN_SELL mutation.", {
    assumeYes,
    errorCode: "wallet_sell_confirmation_rejected",
    requiresTtyErrorCode: "wallet_sell_requires_tty",
  });
}

export async function confirmBuy(
  prompter: WalletPrompter,
  domainName: string,
  buyerSelector: string,
  buyer: MutationSender,
  sellerScriptPubKeyHex: string,
  sellerAddress: string | null,
  listedPriceCogtoshi: bigint,
  assumeYes = false,
): Promise<void> {
  prompter.writeLine(`You are buying "${domainName}".`);
  prompter.writeLine(`Exact listing price: ${listedPriceCogtoshi.toString()} cogtoshi.`);
  prompter.writeLine(`Resolved buyer: ${buyerSelector} (${buyer.address})`);
  prompter.writeLine(`Resolved seller: ${sellerAddress ?? `spk:${sellerScriptPubKeyHex}`}`);
  prompter.writeLine("Settlement: entirely in COG state. No BTC payment output will be added.");
  await confirmYesNo(prompter, "This publishes a standalone DOMAIN_BUY mutation.", {
    assumeYes,
    errorCode: "wallet_buy_confirmation_rejected",
    requiresTtyErrorCode: "wallet_buy_requires_tty",
  });
}
