import { dirname } from "node:path";
import { stat } from "node:fs/promises";

import {
  formatMineStatusReport,
  formatMiningEventRecord,
  formatMiningPromptListReport,
} from "../mining-format.js";
import { writeLine } from "../io.js";
import {
  createErrorEnvelope,
  createSuccessEnvelope,
  describeCanonicalCommand,
  normalizeListPage,
  writeJsonValue,
} from "../output.js";
import { buildMineLogJson, buildMinePromptListJson, buildMineStatusJson } from "../read-json.js";
import { formatNextStepLines } from "../workflow-hints.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";
import { withInteractiveWalletSecretProvider } from "../../wallet/state/provider.js";

async function readRotationIndices(paths: {
  miningEventsPath: string;
}): Promise<number[]> {
  const rotation: number[] = [];

  for (let index = 1; index <= 4; index += 1) {
    try {
      await stat(`${paths.miningEventsPath}.${index}`);
      rotation.push(index);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return rotation;
}

export async function runMiningReadCommand(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): Promise<number> {
  try {
    const dbPath = parsed.dbPath ?? context.resolveDefaultClientDatabasePath();
    const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
    const packageVersion = await context.readPackageVersion();
    const runtimePaths = context.resolveWalletRuntimePaths();
    await context.ensureDirectory(dirname(dbPath));

    if (parsed.command === "mine-log") {
      if (!parsed.follow) {
        const allEvents = await context.readMiningLog({
          all: true,
        });
        const defaultLimit = 50;
        const normalized = normalizeListPage(allEvents.slice().reverse(), {
          limit: parsed.listLimit,
          all: parsed.listAll,
          defaultLimit,
        });
        const events = normalized.items.slice().reverse();

        if (events.length === 0) {
          if (parsed.outputMode === "json") {
            const result = buildMineLogJson(events, normalized.page, await readRotationIndices(runtimePaths));
            writeJsonValue(context.stdout, createSuccessEnvelope(
              "cogcoin/mine-log/v1",
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

          writeLine(context.stdout, "No mining events recorded yet.");
          return 0;
        }

        if (parsed.outputMode === "json") {
          const result = buildMineLogJson(events, normalized.page, await readRotationIndices(runtimePaths));
          writeJsonValue(context.stdout, createSuccessEnvelope(
            "cogcoin/mine-log/v1",
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

        for (const event of events) {
          writeLine(context.stdout, formatMiningEventRecord(event));
        }

        if (normalized.page.truncated && normalized.page.limit !== null && normalized.page.totalKnown !== null) {
          writeLine(context.stdout, `Showing latest ${normalized.page.returned} of ${normalized.page.totalKnown}. Use --limit <n> or --all for more.`);
        }

        return 0;
      }

      const abortController = new AbortController();
      const onStop = (): void => {
        abortController.abort();
      };

      context.signalSource.on("SIGINT", onStop);
      context.signalSource.on("SIGTERM", onStop);

      try {
        await context.followMiningLog({
          signal: abortController.signal,
          onEvent: (event) => {
            writeLine(context.stdout, formatMiningEventRecord(event));
          },
        });
      } finally {
        context.signalSource.off("SIGINT", onStop);
        context.signalSource.off("SIGTERM", onStop);
      }

      return 0;
    }

    if (parsed.command === "mine-prompt-list") {
      const provider = parsed.outputMode === "text"
        ? withInteractiveWalletSecretProvider(context.walletSecretProvider, context.createPrompter())
        : context.walletSecretProvider;
      const readContext = await context.openWalletReadContext({
        dataDir,
        databasePath: dbPath,
        secretProvider: provider,
        expectedIndexerBinaryVersion: packageVersion,
        paths: runtimePaths,
      });

      try {
        const result = buildMinePromptListJson(await context.inspectMiningDomainPromptState({
          paths: runtimePaths,
          provider,
          readContext,
        }));

        if (parsed.outputMode === "json") {
          writeJsonValue(context.stdout, createSuccessEnvelope(
            "cogcoin/mine-prompt-list/v1",
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

        writeLine(context.stdout, formatMiningPromptListReport(result.data));
        for (const line of formatNextStepLines(result.nextSteps)) {
          writeLine(context.stdout, line);
        }
        return 0;
      } finally {
        await readContext.close();
      }
    }

      const provider = parsed.outputMode === "text"
        ? withInteractiveWalletSecretProvider(context.walletSecretProvider, context.createPrompter())
        : context.walletSecretProvider;
      const readContext = await context.openWalletReadContext({
        dataDir,
        databasePath: dbPath,
        secretProvider: provider,
        expectedIndexerBinaryVersion: packageVersion,
        paths: runtimePaths,
      });

    try {
        const mining = readContext.mining ?? await context.inspectMiningControlPlane({
          provider,
          localState: readContext.localState,
          bitcoind: readContext.bitcoind,
          nodeStatus: readContext.nodeStatus,
          nodeHealth: readContext.nodeHealth,
          indexer: readContext.indexer,
          paths: runtimePaths,
        });
      if (parsed.outputMode === "json") {
        const result = buildMineStatusJson(mining);
        writeJsonValue(context.stdout, createSuccessEnvelope(
          "cogcoin/mine-status/v1",
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
      writeLine(context.stdout, formatMineStatusReport(mining));
      return 0;
    } finally {
      await readContext.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (parsed.outputMode === "json") {
      writeJsonValue(context.stdout, createErrorEnvelope(
        parsed.command === "mine-log"
          ? "cogcoin/mine-log/v1"
          : parsed.command === "mine-prompt-list"
            ? "cogcoin/mine-prompt-list/v1"
          : "cogcoin/mine-status/v1",
        describeCanonicalCommand(parsed),
        message,
        message,
      ));
      return 5;
    }
    writeLine(context.stderr, message);
    return 5;
  }
}
