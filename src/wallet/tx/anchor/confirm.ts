import { encodeSentence } from "@cogcoin/scoring";

import type { WalletPrompter } from "../../lifecycle.js";

export interface AnchorFoundingMessage {
  text: string | null;
  payloadHex: string | null;
}

function encodeFoundingMessage(
  foundingMessageText: string | null | undefined,
): Promise<AnchorFoundingMessage> {
  const trimmed = foundingMessageText?.trim() ?? "";
  if (trimmed === "") {
    return Promise.resolve({
      text: null,
      payloadHex: null,
    });
  }

  return encodeSentence(trimmed)
    .then((payload) => ({
      text: trimmed,
      payloadHex: Buffer.from(payload).toString("hex"),
    }))
    .catch((error) => {
      throw new Error(error instanceof Error ? `wallet_anchor_invalid_message_${error.message}` : "wallet_anchor_invalid_message");
    });
}

function extractAnchorInvalidMessageReason(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);

  if (message === "wallet_anchor_invalid_message") {
    return null;
  }

  if (!message.startsWith("wallet_anchor_invalid_message_")) {
    return null;
  }

  const reason = message.slice("wallet_anchor_invalid_message_".length).trim();
  return reason === "" ? null : reason;
}

export async function resolveFoundingMessage(options: {
  foundingMessageText: string | null | undefined;
  promptForFoundingMessageWhenMissing?: boolean;
  prompter: WalletPrompter;
}): Promise<AnchorFoundingMessage> {
  if (!options.promptForFoundingMessageWhenMissing || options.foundingMessageText != null) {
    return encodeFoundingMessage(options.foundingMessageText ?? null);
  }

  for (;;) {
    const answer = await options.prompter.prompt("Founding message (optional, press Enter to skip): ");

    try {
      return await encodeFoundingMessage(answer);
    } catch (error) {
      const reason = extractAnchorInvalidMessageReason(error);
      options.prompter.writeLine("Founding message cannot be encoded in canonical Coglex.");
      if (reason !== null) {
        options.prompter.writeLine(`Reason: ${reason}`);
      }
    }
  }
}

export async function confirmDirectAnchor(
  prompter: WalletPrompter,
  options: {
    domainName: string;
    walletAddress: string;
    foundingMessageText: string | null;
  },
): Promise<void> {
  prompter.writeLine(`You are anchoring "${options.domainName}".`);
  prompter.writeLine(`Wallet address: ${options.walletAddress}`);
  prompter.writeLine("Anchoring publishes a standalone DOMAIN_ANCHOR from the local wallet address.");

  if (options.foundingMessageText !== null) {
    prompter.writeLine("The founding message bytes will be public in mempool and on-chain.");
    prompter.writeLine(`Founding message: ${options.foundingMessageText}`);
  }

  const answer = (await prompter.prompt("Type the domain name to continue: ")).trim();
  if (answer !== options.domainName) {
    throw new Error("wallet_anchor_confirmation_rejected");
  }
}
