import type { WalletPrompter } from "../../lifecycle.js";
import { confirmYesNo } from "../confirm.js";
import type { DomainAdminResolvedSenderSummary } from "./types.js";
import { normalizeBtcTarget } from "../targets.js";

export async function confirmEndpointMutation(
  prompter: WalletPrompter,
  domainName: string,
  payload: Uint8Array,
  options: {
    clear: boolean;
    sender: DomainAdminResolvedSenderSummary;
    sourceKind?: "text" | "json" | "bytes";
    assumeYes?: boolean;
  },
): Promise<void> {
  prompter.writeLine(`${options.clear ? "Clearing" : "Updating"} endpoint for "${domainName}".`);
  prompter.writeLine(`Resolved sender: ${options.sender.selector} (${options.sender.address})`);
  prompter.writeLine(
    options.clear
      ? "Effect: clear the endpoint payload."
      : `Effect: set the endpoint payload to ${payload.length} bytes.`,
  );
  if (!options.clear) {
    prompter.writeLine(`Payload bytes: ${payload.length}`);
    if (options.sourceKind !== undefined) {
      prompter.writeLine(`Payload source: ${options.sourceKind}`);
    }
    prompter.writeLine("Warning: endpoint data is public in the mempool and on-chain.");
  }
  await confirmYesNo(
    prompter,
    options.clear
      ? "This publishes a standalone anchored endpoint clear."
      : "This publishes a standalone anchored endpoint update.",
    {
      assumeYes: options.assumeYes,
      errorCode: "wallet_domain_endpoint_confirmation_rejected",
      requiresTtyErrorCode: "wallet_domain_endpoint_requires_tty",
    },
  );
}

export async function confirmTargetMutation(
  prompter: WalletPrompter,
  options: {
    kind: "delegate" | "miner";
    domainName: string;
    target: ReturnType<typeof normalizeBtcTarget> | null;
    sender: DomainAdminResolvedSenderSummary;
    assumeYes?: boolean;
  },
): Promise<void> {
  prompter.writeLine(`${options.target === null ? "Clearing" : "Updating"} ${options.kind} for "${options.domainName}".`);
  prompter.writeLine(`Resolved sender: ${options.sender.selector} (${options.sender.address})`);
  if (options.target === null) {
    prompter.writeLine(`Effect: clear the ${options.kind === "delegate" ? "delegate" : "designated miner"} target.`);
    await confirmYesNo(prompter, `This clears the current ${options.kind} target.`, {
      assumeYes: options.assumeYes,
      errorCode: `wallet_domain_${options.kind}_confirmation_rejected`,
      requiresTtyErrorCode: `wallet_domain_${options.kind}_requires_tty`,
    });
    return;
  }

  prompter.writeLine(`Resolved target: ${options.target.address ?? `spk:${options.target.scriptPubKeyHex}`}`);
  prompter.writeLine(`Effect: set the ${options.kind === "delegate" ? "delegate" : "designated miner"} target.`);
  if (options.kind === "miner" && options.target.scriptPubKeyHex === options.sender.scriptPubKeyHex) {
    prompter.writeLine("Warning: setting the designated miner to the current owner is usually redundant.");
  }
  await confirmYesNo(
    prompter,
    options.kind === "delegate"
      ? "This changes who may act for the domain as delegate."
      : "This changes who may mine for the domain as designated miner.",
    {
      assumeYes: options.assumeYes,
      errorCode: `wallet_domain_${options.kind}_confirmation_rejected`,
      requiresTtyErrorCode: `wallet_domain_${options.kind}_requires_tty`,
    },
  );
}

export async function confirmCanonicalMutation(
  prompter: WalletPrompter,
  domainName: string,
  sender: DomainAdminResolvedSenderSummary,
  assumeYes = false,
): Promise<void> {
  prompter.writeLine(`Canonicalizing "${domainName}" as the anchored owner.`);
  prompter.writeLine(`Resolved sender: ${sender.selector} (${sender.address})`);
  prompter.writeLine("Effect: canonicalize the current anchored owner.");
  await confirmYesNo(prompter, "This publishes a standalone SET_CANONICAL operation.", {
    assumeYes,
    errorCode: "wallet_domain_canonical_confirmation_rejected",
    requiresTtyErrorCode: "wallet_domain_canonical_requires_tty",
  });
}
