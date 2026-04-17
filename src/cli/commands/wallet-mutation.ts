import {
  type CogMutationResult,
  parseCogAmountToCogtoshi,
  type FieldValueInputSource,
} from "../../wallet/tx/index.js";
import {
  buildAnchorMutationData,
  buildCogMutationData,
  buildDomainAdminMutationData,
  buildDomainMarketMutationData,
  buildFieldMutationData,
  buildRegisterMutationData,
  buildReputationMutationData,
} from "../mutation-json.js";
import {
  buildAnchorPreviewData,
  buildCogPreviewData,
  buildDomainAdminPreviewData,
  buildDomainMarketPreviewData,
  buildFieldPreviewData,
  buildRegisterPreviewData,
  buildReputationPreviewData,
} from "../preview-json.js";
import {
  isAnchorMutationCommand,
  isBuyMutationCommand,
  isClaimMutationCommand,
  isReclaimMutationCommand,
  isRegisterMutationCommand,
  isReputationMutationCommand,
  isSellOrUnsellMutationCommand,
  isSendMutationCommand,
  isTransferMutationCommand,
  isUnsellMutationCommand,
  isWalletMutationCommand,
} from "../mutation-command-groups.js";
import {
  commandMutationNextSteps,
  workflowMutationNextSteps,
  writeMutationCommandSuccess,
} from "../mutation-success.js";
import { writeLine } from "../io.js";
import {
  formatBuyBuyerSummary,
  formatBuySellerSummary,
  formatBuySettlementSummary,
  formatCogClaimPath,
  formatCogSenderSummary,
  formatDomainAdminEffect,
  formatDomainAdminPayloadSummary,
  formatDomainAdminSenderSummary,
  formatDomainAdminTargetSummary,
  formatDomainMarketEconomicEffect,
  formatDomainMarketRecipientSummary,
  formatDomainMarketSenderSummary,
  formatFieldEffect,
  formatFieldPath,
  formatFieldSenderSummary,
  formatFieldValueSummary,
  formatRegisterEconomicEffect,
  formatRegisterSenderSummary,
  formatReputationEffect,
  formatReputationReviewSummary,
  formatReputationSenderSummary,
} from "../mutation-text-format.js";
import { createTerminalPrompter } from "../prompt.js";
import { writeHandledCliError } from "../output.js";
import {
  getAnchorNextSteps,
  getRegisterNextSteps,
} from "../workflow-hints.js";
import {
  createOwnedLockCleanupSignalWatcher,
  waitForCompletionOrStop,
} from "../signals.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";
import { withInteractiveWalletSecretProvider } from "../../wallet/state/provider.js";

function createFieldValueSource(parsed: ParsedCliArgs): FieldValueInputSource {
  if (parsed.endpointText !== null) {
    return { kind: "text", value: parsed.endpointText };
  }

  if (parsed.endpointJson !== null) {
    return { kind: "json", value: parsed.endpointJson };
  }

  if (parsed.endpointBytes !== null) {
    return { kind: "bytes", value: parsed.endpointBytes };
  }

  return {
    kind: "raw",
    format: parsed.fieldFormat!,
    value: parsed.fieldValue!,
  };
}

function createCommandPrompter(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
) {
  return parsed.outputMode !== "text"
    ? createTerminalPrompter(context.stdin, context.stderr)
    : context.createPrompter();
}

export async function runWalletMutationCommand(
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
      if (!isWalletMutationCommand(parsed.command)) {
        writeLine(context.stderr, `wallet mutation command not implemented: ${parsed.command}`);
        return 1;
      }

      const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
      const dbPath = parsed.dbPath ?? context.resolveDefaultClientDatabasePath();
      const prompter = createCommandPrompter(parsed, context);
      const interactive = prompter.isInteractive;
      const provider = withInteractiveWalletSecretProvider(context.walletSecretProvider, prompter);

      if (isAnchorMutationCommand(parsed.command)) {
        const result = await context.anchorDomain({
          domainName: parsed.args[0]!,
          foundingMessageText: parsed.anchorMessage,
          promptForFoundingMessageWhenMissing: parsed.anchorMessage === null,
          dataDir,
          databasePath: dbPath,
          provider,
          prompter,
          paths: runtimePaths,
        });
        const nextSteps = getAnchorNextSteps(result.domainName);
        return writeMutationCommandSuccess(parsed, context, {
          data: buildAnchorMutationData(result, {
            foundingMessageText: result.foundingMessageText ?? parsed.anchorMessage,
          }),
          previewData: buildAnchorPreviewData(result, {
            foundingMessageText: result.foundingMessageText ?? parsed.anchorMessage,
          }),
          reusedExisting: result.reusedExisting,
          reusedMessage: "The existing pending anchor was reconciled instead of creating a duplicate.",
          interactive,
          explorerTxid: result.txid,
          nextSteps: workflowMutationNextSteps(nextSteps),
          text: {
            heading: "Anchor submitted.",
            fields: [
              { label: "Domain", value: result.domainName },
              { label: "Status", value: result.status },
              { label: "Txid", value: result.txid },
            ],
          },
        });
      }

    if (isRegisterMutationCommand(parsed.command)) {
      const result = await context.registerDomain({
        domainName: parsed.args[0]!,
        dataDir,
        databasePath: dbPath,
        forceRace: parsed.forceRace,
        provider,
        prompter,
        assumeYes: parsed.assumeYes,
        paths: runtimePaths,
      });
      const nextSteps = getRegisterNextSteps(result.domainName, result.registerKind);
      return writeMutationCommandSuccess(parsed, context, {
        data: buildRegisterMutationData(result, {
          forceRace: parsed.forceRace,
        }),
        previewData: buildRegisterPreviewData(result, {
          forceRace: parsed.forceRace,
        }),
        reusedExisting: result.reusedExisting,
        reusedMessage: "The existing pending registration was reconciled instead of creating a duplicate.",
        interactive,
        explorerTxid: result.txid,
        nextSteps: workflowMutationNextSteps(nextSteps),
        text: {
          heading: "Registration submitted.",
          fields: [
            { label: "Domain", value: result.domainName },
            { label: "Path", value: result.resolved.path },
            { label: "Parent", value: result.resolved.parentDomainName ?? "", when: result.resolved.parentDomainName !== null },
            { label: "Sender", value: formatRegisterSenderSummary(result) },
            { label: "Economic effect", value: formatRegisterEconomicEffect(result) },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      });
    }

    if (isTransferMutationCommand(parsed.command)) {
      const result = await context.transferDomain({
        domainName: parsed.args[0]!,
        target: parsed.transferTarget!,
        dataDir,
        databasePath: dbPath,
        provider,
        prompter,
        assumeYes: parsed.assumeYes,
        paths: runtimePaths,
      });
      return writeMutationCommandSuccess(parsed, context, {
        data: buildDomainMarketMutationData(result, {
          commandKind: "transfer",
        }),
        previewData: buildDomainMarketPreviewData(result, {
          commandKind: "transfer",
        }),
        reusedExisting: result.reusedExisting,
        reusedMessage: "The existing pending transfer was reconciled instead of creating a duplicate.",
        interactive,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps(`cogcoin show ${result.domainName}`),
        text: {
          heading: "Transfer submitted.",
          fields: [
            { label: "Domain", value: result.domainName },
            { label: "Sender", value: formatDomainMarketSenderSummary(result) },
            { label: "Recipient", value: formatDomainMarketRecipientSummary(result) },
            { label: "Economic effect", value: formatDomainMarketEconomicEffect(result) },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      });
    }

    if (isSellOrUnsellMutationCommand(parsed.command)) {
      const listedPriceCogtoshi = isUnsellMutationCommand(parsed.command)
        ? 0n
        : parseCogAmountToCogtoshi(parsed.args[1]!);
      const result = await context.sellDomain({
        domainName: parsed.args[0]!,
        listedPriceCogtoshi,
        dataDir,
        databasePath: dbPath,
        provider,
        prompter,
        assumeYes: parsed.assumeYes,
        paths: runtimePaths,
      });
      return writeMutationCommandSuccess(parsed, context, {
        data: buildDomainMarketMutationData(result, {
          commandKind: result.listedPriceCogtoshi === 0n ? "unsell" : "sell",
        }),
        previewData: buildDomainMarketPreviewData(result, {
          commandKind: result.listedPriceCogtoshi === 0n ? "unsell" : "sell",
        }),
        reusedExisting: result.reusedExisting,
        reusedMessage: "The existing pending listing mutation was reconciled instead of creating a duplicate.",
        interactive,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps(`cogcoin show ${result.domainName}`),
        text: {
          heading: result.listedPriceCogtoshi === 0n ? "Listing cancellation submitted." : "Listing submitted.",
          fields: [
            { label: "Domain", value: result.domainName },
            { label: "Sender", value: formatDomainMarketSenderSummary(result) },
            { label: "Price", value: `${result.listedPriceCogtoshi?.toString() ?? "0"} cogtoshi` },
            { label: "Economic effect", value: formatDomainMarketEconomicEffect(result) },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      });
    }

    if (parsed.command === "domain-endpoint-set" || parsed.command === "domain-endpoint-clear") {
      const result = parsed.command === "domain-endpoint-set"
        ? await context.setDomainEndpoint({
          domainName: parsed.args[0]!,
          source: parsed.endpointText !== null
            ? { kind: "text", value: parsed.endpointText }
            : parsed.endpointJson !== null
              ? { kind: "json", value: parsed.endpointJson }
              : { kind: "bytes", value: parsed.endpointBytes! },
          dataDir,
          databasePath: dbPath,
          provider,
          prompter,
          assumeYes: parsed.assumeYes,
          paths: runtimePaths,
        })
        : await context.clearDomainEndpoint({
          domainName: parsed.args[0]!,
          dataDir,
          databasePath: dbPath,
          provider,
          prompter,
          assumeYes: parsed.assumeYes,
          paths: runtimePaths,
        });
      return writeMutationCommandSuccess(parsed, context, {
        data: buildDomainAdminMutationData(result, {
          commandKind: parsed.command,
        }),
        previewData: buildDomainAdminPreviewData(result, {
          commandKind: parsed.command,
        }),
        reusedExisting: result.reusedExisting,
        reusedMessage: "The existing pending endpoint mutation was reconciled instead of creating a duplicate.",
        interactive,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps(`cogcoin show ${result.domainName}`),
        text: {
          heading: parsed.command === "domain-endpoint-set" ? "Endpoint update submitted." : "Endpoint clear submitted.",
          fields: [
            { label: "Domain", value: result.domainName },
            { label: "Sender", value: formatDomainAdminSenderSummary(result) },
            { label: "Payload", value: formatDomainAdminPayloadSummary(result) },
            { label: "Effect", value: formatDomainAdminEffect(result) },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      });
    }

    if (parsed.command === "domain-delegate-set" || parsed.command === "domain-delegate-clear") {
      const result = parsed.command === "domain-delegate-set"
        ? await context.setDomainDelegate({
          domainName: parsed.args[0]!,
          target: parsed.args[1]!,
          dataDir,
          databasePath: dbPath,
          provider,
          prompter,
          assumeYes: parsed.assumeYes,
          paths: runtimePaths,
        })
        : await context.clearDomainDelegate({
          domainName: parsed.args[0]!,
          dataDir,
          databasePath: dbPath,
          provider,
          prompter,
          assumeYes: parsed.assumeYes,
          paths: runtimePaths,
        });
      return writeMutationCommandSuccess(parsed, context, {
        data: buildDomainAdminMutationData(result, {
          commandKind: parsed.command,
        }),
        previewData: buildDomainAdminPreviewData(result, {
          commandKind: parsed.command,
        }),
        reusedExisting: result.reusedExisting,
        reusedMessage: "The existing pending delegate mutation was reconciled instead of creating a duplicate.",
        interactive,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps(`cogcoin show ${result.domainName}`),
        text: {
          heading: parsed.command === "domain-delegate-set" ? "Delegate update submitted." : "Delegate clear submitted.",
          fields: [
            { label: "Domain", value: result.domainName },
            { label: "Sender", value: formatDomainAdminSenderSummary(result) },
            { label: "Target", value: formatDomainAdminTargetSummary(result) },
            { label: "Effect", value: formatDomainAdminEffect(result) },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      });
    }

    if (parsed.command === "domain-miner-set" || parsed.command === "domain-miner-clear") {
      const result = parsed.command === "domain-miner-set"
        ? await context.setDomainMiner({
          domainName: parsed.args[0]!,
          target: parsed.args[1]!,
          dataDir,
          databasePath: dbPath,
          provider,
          prompter,
          assumeYes: parsed.assumeYes,
          paths: runtimePaths,
        })
        : await context.clearDomainMiner({
          domainName: parsed.args[0]!,
          dataDir,
          databasePath: dbPath,
          provider,
          prompter,
          assumeYes: parsed.assumeYes,
          paths: runtimePaths,
        });
      return writeMutationCommandSuccess(parsed, context, {
        data: buildDomainAdminMutationData(result, {
          commandKind: parsed.command,
        }),
        previewData: buildDomainAdminPreviewData(result, {
          commandKind: parsed.command,
        }),
        reusedExisting: result.reusedExisting,
        reusedMessage: "The existing pending miner mutation was reconciled instead of creating a duplicate.",
        interactive,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps(`cogcoin show ${result.domainName}`),
        text: {
          heading: parsed.command === "domain-miner-set" ? "Miner update submitted." : "Miner clear submitted.",
          fields: [
            { label: "Domain", value: result.domainName },
            { label: "Sender", value: formatDomainAdminSenderSummary(result) },
            { label: "Target", value: formatDomainAdminTargetSummary(result) },
            { label: "Effect", value: formatDomainAdminEffect(result) },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      });
    }

    if (parsed.command === "domain-canonical") {
      const result = await context.setDomainCanonical({
        domainName: parsed.args[0]!,
        dataDir,
        databasePath: dbPath,
        provider,
        prompter,
        assumeYes: parsed.assumeYes,
        paths: runtimePaths,
      });
      return writeMutationCommandSuccess(parsed, context, {
        data: buildDomainAdminMutationData(result, {
          commandKind: "domain-canonical",
        }),
        previewData: buildDomainAdminPreviewData(result, {
          commandKind: "domain-canonical",
        }),
        reusedExisting: result.reusedExisting,
        reusedMessage: "The existing pending canonical mutation was reconciled instead of creating a duplicate.",
        interactive,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps(`cogcoin show ${result.domainName}`),
        text: {
          heading: "Canonical update submitted.",
          fields: [
            { label: "Domain", value: result.domainName },
            { label: "Sender", value: formatDomainAdminSenderSummary(result) },
            { label: "Effect", value: formatDomainAdminEffect(result) },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      });
    }

    if (parsed.command === "field-create") {
      const result = await context.createField({
        domainName: parsed.args[0]!,
        fieldName: parsed.args[1]!,
        permanent: parsed.fieldPermanent,
        dataDir,
        databasePath: dbPath,
        provider,
        prompter,
        assumeYes: parsed.assumeYes,
        paths: runtimePaths,
      });
      return writeMutationCommandSuccess(parsed, context, {
        data: buildFieldMutationData(result),
        previewData: buildFieldPreviewData(result),
        reusedExisting: result.reusedExisting,
        reusedMessage: "The existing pending field creation was reconciled instead of creating a duplicate.",
        interactive,
        explorerTxid: result.txid,
        nextSteps: workflowMutationNextSteps([
          `cogcoin field show ${result.domainName} ${result.fieldName}`,
          `cogcoin field set ${result.domainName} ${result.fieldName} --text <value>`,
        ]),
        text: {
          heading: "Field creation submitted.",
          fields: [
            { label: "Domain", value: result.domainName },
            { label: "Field", value: result.fieldName },
            { label: "Sender", value: formatFieldSenderSummary(result) },
            { label: "Path", value: formatFieldPath(result) },
            { label: "Value", value: formatFieldValueSummary(result), when: result.resolved?.value !== null && result.resolved?.value !== undefined },
            { label: "Effect", value: formatFieldEffect(result) },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      });
    }

    if (parsed.command === "field-set") {
      const result = await context.setField({
        domainName: parsed.args[0]!,
        fieldName: parsed.args[1]!,
        source: createFieldValueSource(parsed),
        dataDir,
        databasePath: dbPath,
        provider,
        prompter,
        assumeYes: parsed.assumeYes,
        paths: runtimePaths,
      });
      return writeMutationCommandSuccess(parsed, context, {
        data: buildFieldMutationData(result),
        previewData: buildFieldPreviewData(result),
        reusedExisting: result.reusedExisting,
        reusedMessage: "The existing pending field update was reconciled instead of creating a duplicate.",
        interactive,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps(`cogcoin field show ${result.domainName} ${result.fieldName}`),
        text: {
          heading: "Field update submitted.",
          fields: [
            { label: "Domain", value: result.domainName },
            { label: "Field", value: result.fieldName },
            { label: "Sender", value: formatFieldSenderSummary(result) },
            { label: "Value", value: formatFieldValueSummary(result) },
            { label: "Effect", value: formatFieldEffect(result) },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      });
    }

    if (parsed.command === "field-clear") {
      const result = await context.clearField({
        domainName: parsed.args[0]!,
        fieldName: parsed.args[1]!,
        dataDir,
        databasePath: dbPath,
        provider,
        prompter,
        assumeYes: parsed.assumeYes,
        paths: runtimePaths,
      });
      return writeMutationCommandSuccess(parsed, context, {
        data: buildFieldMutationData(result),
        previewData: buildFieldPreviewData(result),
        reusedExisting: result.reusedExisting,
        reusedMessage: "The existing pending field clear was reconciled instead of creating a duplicate.",
        interactive,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps(`cogcoin field show ${result.domainName} ${result.fieldName}`),
        text: {
          heading: "Field clear submitted.",
          fields: [
            { label: "Domain", value: result.domainName },
            { label: "Field", value: result.fieldName },
            { label: "Sender", value: formatFieldSenderSummary(result) },
            { label: "Effect", value: formatFieldEffect(result) },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      });
    }

    if (isSendMutationCommand(parsed.command)) {
      const result = await context.sendCog({
        amountCogtoshi: parseCogAmountToCogtoshi(parsed.args[0]!),
        target: parsed.transferTarget!,
        dataDir,
        databasePath: dbPath,
        provider,
        prompter,
        assumeYes: parsed.assumeYes,
        paths: runtimePaths,
      });
      return writeMutationCommandSuccess(parsed, context, {
        data: buildCogMutationData(result, {
          commandKind: "send",
        }),
        previewData: buildCogPreviewData(result, {
          commandKind: "send",
        }),
        reusedExisting: result.reusedExisting,
        reusedMessage: "The existing pending COG transfer was reconciled instead of creating a duplicate.",
        interactive,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps("cogcoin balance"),
        text: {
          heading: "COG transfer submitted.",
          fields: [
            { label: "Sender", value: formatCogSenderSummary(result) },
            { label: "Amount", value: `${result.amountCogtoshi?.toString() ?? "unknown"} cogtoshi` },
            { label: "Recipient", value: result.recipientScriptPubKeyHex === null || result.recipientScriptPubKeyHex === undefined ? "unknown" : `spk:${result.recipientScriptPubKeyHex}` },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      });
    }

    if (parsed.command === "cog-lock") {
      const result = await context.lockCogToDomain({
        amountCogtoshi: parseCogAmountToCogtoshi(parsed.args[0]!),
        recipientDomainName: parsed.lockRecipientDomain!,
        timeoutBlocksOrDuration: parsed.unlockFor,
        timeoutHeight: parsed.untilHeight === null ? null : Number.parseInt(parsed.untilHeight, 10),
        conditionHex: parsed.conditionHex!,
        dataDir,
        databasePath: dbPath,
        provider,
        prompter,
        assumeYes: parsed.assumeYes,
        paths: runtimePaths,
      });
      return writeMutationCommandSuccess(parsed, context, {
        data: buildCogMutationData(result, {
          commandKind: "cog-lock",
          timeoutBlocksOrDuration: parsed.unlockFor,
          timeoutHeight: parsed.untilHeight,
          conditionHex: parsed.conditionHex,
        }),
        previewData: buildCogPreviewData(result, {
          commandKind: "cog-lock",
          timeoutBlocksOrDuration: parsed.unlockFor,
          timeoutHeight: parsed.untilHeight,
          conditionHex: parsed.conditionHex,
        }),
        reusedExisting: result.reusedExisting,
        reusedMessage: "The existing pending lock was reconciled instead of creating a duplicate.",
        interactive,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps("cogcoin locks"),
        text: {
          heading: "COG lock submitted.",
          fields: [
            { label: "Sender", value: formatCogSenderSummary(result) },
            { label: "Amount", value: `${result.amountCogtoshi?.toString() ?? "unknown"} cogtoshi` },
            { label: "Recipient domain", value: result.recipientDomainName ?? "unknown" },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      });
    }

    if (isClaimMutationCommand(parsed.command)) {
      const result = await context.claimCogLock({
        lockId: Number.parseInt(parsed.args[0]!, 10),
        preimageHex: parsed.preimageHex!,
        dataDir,
        databasePath: dbPath,
        provider,
        prompter,
        paths: runtimePaths,
      });
      return writeMutationCommandSuccess(parsed, context, {
        data: buildCogMutationData(result, {
          commandKind: "claim",
        }),
        previewData: buildCogPreviewData(result, {
          commandKind: "claim",
        }),
        reusedExisting: result.reusedExisting,
        reusedMessage: "The existing pending claim was reconciled instead of creating a duplicate.",
        interactive,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps("cogcoin locks --claimable"),
        text: {
          heading: "Lock claim submitted.",
          fields: [
            { label: "Lock", value: String(result.lockId ?? "unknown") },
            { label: "Path", value: formatCogClaimPath(result) },
            { label: "Sender", value: formatCogSenderSummary(result) },
            { label: "Amount", value: `${result.amountCogtoshi?.toString() ?? "unknown"} cogtoshi` },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      });
    }

    if (isReclaimMutationCommand(parsed.command)) {
      const result = await context.reclaimCogLock({
        lockId: Number.parseInt(parsed.args[0]!, 10),
        dataDir,
        databasePath: dbPath,
        provider,
        prompter,
        paths: runtimePaths,
      });
      return writeMutationCommandSuccess(parsed, context, {
        data: buildCogMutationData(result, {
          commandKind: "reclaim",
        }),
        previewData: buildCogPreviewData(result, {
          commandKind: "reclaim",
        }),
        reusedExisting: result.reusedExisting,
        reusedMessage: "The existing pending reclaim was reconciled instead of creating a duplicate.",
        interactive,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps("cogcoin locks --reclaimable"),
        text: {
          heading: "Lock reclaim submitted.",
          fields: [
            { label: "Lock", value: String(result.lockId ?? "unknown") },
            { label: "Path", value: formatCogClaimPath(result) },
            { label: "Sender", value: formatCogSenderSummary(result) },
            { label: "Amount", value: `${result.amountCogtoshi?.toString() ?? "unknown"} cogtoshi` },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      });
    }

    if (isReputationMutationCommand(parsed.command)) {
      const result = parsed.command === "rep-give"
        ? await context.giveReputation({
          sourceDomainName: parsed.args[0]!,
          targetDomainName: parsed.args[1]!,
          amountCogtoshi: parseCogAmountToCogtoshi(parsed.args[2]!),
          reviewText: parsed.reviewText,
          dataDir,
          databasePath: dbPath,
          provider,
          prompter,
          assumeYes: parsed.assumeYes,
          paths: runtimePaths,
        })
        : await context.revokeReputation({
          sourceDomainName: parsed.args[0]!,
          targetDomainName: parsed.args[1]!,
          amountCogtoshi: parseCogAmountToCogtoshi(parsed.args[2]!),
          reviewText: parsed.reviewText,
          dataDir,
          databasePath: dbPath,
          provider,
          prompter,
          assumeYes: parsed.assumeYes,
          paths: runtimePaths,
        });
      return writeMutationCommandSuccess(parsed, context, {
        data: buildReputationMutationData(result),
        previewData: buildReputationPreviewData(result),
        reusedExisting: result.reusedExisting,
        reusedMessage: "The existing pending reputation mutation was reconciled instead of creating a duplicate.",
        interactive,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps(`cogcoin show ${result.targetDomainName}`),
        text: {
          heading: parsed.command === "rep-give" ? "Reputation support submitted." : "Reputation revoke submitted.",
          fields: [
            { label: "Source domain", value: result.sourceDomainName },
            { label: "Target domain", value: result.targetDomainName },
            { label: "Sender", value: formatReputationSenderSummary(result) },
            { label: "Amount", value: `${result.amountCogtoshi.toString()} cogtoshi` },
            { label: "Review", value: formatReputationReviewSummary(result) },
            { label: "Effect", value: formatReputationEffect(result) },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      });
    }

    if (isBuyMutationCommand(parsed.command)) {
      const result = await context.buyDomain({
        domainName: parsed.args[0]!,
        dataDir,
        databasePath: dbPath,
        provider,
        prompter,
        assumeYes: parsed.assumeYes,
        paths: runtimePaths,
      });
      return writeMutationCommandSuccess(parsed, context, {
        data: buildDomainMarketMutationData(result, {
          commandKind: "buy",
        }),
        previewData: buildDomainMarketPreviewData(result, {
          commandKind: "buy",
        }),
        reusedExisting: result.reusedExisting,
        reusedMessage: "The existing pending purchase was reconciled instead of creating a duplicate.",
        interactive,
        explorerTxid: result.txid,
        nextSteps: commandMutationNextSteps(`cogcoin show ${result.domainName}`),
        text: {
          heading: "Purchase submitted.",
          fields: [
            { label: "Domain", value: result.domainName },
            { label: "Buyer", value: formatBuyBuyerSummary(result) },
            { label: "Seller", value: formatBuySellerSummary(result) },
            { label: "Price", value: `${result.listedPriceCogtoshi?.toString() ?? "unknown"} cogtoshi` },
            { label: "Settlement", value: formatBuySettlementSummary() },
            { label: "Status", value: result.status },
            { label: "Txid", value: result.txid },
          ],
        },
      });
    }

      writeLine(context.stderr, `wallet mutation command not implemented: ${parsed.command}`);
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
