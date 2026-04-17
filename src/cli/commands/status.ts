import { dirname } from "node:path";

import { buildStatusJson } from "../read-json.js";
import { formatWalletOverviewReport } from "../wallet-format.js";
import { writeLine } from "../io.js";
import { createTerminalPrompter } from "../prompt.js";
import { createSuccessEnvelope, describeCanonicalCommand, writeJsonValue } from "../output.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";
import { withInteractiveWalletSecretProvider } from "../../wallet/state/provider.js";

export async function runStatusCommand(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): Promise<number> {
  const dbPath = parsed.dbPath ?? context.resolveDefaultClientDatabasePath();
  const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
  const runtimePaths = context.resolveWalletRuntimePaths(parsed.seedName);
  await context.ensureDirectory(dirname(dbPath));
  const provider = parsed.outputMode === "text"
    ? withInteractiveWalletSecretProvider(
      context.walletSecretProvider,
      context.createPrompter?.() ?? createTerminalPrompter(context.stdin, context.stdout),
    )
    : context.walletSecretProvider;
  const readContext = await context.openWalletReadContext({
    dataDir,
    databasePath: dbPath,
    secretProvider: provider,
    paths: runtimePaths,
  });

  try {
    if (parsed.outputMode === "json") {
      const result = buildStatusJson(readContext);
      writeJsonValue(context.stdout, createSuccessEnvelope(
        "cogcoin/status/v1",
        describeCanonicalCommand(parsed),
        result.data,
        {
          warnings: result.warnings,
          explanations: result.explanations,
          nextSteps: result.nextSteps,
        },
      ));
      return 0;
    }

    writeLine(context.stdout, formatWalletOverviewReport(readContext, await context.readPackageVersion()));
    return 0;
  } finally {
    await readContext.close();
  }
}
