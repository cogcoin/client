import type { WalletPrompter } from "../lifecycle.js";

export async function confirmYesNo(
  prompter: WalletPrompter,
  message: string,
  options: {
    assumeYes?: boolean;
    errorCode: string;
    requiresTtyErrorCode: string;
    prompt?: string;
  },
): Promise<void> {
  prompter.writeLine(message);

  if (options.assumeYes === true) {
    return;
  }

  if (!prompter.isInteractive) {
    throw new Error(options.requiresTtyErrorCode);
  }

  const answer = (await prompter.prompt(options.prompt ?? "Continue? [y/N]: ")).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    throw new Error(options.errorCode);
  }
}

export async function confirmTypedAcknowledgement(
  prompter: WalletPrompter,
  options: {
    assumeYes?: boolean;
    expected: string;
    prompt: string;
    errorCode: string;
    requiresTtyErrorCode: string;
    typedAckRequiredErrorCode: string;
  },
): Promise<void> {
  if (!prompter.isInteractive) {
    throw new Error(options.assumeYes === true
      ? options.typedAckRequiredErrorCode
      : options.requiresTtyErrorCode);
  }

  const answer = (await prompter.prompt(options.prompt)).trim();
  if (answer !== options.expected) {
    throw new Error(options.errorCode);
  }
}
