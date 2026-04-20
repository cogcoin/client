import { dirname } from "node:path";

import { formatMiningPromptMutationReport } from "../mining-format.js";
import { writeLine } from "../io.js";
import { writeHandledCliError } from "../output.js";
import { formatNextStepLines, getMineSetupNextSteps } from "../workflow-hints.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";
import { withInteractiveWalletSecretProvider } from "../../wallet/state/provider.js";

function createCommandPrompter(
  context: RequiredCliRunnerContext,
) {
  return context.createPrompter();
}

export async function runMiningAdminCommand(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): Promise<number> {
  try {
    const runtimePaths = context.resolveWalletRuntimePaths();
    const dbPath = parsed.dbPath ?? context.resolveDefaultClientDatabasePath();
    const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
    const packageVersion = await context.readPackageVersion();

    if (parsed.command === "mine-setup") {
      const prompter = createCommandPrompter(context);
      const provider = withInteractiveWalletSecretProvider(context.walletSecretProvider, prompter);
      const view = await context.setupBuiltInMining({
        provider,
        prompter,
        paths: runtimePaths,
      });
      const nextSteps = getMineSetupNextSteps();
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

    if (parsed.command === "mine-prompt") {
      const prompter = createCommandPrompter(context);
      if (!prompter.isInteractive) {
        throw new Error("mine_prompt_requires_tty");
      }

      const provider = withInteractiveWalletSecretProvider(context.walletSecretProvider, prompter);
      await context.ensureDirectory(dirname(dbPath));
      const readContext = await context.openWalletReadContext({
        dataDir,
        databasePath: dbPath,
        secretProvider: provider,
        expectedIndexerBinaryVersion: packageVersion,
        paths: runtimePaths,
      });

      try {
        const targetDomain = parsed.args[0]!.trim().toLowerCase();
        const promptState = await context.inspectMiningDomainPromptState({
          paths: runtimePaths,
          provider,
          readContext,
        });
        const currentEntry = promptState.prompts.find((entry) => entry.domain.name === targetDomain);

        if (currentEntry === undefined) {
          throw new Error("mine_prompt_domain_not_mineable");
        }

        writeLine(context.stdout, `Domain: ${currentEntry.domain.name}`);
        writeLine(context.stdout, `Current domain prompt: ${currentEntry.prompt ?? "none"}`);
        writeLine(context.stdout, `Global fallback prompt: ${promptState.fallbackPromptConfigured ? "configured" : "not configured"}`);

        const nextPrompt = await prompter.prompt("Domain prompt (blank to clear and use the global fallback): ");
        const result = await context.updateMiningDomainPrompt({
          paths: runtimePaths,
          provider,
          readContext,
          domainName: targetDomain,
          prompt: nextPrompt,
        });

        writeLine(context.stdout, formatMiningPromptMutationReport(result));
        return 0;
      } finally {
        await readContext.close();
      }
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
