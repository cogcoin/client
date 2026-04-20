import type { CommandName } from "./types.js";

export const walletMutationCommands = [
  "anchor",
  "register",
  "transfer",
  "sell",
  "unsell",
  "buy",
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
  "claim",
  "reclaim",
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
): command is "anchor" {
  return command === "anchor";
}

export function isRegisterMutationCommand(
  command: CommandName | null,
): command is "register" {
  return command === "register";
}

export function isTransferMutationCommand(
  command: CommandName | null,
): command is "transfer" {
  return command === "transfer";
}

export function isSellMutationCommand(
  command: CommandName | null,
): command is "sell" {
  return command === "sell";
}

export function isUnsellMutationCommand(
  command: CommandName | null,
): command is "unsell" {
  return command === "unsell";
}

export function isSellOrUnsellMutationCommand(
  command: CommandName | null,
): command is "sell" | "unsell" {
  return isSellMutationCommand(command) || isUnsellMutationCommand(command);
}

export function isBuyMutationCommand(
  command: CommandName | null,
): command is "buy" {
  return command === "buy";
}

export function isSendMutationCommand(
  command: CommandName | null,
): command is "send" {
  return command === "send";
}

export function isClaimMutationCommand(
  command: CommandName | null,
): command is "claim" {
  return command === "claim";
}

export function isReclaimMutationCommand(
  command: CommandName | null,
): command is "reclaim" {
  return command === "reclaim";
}

export function isReputationMutationCommand(
  command: CommandName | null,
): command is "rep-give" | "rep-revoke" {
  return command === "rep-give" || command === "rep-revoke";
}
