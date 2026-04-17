import { writeLine } from "../io.js";
import { createTerminalPrompter } from "../prompt.js";
import {
  createMutationSuccessEnvelope,
  describeCanonicalCommand,
  resolveStableMutationJsonSchema,
  writeHandledCliError,
  writeJsonValue,
} from "../output.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";
import {
  changeClientPassword,
  lockClientPassword,
  unlockClientPassword,
} from "../../wallet/state/provider.js";

function createCommandPrompter(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
) {
  return parsed.outputMode !== "text"
    ? createTerminalPrompter(context.stdin, context.stderr)
    : context.createPrompter();
}

export async function runClientAdminCommand(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): Promise<number> {
  try {
    if (parsed.command === "client-lock") {
      const status = await lockClientPassword(context.walletSecretProvider);

      if (parsed.outputMode === "json") {
        writeJsonValue(context.stdout, createMutationSuccessEnvelope(
          resolveStableMutationJsonSchema(parsed)!,
          describeCanonicalCommand(parsed),
          "locked",
          {
            resultType: "operation",
            operation: {
              kind: "client-lock",
              locked: true,
              unlockUntilUnixMs: status.unlockUntilUnixMs,
            },
            state: {
              locked: true,
              unlockUntilUnixMs: status.unlockUntilUnixMs,
            },
          },
        ));
        return 0;
      }

      writeLine(context.stdout, "Client locked.");
      return 0;
    }

    if (parsed.command === "client-unlock") {
      const prompter = createCommandPrompter(parsed, context);
      const status = await unlockClientPassword(context.walletSecretProvider, prompter);

      if (parsed.outputMode === "json") {
        writeJsonValue(context.stdout, createMutationSuccessEnvelope(
          resolveStableMutationJsonSchema(parsed)!,
          describeCanonicalCommand(parsed),
          "unlocked",
          {
            resultType: "operation",
            operation: {
              kind: "client-unlock",
              unlocked: status.unlocked,
              unlockUntilUnixMs: status.unlockUntilUnixMs,
            },
            state: {
              unlocked: status.unlocked,
              unlockUntilUnixMs: status.unlockUntilUnixMs,
            },
          },
        ));
        return 0;
      }

      writeLine(
        context.stdout,
        status.unlockUntilUnixMs === null
          ? "Client unlocked."
          : `Client unlocked until ${new Date(status.unlockUntilUnixMs).toISOString()}.`,
      );
      return 0;
    }

    if (parsed.command === "client-change-password") {
      const prompter = createCommandPrompter(parsed, context);
      const status = await changeClientPassword(context.walletSecretProvider, prompter);

      if (parsed.outputMode === "json") {
        writeJsonValue(context.stdout, createMutationSuccessEnvelope(
          resolveStableMutationJsonSchema(parsed)!,
          describeCanonicalCommand(parsed),
          "changed",
          {
            resultType: "operation",
            operation: {
              kind: "client-change-password",
              changed: true,
              unlocked: status.unlocked,
              unlockUntilUnixMs: status.unlockUntilUnixMs,
            },
            state: {
              changed: true,
              unlocked: status.unlocked,
              unlockUntilUnixMs: status.unlockUntilUnixMs,
            },
          },
        ));
        return 0;
      }

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
