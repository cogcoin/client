import { writeLine } from "../io.js";
import { writeHandledCliError } from "../output.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";
import {
  changeClientPassword,
} from "../../wallet/state/provider.js";

function createCommandPrompter(
  context: RequiredCliRunnerContext,
) {
  return context.createPrompter();
}

export async function runClientAdminCommand(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): Promise<number> {
  try {
    if (parsed.command === "client-change-password") {
      const prompter = createCommandPrompter(context);
      await changeClientPassword(context.walletSecretProvider, prompter);
      writeLine(context.stdout, "Client password changed.");
      return 0;
    }

    writeLine(context.stderr, `client admin command not implemented: ${parsed.command}`);
    return 1;
  } catch (error) {
    return writeHandledCliError({
      parsed,
      stdout: context.stdout,
      stderr: context.stderr,
      error,
    });
  }
}
