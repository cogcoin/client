import type { WalletPrompter } from "../../lifecycle.js";
import { formatCogAmount } from "../common.js";
import {
  confirmTypedAcknowledgement,
  confirmYesNo,
} from "../confirm.js";
import type {
  CogResolvedSummary,
} from "./types.js";
import { normalizeBtcTarget } from "../targets.js";
import type { MutationSender } from "../common.js";

export async function confirmSend(
  prompter: WalletPrompter,
  resolved: CogResolvedSummary,
  target: string,
  normalizedRecipient: ReturnType<typeof normalizeBtcTarget>,
  amountCogtoshi: bigint,
  assumeYes = false,
): Promise<void> {
  prompter.writeLine(`You are sending ${formatCogAmount(amountCogtoshi)}.`);
  prompter.writeLine(`Resolved sender: ${resolved.sender.selector} (${resolved.sender.address})`);
  prompter.writeLine(`Recipient: ${normalizedRecipient.address ?? `spk:${normalizedRecipient.scriptPubKeyHex}`}`);
  if (normalizedRecipient.opaque) {
    await confirmTypedAcknowledgement(prompter, {
      assumeYes,
      expected: target.trim(),
      prompt: "Type the exact target to continue: ",
      errorCode: "wallet_send_confirmation_rejected",
      requiresTtyErrorCode: "wallet_send_requires_tty",
      typedAckRequiredErrorCode: "wallet_send_typed_ack_required",
    });
    return;
  }
  await confirmYesNo(prompter, "This will publish an on-chain COG transfer.", {
    assumeYes,
    errorCode: "wallet_send_confirmation_rejected",
    requiresTtyErrorCode: "wallet_send_requires_tty",
  });
}

export async function confirmLock(
  prompter: WalletPrompter,
  resolved: CogResolvedSummary,
  amountCogtoshi: bigint,
  recipientDomainName: string,
  timeoutHeight: number,
  assumeYes = false,
): Promise<void> {
  prompter.writeLine(`You are locking ${formatCogAmount(amountCogtoshi)}.`);
  prompter.writeLine(`Resolved sender: ${resolved.sender.selector} (${resolved.sender.address})`);
  prompter.writeLine(`Recipient domain: ${recipientDomainName}`);
  prompter.writeLine(`Resolved timeout height: ${timeoutHeight}`);
  await confirmYesNo(prompter, "This creates an escrowed COG lock and the funds cannot be spent until claimed or reclaimed.", {
    assumeYes,
    errorCode: "wallet_mutation_confirmation_rejected",
    requiresTtyErrorCode: "wallet_lock_requires_tty",
  });
}

export async function confirmClaim(
  prompter: WalletPrompter,
  options: {
    kind: "claim" | "reclaim";
    lockId: number;
    recipientDomainName: string | null;
    amountCogtoshi: bigint;
    resolved: CogResolvedSummary;
    assumeYes?: boolean;
  },
): Promise<void> {
  prompter.writeLine(`${options.kind === "claim" ? "Claiming" : "Reclaiming"} lock:${options.lockId} for ${formatCogAmount(options.amountCogtoshi)}.`);
  prompter.writeLine(`Resolved sender: ${options.resolved.sender.selector} (${options.resolved.sender.address})`);
  if (options.resolved.claimPath !== null) {
    prompter.writeLine(`Resolved path: ${options.resolved.claimPath}.`);
  }
  if (options.recipientDomainName !== null) {
    prompter.writeLine(`Recipient domain: ${options.recipientDomainName}`);
  }
  if (options.kind === "claim") {
    prompter.writeLine("Warning: the claim preimage becomes public in the mempool and on-chain.");
  }
  await confirmYesNo(
    prompter,
    options.kind === "claim"
      ? "This spends the lock via the recipient claim path."
      : "This spends the lock via the timeout reclaim path.",
    {
      assumeYes: options.assumeYes,
      errorCode: options.kind === "claim"
        ? "wallet_claim_confirmation_rejected"
        : "wallet_reclaim_confirmation_rejected",
      requiresTtyErrorCode: options.kind === "claim"
        ? "wallet_claim_requires_tty"
        : "wallet_reclaim_requires_tty",
    },
  );
}
