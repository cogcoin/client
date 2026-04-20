import { dirname } from "node:path";
import { stat } from "node:fs/promises";

import {
  formatMineStatusReport,
  formatMiningEventRecord,
  formatMiningPromptListReport,
} from "../mining-format.js";
import { writeLine } from "../io.js";
import {
  normalizeListPage,
} from "../output.js";
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

function getMinePromptListNextSteps(result: Awaited<ReturnType<RequiredCliRunnerContext["inspectMiningDomainPromptState"]>>): string[] {
  if (result.prompts.length === 0) {
    return ["cogcoin domains --mineable"];
  }

  const nextDomainPrompt = result.prompts.find((entry) => entry.mineable && entry.prompt === null);
  return nextDomainPrompt === undefined ? [] : [`cogcoin mine prompt ${nextDomainPrompt.domain.name}`];
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
          writeLine(context.stdout, "No mining events recorded yet.");
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
      const provider = withInteractiveWalletSecretProvider(
        context.walletSecretProvider,
        context.createPrompter(),
      );
      const readContext = await context.openWalletReadContext({
        dataDir,
        databasePath: dbPath,
        secretProvider: provider,
        expectedIndexerBinaryVersion: packageVersion,
        paths: runtimePaths,
      });

      try {
        const result = await context.inspectMiningDomainPromptState({
          paths: runtimePaths,
          provider,
          readContext,
        });

        writeLine(context.stdout, formatMiningPromptListReport(result));
        for (const line of formatNextStepLines(getMinePromptListNextSteps(result))) {
          writeLine(context.stdout, line);
        }
        return 0;
      } finally {
        await readContext.close();
      }
    }

    const provider = withInteractiveWalletSecretProvider(
      context.walletSecretProvider,
      context.createPrompter(),
    );
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
      writeLine(context.stdout, formatMineStatusReport(mining));
      return 0;
    } finally {
      await readContext.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeLine(context.stderr, message);
    return 5;
  }
}
