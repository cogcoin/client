import { writeLine } from "../io.js";
import {
  createMutationSuccessEnvelope,
  describeCanonicalCommand,
  resolveStableMutationJsonSchema,
  writeHandledCliError,
  writeJsonValue,
} from "../output.js";
import {
  CLI_INSTALL_COMMAND,
  EXPLICIT_UPDATE_CHECK_TIMEOUT_MS,
  applyUpdateCheckResult,
  compareSemver,
  createEmptyUpdateCheckCache,
  fetchLatestPublishedVersion,
  loadUpdateCheckCache,
  persistUpdateCheckCache,
} from "../update-service.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";

interface UpdateCommandResult {
  currentVersion: string;
  latestVersion: string;
  installCommand: typeof CLI_INSTALL_COMMAND;
  status: "up-to-date" | "updated" | "canceled";
  applied: boolean;
}

function createUpdateResult(
  currentVersion: string,
  latestVersion: string,
  status: UpdateCommandResult["status"],
  applied: boolean,
): UpdateCommandResult {
  return {
    currentVersion,
    latestVersion,
    installCommand: CLI_INSTALL_COMMAND,
    status,
    applied,
  };
}

function writeVersionSummary(
  context: RequiredCliRunnerContext,
  currentVersion: string,
  latestVersion: string,
): void {
  writeLine(context.stdout, `Current version: ${currentVersion}`);
  writeLine(context.stdout, `Latest version: ${latestVersion}`);
  writeLine(context.stdout, `Run: ${CLI_INSTALL_COMMAND}`);
}

async function confirmApplyUpdate(context: RequiredCliRunnerContext): Promise<boolean> {
  const prompter = context.createPrompter();

  if (!prompter.isInteractive) {
    throw new Error("cli_update_requires_tty");
  }

  while (true) {
    const answer = (await prompter.prompt("Install update now? [Y/n]: ")).trim().toLowerCase();

    if (answer === "" || answer === "y" || answer === "yes") {
      return true;
    }

    if (answer === "n" || answer === "no") {
      return false;
    }

    prompter.writeLine("Enter \"y\" to continue or \"n\" to cancel.");
  }
}

function writeSuccessJson(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
  result: UpdateCommandResult,
): number {
  writeJsonValue(context.stdout, createMutationSuccessEnvelope(
    resolveStableMutationJsonSchema(parsed)!,
    describeCanonicalCommand(parsed),
    result.status,
    result,
  ));
  return 0;
}

export async function runUpdateCommand(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): Promise<number> {
  try {
    const currentVersion = await context.readPackageVersion();
    const cachePath = context.resolveUpdateCheckStatePath();
    const now = context.now();
    const cache = await loadUpdateCheckCache(cachePath) ?? createEmptyUpdateCheckCache();
    const updateResult = await fetchLatestPublishedVersion(context.fetchImpl, {
      timeoutMs: EXPLICIT_UPDATE_CHECK_TIMEOUT_MS,
    });

    if (updateResult.kind !== "success") {
      throw new Error("cli_update_registry_unavailable");
    }

    await persistUpdateCheckCache(cachePath, applyUpdateCheckResult(cache, updateResult, now));

    const latestVersion = updateResult.latestVersion;
    const comparison = compareSemver(latestVersion, currentVersion);

    if (comparison === null) {
      throw new Error("cli_update_registry_unavailable");
    }

    if (comparison <= 0) {
      const result = createUpdateResult(currentVersion, latestVersion, "up-to-date", false);

      if (parsed.outputMode === "json") {
        return writeSuccessJson(parsed, context, result);
      }

      writeVersionSummary(context, currentVersion, latestVersion);
      writeLine(context.stdout, "Cogcoin is already up to date.");
      return 0;
    }

    if (!parsed.assumeYes) {
      if (parsed.outputMode !== "text") {
        throw new Error("cli_update_requires_tty");
      }

      writeVersionSummary(context, currentVersion, latestVersion);

      if (!(await confirmApplyUpdate(context))) {
        writeLine(context.stdout, "Update canceled.");
        return 0;
      }
    } else if (parsed.outputMode === "text") {
      writeVersionSummary(context, currentVersion, latestVersion);
    }

    if (parsed.outputMode === "text") {
      writeLine(context.stdout, "Installing update...");
    }

    await context.runGlobalClientUpdateInstall({
      stdout: parsed.outputMode === "json" ? context.stderr : context.stdout,
      stderr: context.stderr,
      env: context.env,
    });

    const result = createUpdateResult(currentVersion, latestVersion, "updated", true);

    if (parsed.outputMode === "json") {
      return writeSuccessJson(parsed, context, result);
    }

    writeLine(context.stdout, "Update completed. The next cogcoin invocation will use the new install.");
    return 0;
  } catch (error) {
    return writeHandledCliError({
      parsed,
      stdout: context.stdout,
      stderr: context.stderr,
      error,
    });
  }
}
