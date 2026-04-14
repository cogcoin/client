import { createDefaultContext } from "./context.js";
import { writeLine } from "./io.js";
import {
  classifyCliError,
  createCommandJsonErrorEnvelope,
  createErrorEnvelope,
  formatCliTextError,
  inferOutputMode,
  isStructuredOutputMode,
  writeJsonValue,
} from "./output.js";
import { HELP_TEXT, parseCliArgs } from "./parse.js";
import { runFollowCommand } from "./commands/follow.js";
import { runMiningAdminCommand } from "./commands/mining-admin.js";
import { runMiningReadCommand } from "./commands/mining-read.js";
import { runMiningRuntimeCommand } from "./commands/mining-runtime.js";
import { runStatusCommand } from "./commands/status.js";
import { runSyncCommand } from "./commands/sync.js";
import { runWalletAdminCommand } from "./commands/wallet-admin.js";
import { runWalletMutationCommand } from "./commands/wallet-mutation.js";
import { runWalletReadCommand } from "./commands/wallet-read.js";
import type { CliRunnerContext, ParsedCliArgs } from "./types.js";

export async function runCli(
  argv: string[],
  contextOverrides: CliRunnerContext = {},
): Promise<number> {
  const context = createDefaultContext(contextOverrides);

  let parsed: ParsedCliArgs;

  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    const classified = classifyCliError(error);
    if (isStructuredOutputMode(inferOutputMode(argv))) {
      writeJsonValue(context.stdout, createErrorEnvelope(
        "cogcoin/cli/v1",
        `cogcoin ${argv.join(" ")}`.trim(),
        classified.errorCode,
        classified.message,
      ));
      return classified.exitCode;
    }
    writeLine(context.stderr, classified.message);
    writeLine(context.stderr, HELP_TEXT.trimEnd());
    return classified.exitCode;
  }

  if (parsed.version) {
    writeLine(context.stdout, await context.readPackageVersion());
    return 0;
  }

  if (parsed.help || parsed.command === null) {
    if (parsed.command === null && isStructuredOutputMode(parsed.outputMode)) {
      writeJsonValue(context.stdout, createErrorEnvelope(
        "cogcoin/cli/v1",
        "cogcoin",
        "cli_missing_command",
        "cli_missing_command",
      ));
      return 2;
    }
    writeLine(context.stdout, HELP_TEXT.trimEnd());
    return parsed.help ? 0 : 2;
  }

  try {
    if (parsed.command === "sync") {
      return runSyncCommand(parsed, context);
    }

    if (parsed.command === "follow") {
      return runFollowCommand(parsed, context);
    }

    if (parsed.command === "status") {
      return runStatusCommand(parsed, context);
    }

    if (
      parsed.command === "mine"
      || parsed.command === "mine-start"
      || parsed.command === "mine-stop"
    ) {
      return runMiningRuntimeCommand(parsed, context);
    }

    if (
      parsed.command === "hooks-mining-enable"
      || parsed.command === "hooks-mining-disable"
      || parsed.command === "mine-setup"
    ) {
      return runMiningAdminCommand(parsed, context);
    }

    if (
      parsed.command === "init"
      || parsed.command === "reset"
      || parsed.command === "repair"
      || parsed.command === "unlock"
      || parsed.command === "wallet-export"
      || parsed.command === "wallet-import"
      || parsed.command === "wallet-init"
      || parsed.command === "wallet-unlock"
      || parsed.command === "wallet-lock"
    ) {
      return runWalletAdminCommand(parsed, context);
    }

    if (
      parsed.command === "anchor"
      || parsed.command === "domain-anchor"
      || parsed.command === "register"
      || parsed.command === "domain-register"
      || parsed.command === "transfer"
      || parsed.command === "domain-transfer"
      || parsed.command === "sell"
      || parsed.command === "domain-sell"
      || parsed.command === "unsell"
      || parsed.command === "domain-unsell"
      || parsed.command === "buy"
      || parsed.command === "domain-buy"
      || parsed.command === "domain-endpoint-set"
      || parsed.command === "domain-endpoint-clear"
      || parsed.command === "domain-delegate-set"
      || parsed.command === "domain-delegate-clear"
      || parsed.command === "domain-miner-set"
      || parsed.command === "domain-miner-clear"
      || parsed.command === "domain-canonical"
      || parsed.command === "field-create"
      || parsed.command === "field-set"
      || parsed.command === "field-clear"
      || parsed.command === "send"
      || parsed.command === "claim"
      || parsed.command === "reclaim"
      || parsed.command === "cog-send"
      || parsed.command === "cog-claim"
      || parsed.command === "cog-reclaim"
      || parsed.command === "cog-lock"
      || parsed.command === "rep-give"
      || parsed.command === "rep-revoke"
    ) {
      return runWalletMutationCommand(parsed, context);
    }

    if (
      parsed.command === "hooks-mining-status"
      || parsed.command === "mine-status"
      || parsed.command === "mine-log"
    ) {
      return runMiningReadCommand(parsed, context);
    }

    return runWalletReadCommand(parsed, context);
  } catch (error) {
    const classified = classifyCliError(error);
    if (isStructuredOutputMode(parsed.outputMode)) {
      writeJsonValue(context.stdout, createCommandJsonErrorEnvelope(parsed, error));
      return classified.exitCode;
    }

    const formatted = formatCliTextError(error);
    if (formatted !== null) {
      for (const line of formatted) {
        writeLine(context.stderr, line);
      }
    } else {
      writeLine(context.stderr, classified.message);
    }
    return classified.exitCode;
  }
}
