import { dirname } from "node:path";

import {
  buildMineStartData,
  buildMineStopData,
} from "../mining-json.js";
import {
  buildMineStartPreviewData,
  buildMineStopPreviewData,
} from "../preview-json.js";
import { writeLine } from "../io.js";
import { createTerminalPrompter } from "../prompt.js";
import {
  createPreviewSuccessEnvelope,
  createMutationSuccessEnvelope,
  describeCanonicalCommand,
  resolvePreviewJsonSchema,
  resolveStableMiningControlJsonSchema,
  writeHandledCliError,
  writeJsonValue,
} from "../output.js";
import {
  formatNextStepLines,
  getMineStopNextSteps,
} from "../workflow-hints.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";

function createCommandPrompter(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
) {
  return parsed.outputMode !== "text"
    ? createTerminalPrompter(context.stdin, context.stderr)
    : context.createPrompter();
}

export async function runMiningRuntimeCommand(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): Promise<number> {
  try {
    const dbPath = parsed.dbPath ?? context.resolveDefaultClientDatabasePath();
    const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
    const provider = context.walletSecretProvider;
    const runtimePaths = context.resolveWalletRuntimePaths(parsed.seedName);
    await context.ensureDirectory(dirname(dbPath));

    if (parsed.command === "mine") {
      const abortController = new AbortController();
      const onStop = (): void => {
        abortController.abort();
      };

      context.signalSource.on("SIGINT", onStop);
      context.signalSource.on("SIGTERM", onStop);

      try {
        await context.runForegroundMining({
          dataDir,
          databasePath: dbPath,
          provider,
          prompter: context.createPrompter(),
          signal: abortController.signal,
          stdout: context.stdout,
          stderr: context.stderr,
          progressOutput: parsed.progressOutput,
          paths: runtimePaths,
        });
      } finally {
        context.signalSource.off("SIGINT", onStop);
        context.signalSource.off("SIGTERM", onStop);
      }

      return 0;
    }

    if (parsed.command === "mine-start") {
      const result = await context.startBackgroundMining({
        dataDir,
        databasePath: dbPath,
        provider,
        prompter: createCommandPrompter(parsed, context),
        paths: runtimePaths,
      });

      if (parsed.outputMode === "preview-json") {
        writeJsonValue(context.stdout, createPreviewSuccessEnvelope(
          resolvePreviewJsonSchema(parsed)!,
          describeCanonicalCommand(parsed),
          result.started ? "started" : "already-active",
          buildMineStartPreviewData(result),
        ));
        return 0;
      }

      if (parsed.outputMode === "json") {
        writeJsonValue(context.stdout, createMutationSuccessEnvelope(
          resolveStableMiningControlJsonSchema(parsed)!,
          "cogcoin mine start",
          result.started ? "started" : "already-active",
          buildMineStartData(result),
        ));
        return 0;
      }

      if (!result.started) {
        writeLine(context.stdout, "Background mining is already active.");
        if (result.snapshot?.backgroundWorkerPid !== null && result.snapshot?.backgroundWorkerPid !== undefined) {
          writeLine(context.stdout, `Worker pid: ${result.snapshot.backgroundWorkerPid}`);
        }
        return 0;
      }

      writeLine(context.stdout, "Started background mining.");
      if (result.snapshot?.backgroundWorkerPid !== null && result.snapshot?.backgroundWorkerPid !== undefined) {
        writeLine(context.stdout, `Worker pid: ${result.snapshot.backgroundWorkerPid}`);
      }
      return 0;
    }

    if (parsed.command === "mine-stop") {
      const snapshot = await context.stopBackgroundMining({
        dataDir,
        databasePath: dbPath,
        provider,
        paths: runtimePaths,
      });
      const nextSteps = getMineStopNextSteps();
      if (parsed.outputMode === "preview-json") {
        writeJsonValue(context.stdout, createPreviewSuccessEnvelope(
          resolvePreviewJsonSchema(parsed)!,
          describeCanonicalCommand(parsed),
          snapshot === null ? "not-active" : "stopped",
          buildMineStopPreviewData(snapshot),
          {
            nextSteps,
          },
        ));
        return 0;
      }
      if (parsed.outputMode === "json") {
        writeJsonValue(context.stdout, createMutationSuccessEnvelope(
          resolveStableMiningControlJsonSchema(parsed)!,
          "cogcoin mine stop",
          snapshot === null ? "not-active" : "stopped",
          buildMineStopData(snapshot),
          {
            nextSteps,
          },
        ));
        return 0;
      }
      writeLine(context.stdout, snapshot?.note ?? "Background mining was not active.");
      for (const line of formatNextStepLines(nextSteps)) {
        writeLine(context.stdout, line);
      }
      return 0;
    }

    writeLine(context.stderr, `mining runtime command not implemented: ${parsed.command}`);
    return 1;
  } catch (error) {
    return writeHandledCliError({
      parsed,
      stdout: context.stdout,
      stderr: context.stderr,
      error,
    });
  }
}
