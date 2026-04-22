import {
  createOwnedLockCleanupSignalWatcher,
  waitForCompletionOrStop,
} from "../signals.js";
import { writeHandledCliError } from "../output.js";
import { writeLine } from "../io.js";
import { writeMutationCommandSuccess } from "../mutation-success.js";
import type {
  ParsedCliArgs,
  RequiredCliRunnerContext,
} from "../types.js";
import { resolveWalletMutationCommandContext } from "./wallet-mutation/context.js";
import { getWalletMutationCommandSpec } from "./wallet-mutation/registry.js";

export async function runWalletMutationCommand(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): Promise<number> {
  const runtimePaths = context.resolveWalletRuntimePaths();
  const stopWatcher = createOwnedLockCleanupSignalWatcher(
    context.signalSource,
    context.forceExit,
    [
      runtimePaths.walletControlLockPath,
      runtimePaths.miningControlLockPath,
      runtimePaths.bitcoindLockPath,
      runtimePaths.indexerDaemonLockPath,
    ],
  );

  try {
    const outcome = await waitForCompletionOrStop((async () => {
      const spec = getWalletMutationCommandSpec(parsed.command);
      if (spec === null) {
        writeLine(
          context.stderr,
          `wallet mutation command not implemented: ${parsed.command}`,
        );
        return 1;
      }

      const resolved = resolveWalletMutationCommandContext(
        parsed,
        context,
        runtimePaths,
      );
      const success = await spec.run(resolved);

      return writeMutationCommandSuccess(parsed, context, {
        ...success,
        interactive: resolved.interactive,
      });
    })(), stopWatcher);

    if (outcome.kind === "stopped") {
      return outcome.code;
    }

    return outcome.value;
  } catch (error) {
    return writeHandledCliError({
      parsed,
      stdout: context.stdout,
      stderr: context.stderr,
      error,
    });
  } finally {
    stopWatcher.cleanup();
  }
}
