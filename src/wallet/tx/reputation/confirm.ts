import { formatCogAmount } from "../common.js";
import {
  confirmTypedAcknowledgement as confirmSharedTypedAcknowledgement,
  confirmYesNo as confirmSharedYesNo,
} from "../confirm.js";
import type { WalletPrompter } from "../../lifecycle.js";
import {
  describeReputationEffect,
  describeReputationReview,
} from "./intent.js";
import type { ReputationResolvedSummary } from "./types.js";

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

export async function confirmReputationMutation(
  prompter: WalletPrompter,
  options: {
    kind: "give" | "revoke";
    sourceDomainName: string;
    targetDomainName: string;
    amountCogtoshi: bigint;
    reviewText: string | null;
    resolved: ReputationResolvedSummary;
    assumeYes?: boolean;
  },
): Promise<void> {
  prompter.writeLine(`${options.kind === "give" ? "Giving" : "Revoking"} reputation from "${options.sourceDomainName}" to "${options.targetDomainName}".`);
  prompter.writeLine(`Resolved sender: ${options.resolved.sender.selector} (${options.resolved.sender.address})`);
  prompter.writeLine(`Burn amount: ${formatCogAmount(options.amountCogtoshi)}`);
  prompter.writeLine(`Effect: ${describeReputationEffect(options.resolved.effect)}.`);
  prompter.writeLine(`Review: ${describeReputationReview(options.resolved.review)}.`);

  if (options.reviewText !== null) {
    prompter.writeLine("Warning: review text will be encoded and published publicly in the mempool and on-chain.");
  }

  if (options.kind === "give" && options.resolved.selfStake) {
    prompter.writeLine("Self-stake: yes.");
    prompter.writeLine("Warning: this is self-stake.");
    prompter.writeLine("Self-stake is irrevocable and cannot later be revoked.");
    await confirmTyped(
      prompter,
      options.sourceDomainName,
      `Type ${options.sourceDomainName} to continue: `,
      "wallet_rep_give_confirmation_rejected",
      {
        assumeYes: options.assumeYes,
        requiresTtyErrorCode: "wallet_rep_give_requires_tty",
        typedAckRequiredErrorCode: "wallet_rep_give_typed_ack_required",
      },
    );
    return;
  }

  await confirmYesNo(
    prompter,
    options.kind === "give"
      ? "This burns COG to publish a reputation commitment."
      : "This revokes visible support but the burned COG is not refunded.",
    options.kind === "give"
      ? "wallet_rep_give_confirmation_rejected"
      : "wallet_rep_revoke_confirmation_rejected",
    {
      assumeYes: options.assumeYes,
      requiresTtyErrorCode: options.kind === "give"
        ? "wallet_rep_give_requires_tty"
        : "wallet_rep_revoke_requires_tty",
    },
  );
}
