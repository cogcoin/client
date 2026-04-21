import {
  createMnemonicConfirmationChallenge,
  isEnglishMnemonicWord,
  validateEnglishMnemonic,
} from "../material.js";
import { renderWalletMnemonicRevealArt } from "../mnemonic-art.js";
import type {
  WalletInitializationResult,
  WalletPrompter,
} from "./types.js";

async function promptRequiredValue(
  prompter: WalletPrompter,
  message: string,
): Promise<string> {
  const value = (await prompter.prompt(message)).trim();

  if (value === "") {
    throw new Error("wallet_prompt_value_required");
  }

  return value;
}

export async function promptForRestoreMnemonic(
  prompter: WalletPrompter,
): Promise<string> {
  const words: string[] = [];

  for (let index = 0; index < 24; index += 1) {
    const word = (await promptRequiredValue(prompter, `Word ${index + 1} of 24: `)).toLowerCase();

    if (!isEnglishMnemonicWord(word)) {
      throw new Error("wallet_restore_mnemonic_invalid");
    }

    words.push(word);
  }

  const phrase = words.join(" ");

  if (!validateEnglishMnemonic(phrase)) {
    throw new Error("wallet_restore_mnemonic_invalid");
  }

  return phrase;
}

export async function promptForInitializationMode(
  prompter: WalletPrompter,
): Promise<Exclude<WalletInitializationResult["setupMode"], "existing">> {
  if (prompter.selectOption != null) {
    return await prompter.selectOption({
      message: "How should Cogcoin set up this wallet?",
      options: [
        {
          label: "Create new wallet",
          description: "Generate a fresh 24-word recovery phrase.",
          value: "generated",
        },
        {
          label: "Restore existing wallet",
          description: "Enter an existing 24-word recovery phrase.",
          value: "restored",
        },
      ],
      initialValue: "generated",
    }) as Exclude<WalletInitializationResult["setupMode"], "existing">;
  }

  prompter.writeLine("How should Cogcoin set up this wallet?");
  prompter.writeLine("1. Create new wallet");
  prompter.writeLine("2. Restore existing wallet");

  while (true) {
    const answer = (await prompter.prompt("Choice [1-2]: ")).trim();

    if (answer === "1") {
      return "generated";
    }

    if (answer === "2") {
      return "restored";
    }

    prompter.writeLine("Enter 1 or 2.");
  }
}

export async function confirmTypedAcknowledgement(
  prompter: WalletPrompter,
  expected: string,
  message: string,
  errorCode = "wallet_typed_confirmation_rejected",
): Promise<void> {
  const answer = (await prompter.prompt(message)).trim();

  if (answer !== expected) {
    throw new Error(errorCode);
  }
}

export function writeMnemonicReveal(
  prompter: WalletPrompter,
  phrase: string,
  introLines: readonly string[],
): void {
  const words = phrase.trim().split(/\s+/);

  for (const line of introLines) {
    prompter.writeLine(line);
  }

  for (const line of renderWalletMnemonicRevealArt(words)) {
    prompter.writeLine(line);
  }

  prompter.writeLine("Single-line copy:");
  prompter.writeLine(phrase);
}

export async function confirmMnemonic(
  prompter: WalletPrompter,
  words: readonly string[],
): Promise<void> {
  const challenge = createMnemonicConfirmationChallenge([...words]);

  for (const entry of challenge) {
    const answer = (await prompter.prompt(`Confirm word #${entry.index + 1}: `)).trim().toLowerCase();

    if (answer !== entry.word) {
      throw new Error(`wallet_init_confirmation_failed_word_${entry.index + 1}`);
    }
  }
}

export async function clearSensitiveDisplay(
  prompter: WalletPrompter,
  scope: "mnemonic-reveal" | "restore-mnemonic-entry",
): Promise<void> {
  await Promise.resolve()
    .then(() => prompter.clearSensitiveDisplay?.(scope))
    .catch(() => undefined);
}
