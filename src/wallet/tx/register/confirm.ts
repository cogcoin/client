import type { WalletPrompter } from "../../lifecycle.js";
import { formatCogAmount } from "../common.js";
import { confirmTypedAcknowledgement, confirmYesNo } from "../confirm.js";
import type { WalletRegisterRpcClient } from "./intent.js";
import { extractOpReturnPayloadFromScriptHex } from "./plan.js";
import type { RegisterResolvedSummary } from "./result.js";
import { serializeDomainReg } from "../../cogop/index.js";

function describeRegisterEconomicEffect(summary: RegisterResolvedSummary): string {
  if (summary.economicEffect.kind === "treasury-payment") {
    return `send ${summary.economicEffect.amount.toString()} sats to the Cogcoin treasury.`;
  }

  return `burn ${formatCogAmount(summary.economicEffect.amount)} from the parent owner.`;
}

function writeRegisterResolvedSummary(
  prompter: WalletPrompter,
  summary: RegisterResolvedSummary,
): void {
  prompter.writeLine(`Resolved path: ${summary.path} registration.`);

  if (summary.parentDomainName !== null) {
    prompter.writeLine(`Resolved parent: ${summary.parentDomainName}.`);
  }

  prompter.writeLine(`Resolved sender: ${summary.sender.selector} (${summary.sender.address})`);
  prompter.writeLine(`Economic effect: ${describeRegisterEconomicEffect(summary)}`);
}

export async function findCompetingRootRegistrationTxids(
  rpc: WalletRegisterRpcClient,
  domainName: string,
): Promise<string[]> {
  const targetPayloadHex = Buffer.from(serializeDomainReg(domainName).opReturnData).toString("hex");
  const txids = await rpc.getRawMempool();
  const competitors: string[] = [];

  for (const txid of txids) {
    const transaction = await rpc.getRawTransaction(txid, true).catch(() => null);

    if (transaction === null) {
      continue;
    }

    const matches = transaction.vout.some((output) => {
      const scriptHex = output.scriptPubKey?.hex;
      if (scriptHex == null) {
        return false;
      }

      const payload = extractOpReturnPayloadFromScriptHex(scriptHex);
      return payload !== null && Buffer.from(payload).toString("hex") === targetPayloadHex;
    });

    if (matches) {
      competitors.push(txid);
    }
  }

  return competitors;
}

export async function confirmRootRegistration(
  prompter: WalletPrompter,
  domainName: string,
  resolved: RegisterResolvedSummary,
  competitorVisible: boolean,
  assumeYes = false,
): Promise<void> {
  writeRegisterResolvedSummary(prompter, resolved);
  prompter.writeLine(
    competitorVisible
      ? `This is a root-domain race for "${domainName}".`
      : `You are registering the root domain "${domainName}".`,
  );
  prompter.writeLine("Root domains contain no hyphen. Hyphenated names are subdomains and must not use this flow.");
  prompter.writeLine("If another valid registration confirms first, you may still pay BTC and receive no domain.");
  await confirmTypedAcknowledgement(prompter, {
    assumeYes,
    expected: domainName,
    prompt: "Type the domain name to continue: ",
    errorCode: "wallet_register_confirmation_rejected",
    requiresTtyErrorCode: "wallet_register_requires_tty",
    typedAckRequiredErrorCode: "wallet_register_typed_ack_required",
  });
}

export async function confirmSubdomainRegistration(
  prompter: WalletPrompter,
  domainName: string,
  resolved: RegisterResolvedSummary,
  assumeYes = false,
): Promise<void> {
  writeRegisterResolvedSummary(prompter, resolved);
  prompter.writeLine(`You are registering the subdomain "${domainName}".`);
  await confirmYesNo(prompter, "This publishes a subdomain registration burn.", {
    assumeYes,
    errorCode: "wallet_register_confirmation_rejected",
    requiresTtyErrorCode: "wallet_register_requires_tty",
  });
}
