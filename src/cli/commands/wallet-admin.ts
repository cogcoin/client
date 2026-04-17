import {
  buildInitMutationData,
  buildResetMutationData,
  buildRestoreMutationData,
  buildWalletDeleteMutationData,
  buildRepairMutationData,
} from "../mutation-json.js";
import {
  buildResetPreviewData,
  buildRepairPreviewData,
} from "../preview-json.js";
import { writeLine } from "../io.js";
import { createTerminalPrompter } from "../prompt.js";
import {
  createPreviewSuccessEnvelope,
  createMutationSuccessEnvelope,
  describeCanonicalCommand,
  resolvePreviewJsonSchema,
  resolveStableMutationJsonSchema,
  writeHandledCliError,
  writeJsonValue,
} from "../output.js";
import { loadWelcomeArtText } from "../art.js";
import {
  formatNextStepLines,
  getFundingQuickstartGuidance,
  getInitNextSteps,
  getRestoreNextSteps,
  getSetupUnlockGuidanceLines,
} from "../workflow-hints.js";
import {
  createOwnedLockCleanupSignalWatcher,
  waitForCompletionOrStop,
} from "../signals.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";
import type { WalletRepairResult, WalletResetResult } from "../../wallet/lifecycle.js";
import { CLIENT_PASSWORD_SETUP_AUTO_UNLOCK_SECONDS } from "../../wallet/state/client-password.js";
import { withInteractiveWalletSecretProvider } from "../../wallet/state/provider.js";

function createCommandPrompter(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
) {
  return parsed.outputMode !== "text"
    ? createTerminalPrompter(context.stdin, context.stderr)
    : context.createPrompter();
}

function getRepairWarnings(result: WalletRepairResult): string[] {
  return result.miningResumeAction === "resume-failed"
    ? [`Wallet repair succeeded, but background mining did not resume automatically: ${result.miningResumeError ?? "unknown error"}`]
    : [];
}

function getResetWarnings(result: WalletResetResult): string[] {
  return result.secretCleanupStatus === "unknown"
    ? ["Some existing Cogcoin secret-provider entries could not be discovered from the remaining local wallet artifacts and may need manual cleanup."]
    : [];
}

function writeSetupUnlockGuidance(stdout: RequiredCliRunnerContext["stdout"]): void {
  for (const line of getSetupUnlockGuidanceLines(CLIENT_PASSWORD_SETUP_AUTO_UNLOCK_SECONDS)) {
    writeLine(stdout, line);
  }
}

function getResetNextSteps(result: WalletResetResult): string[] {
  return result.walletAction === "deleted" || result.walletAction === "not-present"
    ? ["Run `cogcoin init` to create a new wallet."]
    : ["Run `cogcoin sync` to bootstrap assumeutxo and the managed Bitcoin/indexer state."];
}

function formatResetBitcoinDataDirStatus(result: WalletResetResult): string {
  if (result.bitcoinDataDir.status === "outside-reset-scope") {
    return "preserved (outside reset scope)";
  }

  return result.bitcoinDataDir.status;
}

interface ResetTextEntry {
  text: string;
  ok: boolean;
}

function resetTextEntry(label: string, value: string, ok: boolean): ResetTextEntry {
  return {
    text: `${label}: ${value}`,
    ok,
  };
}

function formatResetSection(header: string, entries: readonly ResetTextEntry[]): string {
  return [header, ...entries.map((entry) => `${entry.ok ? "✓" : "✗"} ${entry.text}`)].join("\n");
}

function formatResetResultText(result: WalletResetResult): string {
  const warnings = getResetWarnings(result);
  const nextStep = getResetNextSteps(result)[0] ?? null;
  const secretCleanupOk = result.secretCleanupStatus !== "unknown" && result.secretCleanupStatus !== "failed";
  const managedCleanupOk = result.stoppedProcesses.survivors === 0;
  const outcomeEntries: ResetTextEntry[] = [
    resetTextEntry("Wallet action", result.walletAction, true),
    resetTextEntry("Snapshot", result.bootstrapSnapshot.status, true),
    resetTextEntry("Bitcoin datadir", formatResetBitcoinDataDirStatus(result), true),
    resetTextEntry("Secret cleanup", result.secretCleanupStatus, secretCleanupOk),
  ];

  if (result.walletAction !== "retain-mnemonic" && result.walletOldRootId !== null) {
    outcomeEntries.push(resetTextEntry("Previous wallet root", result.walletOldRootId, true));
  }

  if (result.walletAction !== "retain-mnemonic" && result.walletNewRootId !== null) {
    outcomeEntries.push(resetTextEntry("New wallet root", result.walletNewRootId, true));
  }

  const sections = [
    formatResetSection("Paths", [
      resetTextEntry("Data root", result.dataRoot, true),
    ]),
    formatResetSection("Reset Outcome", outcomeEntries),
    formatResetSection("Managed Cleanup", [
      resetTextEntry(
        "Managed bitcoind processes stopped",
        String(result.stoppedProcesses.managedBitcoind),
        managedCleanupOk,
      ),
      resetTextEntry(
        "Indexer daemons stopped",
        String(result.stoppedProcesses.indexerDaemon),
        managedCleanupOk,
      ),
      resetTextEntry(
        "Background miners stopped",
        String(result.stoppedProcesses.backgroundMining),
        managedCleanupOk,
      ),
    ]),
  ];

  if (warnings.length > 0) {
    sections.push(formatResetSection(
      "Warnings",
      warnings.map((warning) => resetTextEntry("Warning", warning, false)),
    ));
  }

  const parts = [
    "\n⛭ Cogcoin Reset ⛭",
    ...sections,
  ];

  if (nextStep !== null) {
    parts.push(`Next step: ${nextStep}`);
  }

  return parts.join("\n\n");
}

export async function runWalletAdminCommand(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): Promise<number> {
  const runtimePaths = context.resolveWalletRuntimePaths(parsed.seedName);
  const stopWatcher = createOwnedLockCleanupSignalWatcher(context.signalSource, context.forceExit, [
    runtimePaths.walletControlLockPath,
    runtimePaths.miningControlLockPath,
    runtimePaths.bitcoindLockPath,
    runtimePaths.indexerDaemonLockPath,
  ]);

  try {
    const outcome = await waitForCompletionOrStop((async () => {
      const provider = context.walletSecretProvider;

      if (parsed.command === "init" || parsed.command === "wallet-init") {
        const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
        const prompter = createCommandPrompter(parsed, context);
        const interactiveProvider = withInteractiveWalletSecretProvider(provider, prompter);
        const result = await context.initializeWallet({
          dataDir,
          provider: interactiveProvider,
          prompter,
          paths: runtimePaths,
        });
        const nextSteps = getInitNextSteps();
        if (parsed.outputMode === "json") {
          writeJsonValue(context.stdout, createMutationSuccessEnvelope(
            resolveStableMutationJsonSchema(parsed)!,
            describeCanonicalCommand(parsed),
            "initialized",
            buildInitMutationData(result),
            {
              explanations: [getFundingQuickstartGuidance()],
              nextSteps,
            },
          ));
          return 0;
        }
        writeLine(context.stdout, "");
        writeLine(context.stdout, loadWelcomeArtText());
        writeLine(context.stdout, "");
        writeLine(
          context.stdout,
          result.walletAction === "already-initialized"
            ? "Wallet already initialized."
            : "Wallet initialized.",
        );
        writeLine(context.stdout, `Client password: ${result.passwordAction}`);
        if (result.passwordAction !== "already-configured") {
          writeSetupUnlockGuidance(context.stdout);
        }
        writeLine(context.stdout, `Wallet root: ${result.walletRootId}`);
        writeLine(context.stdout, `Funding address: ${result.fundingAddress}`);
        writeLine(context.stdout, `Quickstart: ${getFundingQuickstartGuidance()}`);
        for (const line of formatNextStepLines(nextSteps)) {
          writeLine(context.stdout, line);
        }
        return 0;
      }

      if (parsed.command === "restore" || parsed.command === "wallet-restore") {
        const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
        const prompter = createCommandPrompter(parsed, context);
        const interactiveProvider = withInteractiveWalletSecretProvider(provider, prompter);
        const result = await context.restoreWalletFromMnemonic({
          dataDir,
          provider: interactiveProvider,
          prompter,
          paths: runtimePaths,
        });
        const nextSteps = getRestoreNextSteps();
        const explanations = ["Managed Bitcoin/indexer bootstrap is deferred until you run `cogcoin sync`."];
        if (parsed.outputMode === "json") {
          writeJsonValue(context.stdout, createMutationSuccessEnvelope(
            resolveStableMutationJsonSchema(parsed)!,
            describeCanonicalCommand(parsed),
            "restored",
            buildRestoreMutationData(result),
            {
              explanations,
              nextSteps,
              warnings: result.warnings ?? [],
            },
          ));
          return 0;
        }
        writeLine(context.stdout, `Wallet seed "${result.seedName}" restored from mnemonic.`);
        if (result.passwordAction !== "already-configured") {
          writeSetupUnlockGuidance(context.stdout);
        }
        writeLine(context.stdout, `Wallet root: ${result.walletRootId}`);
        writeLine(context.stdout, `Funding address: ${result.fundingAddress}`);
        writeLine(context.stdout, "Note: Managed Bitcoin/indexer bootstrap is deferred until you run `cogcoin sync`.");
        for (const warning of result.warnings ?? []) {
          writeLine(context.stdout, `Warning: ${warning}`);
        }
        for (const line of formatNextStepLines(nextSteps)) {
          writeLine(context.stdout, line);
        }
        return 0;
      }

      if (parsed.command === "wallet-delete") {
        const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
        const prompter = createCommandPrompter(parsed, context);
        const interactiveProvider = withInteractiveWalletSecretProvider(provider, prompter);
        const result = await context.deleteImportedWalletSeed({
          dataDir,
          provider: interactiveProvider,
          prompter,
          assumeYes: parsed.assumeYes,
          paths: runtimePaths,
        });
        if (parsed.outputMode === "json") {
          writeJsonValue(context.stdout, createMutationSuccessEnvelope(
            resolveStableMutationJsonSchema(parsed)!,
            describeCanonicalCommand(parsed),
            "deleted",
            buildWalletDeleteMutationData(result),
          ));
          return 0;
        }
        writeLine(context.stdout, `Imported wallet seed "${result.seedName}" deleted.`);
        writeLine(context.stdout, `Wallet root: ${result.walletRootId}`);
        return 0;
      }

      if (parsed.command === "wallet-show-mnemonic") {
        const prompter = createCommandPrompter(parsed, context);
        await context.showWalletMnemonic({
          provider: withInteractiveWalletSecretProvider(provider, prompter),
          prompter,
          paths: runtimePaths,
        });
        return 0;
      }

      const dbPath = parsed.dbPath ?? context.resolveDefaultClientDatabasePath();

      if (parsed.command === "reset") {
        const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
        if (parsed.outputMode === "preview-json") {
          const preview = await context.previewResetWallet({
            dataDir,
            provider,
          });
          writeJsonValue(context.stdout, createPreviewSuccessEnvelope(
            resolvePreviewJsonSchema(parsed)!,
            describeCanonicalCommand(parsed),
            "planned",
            buildResetPreviewData(preview),
          ));
          return 0;
        }

        const prompter = createCommandPrompter(parsed, context);
        const result = await context.resetWallet({
          dataDir,
          provider: withInteractiveWalletSecretProvider(provider, prompter),
          prompter,
        });

        if (parsed.outputMode === "json") {
          writeJsonValue(context.stdout, createMutationSuccessEnvelope(
            resolveStableMutationJsonSchema(parsed)!,
            describeCanonicalCommand(parsed),
            "completed",
            buildResetMutationData(result),
            {
              warnings: getResetWarnings(result),
              nextSteps: getResetNextSteps(result),
            },
          ));
          return 0;
        }

        writeLine(context.stdout, formatResetResultText(result));
        return 0;
      }

      if (parsed.command === "repair") {
        const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
        const repairProvider = parsed.outputMode === "preview-json"
          ? provider
          : withInteractiveWalletSecretProvider(provider, createCommandPrompter(parsed, context));
        const result = await context.repairWallet({
          dataDir,
          databasePath: dbPath,
          provider: repairProvider,
          assumeYes: parsed.assumeYes,
          paths: runtimePaths,
        });
        if (parsed.outputMode === "preview-json") {
          writeJsonValue(context.stdout, createPreviewSuccessEnvelope(
            resolvePreviewJsonSchema(parsed)!,
            describeCanonicalCommand(parsed),
            "completed",
            buildRepairPreviewData(result),
            {
              nextSteps: ["Run `cogcoin status` to review the repaired local state."],
              warnings: getRepairWarnings(result),
            },
          ));
          return 0;
        }
        if (parsed.outputMode === "json") {
          writeJsonValue(context.stdout, createMutationSuccessEnvelope(
            resolveStableMutationJsonSchema(parsed)!,
            "cogcoin repair",
            "completed",
            buildRepairMutationData(result),
            {
              nextSteps: ["Run `cogcoin status` to review the repaired local state."],
              warnings: getRepairWarnings(result),
            },
          ));
          return 0;
        }
        writeLine(context.stdout, `Wallet repair completed.`);
        writeLine(context.stdout, `Wallet root: ${result.walletRootId}`);
        writeLine(context.stdout, `Recovered from backup: ${result.recoveredFromBackup ? "yes" : "no"}`);
        writeLine(context.stdout, `Managed Core wallet recreated: ${result.recreatedManagedCoreWallet ? "yes" : "no"}`);
        writeLine(context.stdout, `Managed bitcoind action: ${result.bitcoindServiceAction}`);
        writeLine(context.stdout, `Managed bitcoind compatibility issue: ${result.bitcoindCompatibilityIssue}`);
        writeLine(context.stdout, `Managed Core replica action: ${result.managedCoreReplicaAction}`);
        writeLine(context.stdout, `Managed bitcoind post-repair health: ${result.bitcoindPostRepairHealth}`);
        writeLine(context.stdout, `Indexer database reset: ${result.resetIndexerDatabase ? "yes" : "no"}`);
        writeLine(context.stdout, `Indexer daemon action: ${result.indexerDaemonAction}`);
        writeLine(context.stdout, `Indexer compatibility issue: ${result.indexerCompatibilityIssue}`);
        writeLine(context.stdout, `Indexer post-repair health: ${result.indexerPostRepairHealth}`);
        writeLine(context.stdout, `Mining mode before repair: ${result.miningPreRepairRunMode}`);
        writeLine(context.stdout, `Mining resume action: ${result.miningResumeAction}`);
        writeLine(context.stdout, `Mining mode after repair: ${result.miningPostRepairRunMode}`);
        if (result.miningResumeError !== null) {
          writeLine(context.stdout, `Mining resume error: ${result.miningResumeError}`);
        }
        if (result.note !== null) {
          writeLine(context.stdout, `Note: ${result.note}`);
        }
        for (const warning of getRepairWarnings(result)) {
          writeLine(context.stdout, `Warning: ${warning}`);
        }
        return 0;
      }

      writeLine(context.stderr, `wallet admin command not implemented: ${parsed.command}`);
      return 1;
    })(), stopWatcher);

    if (outcome.kind === "stopped") {
      return outcome.code;
    }

    return outcome.value;
  } catch (error) {
    return writeHandledCliError({
      parsed,
      stdout: context.stdout,
      stderr: context.stderr,
      error,
    });
  } finally {
    stopWatcher.cleanup();
  }
}
