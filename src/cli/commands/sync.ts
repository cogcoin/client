import { dirname } from "node:path";

import { formatManagedSyncErrorMessage } from "../../bitcoind/errors.js";
import { writeLine } from "../io.js";
import { classifyCliError } from "../output.js";
import { createStopSignalWatcher, waitForCompletionOrStop } from "../signals.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";

export async function runSyncCommand(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): Promise<number> {
  const dbPath = parsed.dbPath ?? context.resolveDefaultClientDatabasePath();
  const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
  await context.ensureDirectory(dirname(dbPath));
  const store = await context.openSqliteStore({ filename: dbPath });
  let storeOwned = true;

  try {
    const client = await context.openManagedBitcoindClient({
      store,
      databasePath: dbPath,
      dataDir,
      progressOutput: parsed.progressOutput,
    });
    storeOwned = false;
    const stopWatcher = createStopSignalWatcher(context.signalSource, context.stderr, client, context.forceExit);

    try {
      const syncOutcome = await waitForCompletionOrStop(client.syncToTip(), stopWatcher);

      if (syncOutcome.kind === "stopped") {
        return syncOutcome.code;
      }

      const result = syncOutcome.value;

      if (typeof client.playSyncCompletionScene === "function") {
        const completionOutcome = await waitForCompletionOrStop(
          client.playSyncCompletionScene().catch(() => undefined),
          stopWatcher,
        );

        if (completionOutcome.kind === "stopped") {
          return completionOutcome.code;
        }
      }

      writeLine(context.stdout, `Applied blocks: ${result.appliedBlocks}`);
      writeLine(context.stdout, `Rewound blocks: ${result.rewoundBlocks}`);
      writeLine(context.stdout, `Indexed ending height: ${result.endingHeight ?? "none"}`);
      writeLine(context.stdout, `Node best height: ${result.bestHeight}`);
      return 0;
    } finally {
      stopWatcher.cleanup();
      await client.close();
    }
  } catch (error) {
    const message = formatManagedSyncErrorMessage(error instanceof Error ? error.message : String(error));
    writeLine(context.stderr, `sync failed: ${message}`);
    if (storeOwned) {
      await store.close().catch(() => undefined);
    }
    return classifyCliError(error).exitCode;
  }
}
