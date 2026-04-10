import {
  buildHooksDisableMiningData,
  buildHooksEnableMiningData,
  buildMineSetupData,
} from "../mining-json.js";
import { buildHooksPreviewData } from "../preview-json.js";
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
  getHooksEnableMiningNextSteps,
  getMineSetupNextSteps,
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

export async function runMiningAdminCommand(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): Promise<number> {
  try {
    const provider = context.walletSecretProvider;

    if (parsed.command === "hooks-mining-enable") {
      const prompter = createCommandPrompter(parsed, context);
      const view = await context.enableMiningHooks({
        provider,
        prompter,
      });
      const nextSteps = getHooksEnableMiningNextSteps();
      if (parsed.outputMode === "preview-json") {
        writeJsonValue(context.stdout, createPreviewSuccessEnvelope(
          resolvePreviewJsonSchema(parsed)!,
          describeCanonicalCommand(parsed),
          "enabled",
          buildHooksPreviewData("hooks-enable-mining", view),
          {
            nextSteps,
          },
        ));
        return 0;
      }
      if (parsed.outputMode === "json") {
        writeJsonValue(context.stdout, createMutationSuccessEnvelope(
          resolveStableMiningControlJsonSchema(parsed)!,
          "cogcoin hooks enable mining",
          "enabled",
          buildHooksEnableMiningData(view),
          {
            nextSteps,
          },
        ));
        return 0;
      }
      writeLine(context.stdout, "Custom mining hook enabled.");
      for (const line of formatNextStepLines(nextSteps)) {
        writeLine(context.stdout, line);
      }
      return 0;
    }

    if (parsed.command === "hooks-mining-disable") {
      const view = await context.disableMiningHooks({
        provider,
      });
      if (parsed.outputMode === "preview-json") {
        writeJsonValue(context.stdout, createPreviewSuccessEnvelope(
          resolvePreviewJsonSchema(parsed)!,
          describeCanonicalCommand(parsed),
          "disabled",
          buildHooksPreviewData("hooks-disable-mining", view),
        ));
        return 0;
      }
      if (parsed.outputMode === "json") {
        writeJsonValue(context.stdout, createMutationSuccessEnvelope(
          resolveStableMiningControlJsonSchema(parsed)!,
          "cogcoin hooks disable mining",
          "disabled",
          buildHooksDisableMiningData(view),
        ));
        return 0;
      }
      writeLine(context.stdout, "Mining hooks switched back to builtin mode.");
      return 0;
    }

    if (parsed.command === "mine-setup") {
      const prompter = createCommandPrompter(parsed, context);
      const view = await context.setupBuiltInMining({
        provider,
        prompter,
      });
      const nextSteps = getMineSetupNextSteps();
      if (parsed.outputMode === "preview-json") {
        writeJsonValue(context.stdout, createPreviewSuccessEnvelope(
          resolvePreviewJsonSchema(parsed)!,
          describeCanonicalCommand(parsed),
          "configured",
          buildHooksPreviewData("mine-setup", view),
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
