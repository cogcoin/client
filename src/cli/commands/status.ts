import { dirname } from "node:path";

import { buildStatusJson } from "../read-json.js";
import { formatWalletOverviewReport } from "../wallet-format.js";
import { writeLine } from "../io.js";
import { createSuccessEnvelope, describeCanonicalCommand, writeJsonValue } from "../output.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";

export async function runStatusCommand(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): Promise<number> {
  const dbPath = parsed.dbPath ?? context.resolveDefaultClientDatabasePath();
  const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
  const runtimePaths = context.resolveWalletRuntimePaths(parsed.seedName);
  await context.ensureDirectory(dirname(dbPath));
  const readContext = await context.openWalletReadContext({
    dataDir,
    databasePath: dbPath,
    secretProvider: context.walletSecretProvider,
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

    writeLine(context.stdout, formatWalletOverviewReport(readContext));
    return 0;
  } finally {
    await readContext.close();
  }
}
