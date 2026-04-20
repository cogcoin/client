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
import { runClientAdminCommand } from "./commands/client-admin.js";
import { runMiningAdminCommand } from "./commands/mining-admin.js";
import { runMiningReadCommand } from "./commands/mining-read.js";
import { runMiningRuntimeCommand } from "./commands/mining-runtime.js";
import { runServiceRuntimeCommand } from "./commands/service-runtime.js";
import { runStatusCommand } from "./commands/status.js";
import { runSyncCommand } from "./commands/sync.js";
import { runUpdateCommand } from "./commands/update.js";
import { runWalletAdminCommand } from "./commands/wallet-admin.js";
import { runWalletMutationCommand } from "./commands/wallet-mutation.js";
import { runWalletReadCommand } from "./commands/wallet-read.js";
import { maybeNotifyAboutCliUpdate } from "./update-notifier.js";
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

  await maybeNotifyAboutCliUpdate(parsed, context);

  try {
    switch (parsed.commandFamily) {
      case "update":
        return runUpdateCommand(parsed, context);
      case "sync":
        return runSyncCommand(parsed, context);
      case "follow":
        return runFollowCommand(parsed, context);
      case "status":
        return runStatusCommand(parsed, context);
      case "client-admin":
        return runClientAdminCommand(parsed, context);
      case "service-runtime":
        return runServiceRuntimeCommand(parsed, context);
      case "wallet-admin":
        return runWalletAdminCommand(parsed, context);
      case "wallet-mutation":
        return runWalletMutationCommand(parsed, context);
      case "wallet-read":
        return runWalletReadCommand(parsed, context);
      case "mining-admin":
        return runMiningAdminCommand(parsed, context);
      case "mining-runtime":
        return runMiningRuntimeCommand(parsed, context);
      case "mining-read":
        return runMiningReadCommand(parsed, context);
      default:
        return runWalletReadCommand(parsed, context);
    }
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
