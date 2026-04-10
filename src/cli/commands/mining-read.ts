import { dirname } from "node:path";
import { stat } from "node:fs/promises";

import { formatHooksStatusReport, formatMineStatusReport, formatMiningEventRecord } from "../mining-format.js";
import { writeLine } from "../io.js";
import { inspectWalletLocalState } from "../../wallet/read/index.js";
import {
  createErrorEnvelope,
  createSuccessEnvelope,
  describeCanonicalCommand,
  normalizeListPage,
  writeJsonValue,
} from "../output.js";
import { buildHooksStatusJson, buildMineLogJson, buildMineStatusJson } from "../read-json.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";
import { resolveWalletRuntimePathsForTesting } from "../../wallet/runtime.js";

async function readRotationIndices(): Promise<number[]> {
  const paths = resolveWalletRuntimePathsForTesting();
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
    await context.ensureDirectory(dirname(dbPath));

    if (parsed.command === "hooks-mining-status") {
      const localState = await inspectWalletLocalState({
        secretProvider: context.walletSecretProvider,
      });
      const view = await context.inspectMiningControlPlane({
        provider: context.walletSecretProvider,
        localState,
        bitcoind: {
          health: "unavailable",
          status: null,
          message: "Managed bitcoind status unavailable during hook inspection.",
        },
        nodeStatus: null,
        nodeHealth: "unavailable",
        indexer: {
          health: "unavailable",
          status: null,
          message: null,
          snapshotTip: null,
          source: "none",
          daemonInstanceId: null,
          snapshotSeq: null,
          openedAtUnixMs: null,
        },
        verify: parsed.verify,
      });
      if (parsed.outputMode === "json") {
        const result = buildHooksStatusJson(view);
        writeJsonValue(context.stdout, createSuccessEnvelope(
          "cogcoin/hooks-status/v1",
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
      writeLine(context.stdout, formatHooksStatusReport(view));
      return 0;
    }

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
            const result = buildMineLogJson(events, normalized.page, await readRotationIndices());
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
          const result = buildMineLogJson(events, normalized.page, await readRotationIndices());
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

    const readContext = await context.openWalletReadContext({
      dataDir,
      databasePath: dbPath,
      secretProvider: context.walletSecretProvider,
    });

    try {
      const mining = readContext.mining ?? await context.inspectMiningControlPlane({
          provider: context.walletSecretProvider,
          localState: readContext.localState,
          bitcoind: readContext.bitcoind,
          nodeStatus: readContext.nodeStatus,
          nodeHealth: readContext.nodeHealth,
          indexer: readContext.indexer,
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
        parsed.command === "hooks-mining-status"
          ? "cogcoin/hooks-status/v1"
          : parsed.command === "mine-log"
            ? "cogcoin/mine-log/v1"
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
