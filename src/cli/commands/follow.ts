import { dirname } from "node:path";

import { resolveWalletRootIdFromLocalArtifacts } from "../../wallet/root-resolution.js";
import { usesTtyProgress, writeLine } from "../io.js";
import { classifyCliError } from "../output.js";
import { createStopSignalWatcher } from "../signals.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";

export async function runFollowCommand(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): Promise<number> {
  const dbPath = parsed.dbPath ?? context.resolveDefaultClientDatabasePath();
  const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
  const walletRoot = await resolveWalletRootIdFromLocalArtifacts({
    paths: context.resolveWalletRuntimePaths(),
    provider: context.walletSecretProvider,
    loadRawWalletStateEnvelope: context.loadRawWalletStateEnvelope,
    loadUnlockSession: context.loadUnlockSession,
    loadWalletExplicitLock: context.loadWalletExplicitLock,
  });
  await context.ensureDirectory(dirname(dbPath));
  const store = await context.openSqliteStore({ filename: dbPath });
  let storeOwned = true;

  try {
    const client = await context.openManagedBitcoindClient({
      store,
      databasePath: dbPath,
      dataDir,
      walletRootId: walletRoot.walletRootId,
      progressOutput: parsed.progressOutput,
    });
    storeOwned = false;
    const stopWatcher = createStopSignalWatcher(context.signalSource, context.stderr, client, context.forceExit);

    try {
      await client.startFollowingTip();

      if (!usesTtyProgress(parsed.progressOutput, context.stderr)) {
        writeLine(context.stdout, "Following managed Cogcoin tip. Press Ctrl-C to stop.");
      }

      return await stopWatcher.promise;
    } catch (error) {
      writeLine(context.stderr, `follow failed: ${error instanceof Error ? error.message : String(error)}`);
      await client.close().catch(() => undefined);
      return classifyCliError(error).exitCode;
    } finally {
      stopWatcher.cleanup();
    }
  } catch (error) {
    writeLine(context.stderr, `follow failed: ${error instanceof Error ? error.message : String(error)}`);
    if (storeOwned) {
      await store.close().catch(() => undefined);
    }
    return classifyCliError(error).exitCode;
  }
}
