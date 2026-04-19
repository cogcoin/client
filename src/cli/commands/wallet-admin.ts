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
import { runSyncCommand } from "./sync.js";
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

function writeWelcomeArtBlock(stdout: RequiredCliRunnerContext["stdout"]): void {
  writeLine(stdout, "");
  writeLine(stdout, loadWelcomeArtText());
  writeLine(stdout, "");
}

function assertInitTextPreflight(options: {
  prompter: ReturnType<typeof createCommandPrompter>;
  runtimePaths: ReturnType<RequiredCliRunnerContext["resolveWalletRuntimePaths"]>;
}): void {
  if (!options.prompter.isInteractive) {
    throw new Error("wallet_init_requires_tty");
  }

  if (options.runtimePaths.selectedSeedName !== "main") {
    throw new Error("wallet_init_seed_not_supported");
  }
}

function getResetNextSteps(result: WalletResetResult): string[] {
  return result.walletAction === "deleted" || result.walletAction === "not-present"
    ? ["Run `cogcoin init` to create a new wallet."]
    : ["Run `cogcoin sync` to bootstrap assumeutxo and the managed Bitcoin/indexer state."];
}

function getRepairNextSteps(): string[] {
  return ["Run `cogcoin status` to review the repaired local state."];
}

function formatResetBitcoinDataDirStatus(result: WalletResetResult): string {
  if (result.bitcoinDataDir.status === "outside-reset-scope") {
    return "preserved (outside reset scope)";
  }

  return result.bitcoinDataDir.status;
}

interface SectionTextEntry {
  text: string;
  ok: boolean;
}

function sectionTextEntry(label: string, value: string, ok: boolean): SectionTextEntry {
  return {
    text: `${label}: ${value}`,
    ok,
  };
}

function formatAdminSection(header: string, entries: readonly SectionTextEntry[]): string {
  return [header, ...entries.map((entry) => `${entry.ok ? "✓" : "✗"} ${entry.text}`)].join("\n");
}

function formatResetResultText(result: WalletResetResult): string {
  const warnings = getResetWarnings(result);
  const nextStep = getResetNextSteps(result)[0] ?? null;
  const secretCleanupOk = result.secretCleanupStatus !== "unknown" && result.secretCleanupStatus !== "failed";
  const managedCleanupOk = result.stoppedProcesses.survivors === 0;
  const outcomeEntries: SectionTextEntry[] = [
    sectionTextEntry("Wallet action", result.walletAction, true),
    sectionTextEntry("Snapshot", result.bootstrapSnapshot.status, true),
    sectionTextEntry("Bitcoin datadir", formatResetBitcoinDataDirStatus(result), true),
    sectionTextEntry("Secret cleanup", result.secretCleanupStatus, secretCleanupOk),
  ];

  if (result.walletAction !== "retain-mnemonic" && result.walletOldRootId !== null) {
    outcomeEntries.push(sectionTextEntry("Previous wallet root", result.walletOldRootId, true));
  }

  if (result.walletAction !== "retain-mnemonic" && result.walletNewRootId !== null) {
    outcomeEntries.push(sectionTextEntry("New wallet root", result.walletNewRootId, true));
  }

  const sections = [
    formatAdminSection("Paths", [
      sectionTextEntry("Data root", result.dataRoot, true),
    ]),
    formatAdminSection("Reset Outcome", outcomeEntries),
    formatAdminSection("Managed Cleanup", [
      sectionTextEntry(
        "Managed bitcoind processes stopped",
        String(result.stoppedProcesses.managedBitcoind),
        managedCleanupOk,
      ),
      sectionTextEntry(
        "Indexer daemons stopped",
        String(result.stoppedProcesses.indexerDaemon),
        managedCleanupOk,
      ),
      sectionTextEntry(
        "Background miners stopped",
        String(result.stoppedProcesses.backgroundMining),
        managedCleanupOk,
      ),
    ]),
  ];

  if (warnings.length > 0) {
    sections.push(formatAdminSection(
      "Warnings",
      warnings.map((warning) => sectionTextEntry("Warning", warning, false)),
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

function isRepairMiningResumeActionOk(action: WalletRepairResult["miningResumeAction"]): boolean {
  return action === "none"
    || action === "skipped-not-resumable"
    || action === "resumed-background";
}

function buildRepairWarningEntries(result: WalletRepairResult): SectionTextEntry[] {
  const entries: SectionTextEntry[] = [];

  if (result.miningResumeError !== null) {
    entries.push(sectionTextEntry("Mining resume error", result.miningResumeError, false));
  }

  for (const warning of getRepairWarnings(result)) {
    if (result.miningResumeError !== null && warning.includes(result.miningResumeError)) {
      continue;
    }

    entries.push(sectionTextEntry("Warning", warning, false));
  }

  return entries;
}

function formatRepairResultText(result: WalletRepairResult): string {
  const nextStep = getRepairNextSteps()[0] ?? null;
  const warningEntries = buildRepairWarningEntries(result);
  const sections = [
    formatAdminSection("Wallet", [
      sectionTextEntry("Wallet root", result.walletRootId, true),
      sectionTextEntry("Recovered from backup", result.recoveredFromBackup ? "yes" : "no", true),
      sectionTextEntry("Managed Core wallet recreated", result.recreatedManagedCoreWallet ? "yes" : "no", true),
    ]),
    formatAdminSection("Managed Bitcoind", [
      sectionTextEntry("Managed bitcoind action", result.bitcoindServiceAction, true),
      sectionTextEntry(
        "Managed bitcoind compatibility issue",
        result.bitcoindCompatibilityIssue,
        result.bitcoindCompatibilityIssue === "none",
      ),
      sectionTextEntry("Managed Core replica action", result.managedCoreReplicaAction, true),
      sectionTextEntry(
        "Managed bitcoind post-repair health",
        result.bitcoindPostRepairHealth,
        result.bitcoindPostRepairHealth === "ready",
      ),
    ]),
    formatAdminSection("Indexer", [
      sectionTextEntry("Indexer database reset", result.resetIndexerDatabase ? "yes" : "no", true),
      sectionTextEntry("Indexer daemon action", result.indexerDaemonAction, true),
      sectionTextEntry(
        "Indexer compatibility issue",
        result.indexerCompatibilityIssue,
        result.indexerCompatibilityIssue === "none",
      ),
      sectionTextEntry(
        "Indexer post-repair health",
        result.indexerPostRepairHealth,
        result.indexerPostRepairHealth === "synced",
      ),
    ]),
    formatAdminSection("Mining", [
      sectionTextEntry("Mining mode before repair", result.miningPreRepairRunMode, true),
      sectionTextEntry(
        "Mining resume action",
        result.miningResumeAction,
        isRepairMiningResumeActionOk(result.miningResumeAction),
      ),
      sectionTextEntry("Mining mode after repair", result.miningPostRepairRunMode, true),
    ]),
  ];

  if (result.note !== null) {
    sections.push(formatAdminSection("Notes", [
      sectionTextEntry("Note", result.note, true),
    ]));
  }

  if (warningEntries.length > 0) {
    sections.push(formatAdminSection("Warnings", warningEntries));
  }

  const parts = [
    "\n⛭ Cogcoin Repair ⛭",
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
  let shouldAutoSyncAfterInit = false;

  try {
    const outcome = await waitForCompletionOrStop((async () => {
      const provider = context.walletSecretProvider;

      if (parsed.command === "init" || parsed.command === "wallet-init") {
        const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
        const prompter = createCommandPrompter(parsed, context);
        if (parsed.outputMode === "text") {
          assertInitTextPreflight({
            prompter,
            runtimePaths,
          });
          writeWelcomeArtBlock(context.stdout);
        }
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
        writeWelcomeArtBlock(context.stdout);
        writeLine(
          context.stdout,
          result.walletAction === "already-initialized"
            ? "Wallet already initialized."
            : "Wallet initialized.",
        );

        if (result.walletAction === "already-initialized") {
          writeLine(context.stdout, "");
          writeLine(context.stdout, "Wallet");
          writeLine(context.stdout, `✓ Client password: ${result.passwordAction}`);
          writeLine(context.stdout, `✓ Wallet root: ${result.walletRootId}`);
          writeLine(context.stdout, `✓ Funding address: ${result.fundingAddress}`);
          if (result.passwordAction !== "already-configured") {
            writeSetupUnlockGuidance(context.stdout);
          }
        } else {
          writeLine(context.stdout, `Client password: ${result.passwordAction}`);
          if (result.passwordAction !== "already-configured") {
            writeSetupUnlockGuidance(context.stdout);
          }
          writeLine(context.stdout, `Wallet root: ${result.walletRootId}`);
          writeLine(context.stdout, `Funding address: ${result.fundingAddress}`);
        }

        writeLine(context.stdout, "");
        writeLine(context.stdout, `Quickstart: ${getFundingQuickstartGuidance()}`);
        shouldAutoSyncAfterInit = true;
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
              nextSteps: getRepairNextSteps(),
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
              nextSteps: getRepairNextSteps(),
              warnings: getRepairWarnings(result),
            },
          ));
          return 0;
        }
        writeLine(context.stdout, formatRepairResultText(result));
        return 0;
      }

      writeLine(context.stderr, `wallet admin command not implemented: ${parsed.command}`);
      return 1;
    })(), stopWatcher);

    if (outcome.kind === "stopped") {
      return outcome.code;
    }

    if (shouldAutoSyncAfterInit && outcome.value === 0) {
      stopWatcher.cleanup();
      return await runSyncCommand(parsed, context);
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
