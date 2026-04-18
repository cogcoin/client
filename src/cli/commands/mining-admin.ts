import {
  buildMineSetupData,
} from "../mining-json.js";
import { buildMineSetupPreviewData } from "../preview-json.js";
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
  getMineSetupNextSteps,
} from "../workflow-hints.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";
import { withInteractiveWalletSecretProvider } from "../../wallet/state/provider.js";

function createCommandPrompter(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
) {
  return parsed.outputMode !== "text"
    ? createTerminalPrompter(context.stdin, context.stderr)
    : context.createPrompter();
}

export async function runMiningAdminCommand(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): Promise<number> {
  try {
    const runtimePaths = context.resolveWalletRuntimePaths(parsed.seedName);

    if (parsed.command === "mine-setup") {
      const prompter = createCommandPrompter(parsed, context);
      const provider = withInteractiveWalletSecretProvider(context.walletSecretProvider, prompter);
      const view = await context.setupBuiltInMining({
        provider,
        prompter,
        paths: runtimePaths,
      });
      const nextSteps = getMineSetupNextSteps();
      if (parsed.outputMode === "preview-json") {
        writeJsonValue(context.stdout, createPreviewSuccessEnvelope(
          resolvePreviewJsonSchema(parsed)!,
          describeCanonicalCommand(parsed),
          "configured",
          buildMineSetupPreviewData(view),
          {
            nextSteps,
          },
        ));
        return 0;
      }
      if (parsed.outputMode === "json") {
        writeJsonValue(context.stdout, createMutationSuccessEnvelope(
          resolveStableMiningControlJsonSchema(parsed)!,
          "cogcoin mine setup",
          "configured",
          buildMineSetupData(view),
          {
            nextSteps,
          },
        ));
        return 0;
      }
      writeLine(context.stdout, "Built-in mining provider configured.");
      writeLine(context.stdout, `Provider: ${view.provider.provider ?? "unknown"}`);
      if (view.provider.modelId !== null) {
        writeLine(context.stdout, `Selected model: ${view.provider.modelId}`);
      }
      if (view.provider.modelSelectionSource !== null) {
        writeLine(context.stdout, `Selection source: ${view.provider.modelSelectionSource}`);
      }
      if (view.provider.estimatedDailyCostDisplay !== null) {
        writeLine(context.stdout, `Approximate daily cost: ${view.provider.estimatedDailyCostDisplay}`);
      }
      for (const line of formatNextStepLines(nextSteps)) {
        writeLine(context.stdout, line);
      }
      return 0;
    }

    writeLine(context.stderr, `mining admin command not implemented: ${parsed.command}`);
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
