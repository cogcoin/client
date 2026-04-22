import type { WalletPrompter } from "../../lifecycle.js";
import {
  confirmTypedAcknowledgement as confirmSharedTypedAcknowledgement,
  confirmYesNo as confirmSharedYesNo,
} from "../confirm.js";

async function confirmYesNo(
  prompter: WalletPrompter,
  message: string,
  errorCode: string,
  options: {
    assumeYes?: boolean;
    requiresTtyErrorCode: string;
  },
): Promise<void> {
  await confirmSharedYesNo(prompter, message, {
    assumeYes: options.assumeYes,
    errorCode,
    requiresTtyErrorCode: options.requiresTtyErrorCode,
  });
}

async function confirmTyped(
  prompter: WalletPrompter,
  expected: string,
  prompt: string,
  errorCode: string,
  options: {
    assumeYes?: boolean;
    requiresTtyErrorCode: string;
    typedAckRequiredErrorCode: string;
  },
): Promise<void> {
  await confirmSharedTypedAcknowledgement(prompter, {
    assumeYes: options.assumeYes,
    expected,
    prompt,
    errorCode,
    requiresTtyErrorCode: options.requiresTtyErrorCode,
    typedAckRequiredErrorCode: options.typedAckRequiredErrorCode,
  });
}

export { confirmTyped, confirmYesNo };
