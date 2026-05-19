import { dirname } from "node:path";

import { formatBalanceReport, formatWalletOverviewReport } from "../wallet-format.js";
import { formatStatusReport } from "../status-format.js";
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
  const runtimePaths = context.resolveWalletRuntimePaths();
  const packageVersion = await context.readPackageVersion();

  if (!parsed.statusLive) {
    const status = await context.inspectPassiveClientStatus(dbPath, dataDir, runtimePaths);
    writeLine(context.stdout, formatStatusReport(status, packageVersion, {
      nowUnixMs: context.now(),
    }));
    return 0;
  }

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
