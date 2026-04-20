import { dirname } from "node:path";

import { formatBalanceReport, formatWalletOverviewReport } from "../wallet-format.js";
import { writeLine } from "../io.js";
import { createTerminalPrompter } from "../prompt.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";
import { withInteractiveWalletSecretProvider } from "../../wallet/state/provider.js";

export async function runStatusCommand(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): Promise<number> {
  const dbPath = parsed.dbPath ?? context.resolveDefaultClientDatabasePath();
  const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
  const packageVersion = await context.readPackageVersion();
  const runtimePaths = context.resolveWalletRuntimePaths();
  await context.ensureDirectory(dirname(dbPath));
  const provider = withInteractiveWalletSecretProvider(
    context.walletSecretProvider,
    context.createPrompter?.() ?? createTerminalPrompter(context.stdin, context.stdout),
  );
  const readContext = await context.openWalletReadContext({
    dataDir,
    databasePath: dbPath,
    secretProvider: provider,
    expectedIndexerBinaryVersion: packageVersion,
    paths: runtimePaths,
  });

  try {
    writeLine(context.stdout, formatWalletOverviewReport(readContext, packageVersion));
    writeLine(context.stdout, formatBalanceReport(readContext));
    return 0;
  } finally {
    await readContext.close();
  }
}
