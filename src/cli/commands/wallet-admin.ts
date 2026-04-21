import { writeLine } from "../io.js";
import { writeHandledCliError } from "../output.js";
import { loadWelcomeArtText } from "../art.js";
import {
  formatNextStepLines,
  getFundingQuickstartGuidance,
  getInitUnlockGuidanceLines,
  getInitNextSteps,
} from "../workflow-hints.js";
import {
  createOwnedLockCleanupSignalWatcher,
  waitForCompletionOrStop,
} from "../signals.js";
import { runSyncCommand } from "./sync.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";
import type { WalletRepairResult, WalletResetResult } from "../../wallet/lifecycle.js";
import { withInteractiveWalletSecretProvider } from "../../wallet/state/provider.js";

function createCommandPrompter(
  context: RequiredCliRunnerContext,
) {
  return context.createPrompter();
}

function getRepairWarnings(result: WalletRepairResult): string[] {
  return result.miningResumeAction === "skipped-background-mode-removed"
    ? ["Background mining no longer resumes automatically after repair. Run `cogcoin mine` if you want mining resumed."]
    : [];
}

function getResetWarnings(result: WalletResetResult): string[] {
  return result.secretCleanupStatus === "unknown"
    ? ["Some existing Cogcoin secret-provider entries could not be discovered from the remaining local wallet artifacts and may need manual cleanup."]
    : [];
}

function writeSetupUnlockGuidance(stdout: RequiredCliRunnerContext["stdout"]): void {
  for (const line of getInitUnlockGuidanceLines()) {
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
}): void {
  if (!options.prompter.isInteractive) {
    throw new Error("wallet_init_requires_tty");
  }
}

function getResetNextSteps(result: WalletResetResult): string[] {
  return result.walletAction === "deleted" || result.walletAction === "not-present"
    ? ["Run `cogcoin init` to create or restore a wallet."]
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
    || action === "skipped-post-repair-blocked"
    || action === "skipped-background-mode-removed";
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
  const runtimePaths = context.resolveWalletRuntimePaths();
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

      if (parsed.command === "init") {
        const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
        const prompter = createCommandPrompter(context);
        assertInitTextPreflight({
          prompter,
        });
        writeWelcomeArtBlock(context.stdout);
        const interactiveProvider = withInteractiveWalletSecretProvider(provider, prompter);
        const result = await context.initializeWallet({
          dataDir,
          provider: interactiveProvider,
          prompter,
          paths: runtimePaths,
        });
        writeWelcomeArtBlock(context.stdout);
        writeLine(
          context.stdout,
          result.walletAction === "already-initialized"
            ? "Wallet already initialized."
            : result.setupMode === "restored"
              ? "Wallet restored."
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

      if (parsed.command === "wallet-show-mnemonic") {
        const prompter = createCommandPrompter(context);
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
        const prompter = createCommandPrompter(context);
        const result = await context.resetWallet({
          dataDir,
          provider: withInteractiveWalletSecretProvider(provider, prompter),
          prompter,
        });

        writeLine(context.stdout, formatResetResultText(result));
        return 0;
      }

      if (parsed.command === "repair") {
        const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
        const repairProvider = withInteractiveWalletSecretProvider(provider, createCommandPrompter(context));
        const result = await context.repairWallet({
          dataDir,
          databasePath: dbPath,
          provider: repairProvider,
          assumeYes: parsed.assumeYes,
          paths: runtimePaths,
        });
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
