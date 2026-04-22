import type { WalletPrompter } from "../../lifecycle.js";
import { confirmYesNo } from "../confirm.js";

export async function confirmBitcoinTransfer(
  prompter: WalletPrompter,
  options: {
    senderAddress: string;
    recipientAddress: string;
    amountSats: bigint;
    assumeYes?: boolean;
  },
): Promise<void> {
  prompter.writeLine(`You are sending ${options.amountSats.toString()} sats.`);
  prompter.writeLine(`Wallet address: ${options.senderAddress}`);
  prompter.writeLine(`Recipient: ${options.recipientAddress}`);
  await confirmYesNo(prompter, "This will publish a standard Bitcoin payment from the wallet address.", {
    assumeYes: options.assumeYes,
    errorCode: "wallet_bitcoin_transfer_confirmation_rejected",
    requiresTtyErrorCode: "wallet_bitcoin_transfer_requires_tty",
  });
}
