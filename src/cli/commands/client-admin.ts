import { writeLine } from "../io.js";
import { writeHandledCliError } from "../output.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";
import {
  changeClientPassword,
  lockClientPassword,
  unlockClientPassword,
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
    if (parsed.command === "client-lock") {
      await lockClientPassword(context.walletSecretProvider);

      writeLine(context.stdout, "Client locked.");
      return 0;
    }

    if (parsed.command === "client-unlock") {
      const prompter = createCommandPrompter(context);
      const status = await unlockClientPassword(context.walletSecretProvider, prompter);

      writeLine(
        context.stdout,
        status.unlockUntilUnixMs === null
          ? "Client unlocked."
          : `Client unlocked until ${new Date(status.unlockUntilUnixMs).toISOString()}.`,
      );
      return 0;
    }

    if (parsed.command === "client-change-password") {
      const prompter = createCommandPrompter(context);
      const status = await changeClientPassword(context.walletSecretProvider, prompter);

      writeLine(
        context.stdout,
        status.unlockUntilUnixMs === null
          ? "Client password changed."
          : `Client password changed. Client unlocked until ${new Date(status.unlockUntilUnixMs).toISOString()}.`,
      );
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
