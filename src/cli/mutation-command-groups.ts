import type { CommandName } from "./types.js";

export const walletMutationCommands = [
  "anchor",
  "anchor-clear",
  "domain-anchor",
  "domain-anchor-clear",
  "register",
  "domain-register",
  "transfer",
  "domain-transfer",
  "sell",
  "domain-sell",
  "unsell",
  "domain-unsell",
  "buy",
  "domain-buy",
  "domain-endpoint-set",
  "domain-endpoint-clear",
  "domain-delegate-set",
  "domain-delegate-clear",
  "domain-miner-set",
  "domain-miner-clear",
  "domain-canonical",
  "field-create",
  "field-set",
  "field-clear",
  "send",
  "cog-send",
  "claim",
  "cog-claim",
  "reclaim",
  "cog-reclaim",
  "cog-lock",
  "rep-give",
  "rep-revoke",
] as const satisfies readonly CommandName[];

export type WalletMutationCommand = (typeof walletMutationCommands)[number];

const walletMutationCommandSet = new Set<WalletMutationCommand>(
  walletMutationCommands,
);

export function isWalletMutationCommand(
  command: CommandName | null,
): command is WalletMutationCommand {
  return command !== null
    && walletMutationCommandSet.has(command as WalletMutationCommand);
}

export function isAnchorMutationCommand(
  command: CommandName | null,
): command is "anchor" | "domain-anchor" {
  return command === "anchor" || command === "domain-anchor";
}

export function isAnchorClearMutationCommand(
  command: CommandName | null,
): command is "anchor-clear" | "domain-anchor-clear" {
  return command === "anchor-clear" || command === "domain-anchor-clear";
}

export function isRegisterMutationCommand(
  command: CommandName | null,
): command is "register" | "domain-register" {
  return command === "register" || command === "domain-register";
}

export function isTransferMutationCommand(
  command: CommandName | null,
): command is "transfer" | "domain-transfer" {
  return command === "transfer" || command === "domain-transfer";
}

export function isSellMutationCommand(
  command: CommandName | null,
): command is "sell" | "domain-sell" {
  return command === "sell" || command === "domain-sell";
}

export function isUnsellMutationCommand(
  command: CommandName | null,
): command is "unsell" | "domain-unsell" {
  return command === "unsell" || command === "domain-unsell";
}

export function isSellOrUnsellMutationCommand(
  command: CommandName | null,
): command is "sell" | "domain-sell" | "unsell" | "domain-unsell" {
  return isSellMutationCommand(command) || isUnsellMutationCommand(command);
}

export function isBuyMutationCommand(
  command: CommandName | null,
): command is "buy" | "domain-buy" {
  return command === "buy" || command === "domain-buy";
}

export function isSendMutationCommand(
  command: CommandName | null,
): command is "send" | "cog-send" {
  return command === "send" || command === "cog-send";
}

export function isClaimMutationCommand(
  command: CommandName | null,
): command is "claim" | "cog-claim" {
  return command === "claim" || command === "cog-claim";
}

export function isReclaimMutationCommand(
  command: CommandName | null,
): command is "reclaim" | "cog-reclaim" {
  return command === "reclaim" || command === "cog-reclaim";
}

export function isReputationMutationCommand(
  command: CommandName | null,
): command is "rep-give" | "rep-revoke" {
  return command === "rep-give" || command === "rep-revoke";
}
