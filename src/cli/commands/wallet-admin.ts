import { parseUnlockDurationToMs } from "../../wallet/lifecycle.js";
import {
  buildInitMutationData,
  buildResetMutationData,
  buildRestoreMutationData,
  buildUnlockMutationData,
  buildRepairMutationData,
  buildWalletExportMutationData,
  buildWalletImportMutationData,
  buildWalletLockMutationData,
} from "../mutation-json.js";
import {
  buildResetPreviewData,
  buildRepairPreviewData,
  buildWalletLockPreviewData,
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
import {
  formatNextStepLines,
  getFundingQuickstartGuidance,
  getInitNextSteps,
  getRestoreNextSteps,
} from "../workflow-hints.js";
import {
  createOwnedLockCleanupSignalWatcher,
  waitForCompletionOrStop,
} from "../signals.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";
import type { WalletRepairResult, WalletResetResult } from "../../wallet/lifecycle.js";

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

  try {
    const outcome = await waitForCompletionOrStop((async () => {
      const provider = context.walletSecretProvider;

      if (parsed.command === "init" || parsed.command === "wallet-init") {
        const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
        const prompter = createCommandPrompter(parsed, context);
        const result = await context.initializeWallet({
          dataDir,
          provider,
          prompter,
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
        writeLine(context.stdout, `Wallet initialized.`);
        writeLine(context.stdout, `Wallet root: ${result.walletRootId}`);
        writeLine(context.stdout, `Funding address: ${result.fundingAddress}`);
        writeLine(context.stdout, `Unlocked until: ${new Date(result.unlockUntilUnixMs).toISOString()}`);
        writeLine(context.stdout, `Quickstart: ${getFundingQuickstartGuidance()}`);
        for (const line of formatNextStepLines(nextSteps)) {
          writeLine(context.stdout, line);
        }
        return 0;
      }

      if (parsed.command === "restore" || parsed.command === "wallet-restore") {
        const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
        const prompter = createCommandPrompter(parsed, context);
        const result = await context.restoreWalletFromMnemonic({
          dataDir,
          provider,
          prompter,
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
        writeLine(context.stdout, "Wallet restored from mnemonic.");
        writeLine(context.stdout, `Wallet root: ${result.walletRootId}`);
        writeLine(context.stdout, `Funding address: ${result.fundingAddress}`);
        writeLine(context.stdout, `Unlocked until: ${new Date(result.unlockUntilUnixMs).toISOString()}`);
        writeLine(context.stdout, "Note: Managed Bitcoin/indexer bootstrap is deferred until you run `cogcoin sync`.");
        for (const warning of result.warnings ?? []) {
          writeLine(context.stdout, `Warning: ${warning}`);
        }
        for (const line of formatNextStepLines(nextSteps)) {
          writeLine(context.stdout, line);
        }
        return 0;
      }

      if (parsed.command === "wallet-show-mnemonic") {
        const prompter = createCommandPrompter(parsed, context);
        await context.showWalletMnemonic({
          provider,
          prompter,
        });
        return 0;
      }

      const dbPath = parsed.dbPath ?? context.resolveDefaultClientDatabasePath();

      if (parsed.command === "unlock" || parsed.command === "wallet-unlock") {
        const durationMs = parseUnlockDurationToMs(parsed.unlockFor);
        const result = await context.unlockWallet({
          provider,
          unlockDurationMs: durationMs,
        });
        if (parsed.outputMode === "json") {
          writeJsonValue(context.stdout, createMutationSuccessEnvelope(
            resolveStableMutationJsonSchema(parsed)!,
            describeCanonicalCommand(parsed),
            "unlocked",
            buildUnlockMutationData(result),
          ));
          return 0;
        }
        writeLine(context.stdout, `Wallet unlocked.`);
        writeLine(context.stdout, `Wallet root: ${result.state.walletRootId}`);
        writeLine(context.stdout, `Unlocked until: ${new Date(result.unlockUntilUnixMs).toISOString()}`);
        return 0;
      }

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
          provider,
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
              nextSteps: result.walletAction === "deleted" || result.walletAction === "not-present"
                ? ["Run `cogcoin init` to create a new wallet."]
                : ["Run `cogcoin status` to inspect the reset local state."],
            },
          ));
          return 0;
        }

        writeLine(context.stdout, "Cogcoin reset completed.");
        writeLine(context.stdout, `Data root: ${result.dataRoot}`);
        writeLine(context.stdout, `Wallet action: ${result.walletAction}`);
        writeLine(context.stdout, `Snapshot: ${result.bootstrapSnapshot.status}`);
        writeLine(context.stdout, `Secret cleanup: ${result.secretCleanupStatus}`);
        writeLine(context.stdout, `Managed bitcoind processes stopped: ${result.stoppedProcesses.managedBitcoind}`);
        writeLine(context.stdout, `Indexer daemons stopped: ${result.stoppedProcesses.indexerDaemon}`);
        writeLine(context.stdout, `Background miners stopped: ${result.stoppedProcesses.backgroundMining}`);
        if (result.walletOldRootId !== null) {
          writeLine(context.stdout, `Previous wallet root: ${result.walletOldRootId}`);
        }
        if (result.walletNewRootId !== null) {
          writeLine(context.stdout, `New wallet root: ${result.walletNewRootId}`);
        }
        for (const warning of getResetWarnings(result)) {
          writeLine(context.stdout, `Warning: ${warning}`);
        }
        return 0;
      }

      if (parsed.command === "wallet-export") {
        const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
        const prompter = createCommandPrompter(parsed, context);
        const result = await context.exportWallet({
          archivePath: parsed.args[0]!,
          dataDir,
          databasePath: dbPath,
          provider,
          prompter,
        });
        if (parsed.outputMode === "json") {
          writeJsonValue(context.stdout, createMutationSuccessEnvelope(
            resolveStableMutationJsonSchema(parsed)!,
            describeCanonicalCommand(parsed),
            "exported",
            buildWalletExportMutationData(result),
          ));
          return 0;
        }
        writeLine(context.stdout, `Wallet exported.`);
        writeLine(context.stdout, `Wallet root: ${result.walletRootId}`);
        writeLine(context.stdout, `Archive path: ${result.archivePath}`);
        return 0;
      }

      if (parsed.command === "wallet-import") {
        const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
        const prompter = createCommandPrompter(parsed, context);
        const result = await context.importWallet({
          archivePath: parsed.args[0]!,
          dataDir,
          databasePath: dbPath,
          provider,
          prompter,
        });
        if (parsed.outputMode === "json") {
          writeJsonValue(context.stdout, createMutationSuccessEnvelope(
            resolveStableMutationJsonSchema(parsed)!,
            describeCanonicalCommand(parsed),
            "imported",
            buildWalletImportMutationData(result),
          ));
          return 0;
        }
        writeLine(context.stdout, `Wallet imported.`);
        writeLine(context.stdout, `Wallet root: ${result.walletRootId}`);
        writeLine(context.stdout, `Funding address: ${result.fundingAddress}`);
        writeLine(context.stdout, `Unlocked until: ${new Date(result.unlockUntilUnixMs).toISOString()}`);
        return 0;
      }

      if (parsed.command === "wallet-lock") {
        const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
        const result = await context.lockWallet({
          dataDir,
          provider,
        });
        if (parsed.outputMode === "preview-json") {
          writeJsonValue(context.stdout, createPreviewSuccessEnvelope(
            resolvePreviewJsonSchema(parsed)!,
            describeCanonicalCommand(parsed),
            "locked",
            buildWalletLockPreviewData(result),
          ));
          return 0;
        }
        if (parsed.outputMode === "json") {
          writeJsonValue(context.stdout, createMutationSuccessEnvelope(
            resolveStableMutationJsonSchema(parsed)!,
            "cogcoin wallet lock",
            "locked",
            buildWalletLockMutationData(result),
          ));
          return 0;
        }
        writeLine(context.stdout, `Wallet locked.`);
        writeLine(context.stdout, `Wallet root: ${result.walletRootId ?? "none"}`);
        return 0;
      }

      if (parsed.command === "repair") {
        const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
        const result = await context.repairWallet({
          dataDir,
          databasePath: dbPath,
          provider,
          assumeYes: parsed.assumeYes,
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
