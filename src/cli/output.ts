import type { CommandName, OutputMode, ParsedCliArgs, WritableLike } from "./types.js";

export interface JsonAvailabilityEntry {
  available: boolean;
  stale: boolean;
  reason: string | null;
  state?: string | null;
  source?: string | null;
  operatorValidationState?: string | null;
  cooldownActive?: boolean | null;
  publishState?: string | null;
  replicaStatus?: string | null;
  serviceApiVersion?: string | null;
  binaryVersion?: string | null;
  buildId?: string | null;
  serviceInstanceId?: string | null;
  processId?: number | null;
  walletRootId?: string | null;
  chain?: string | null;
  dataDir?: string | null;
  runtimeRoot?: string | null;
  startedAtUnixMs?: number | null;
  updatedAtUnixMs?: number | null;
  schemaVersion?: string | null;
  daemonInstanceId?: string | null;
  snapshotSeq?: string | null;
  heartbeatAtUnixMs?: number | null;
  openedAtUnixMs?: number | null;
  activeSnapshotCount?: number | null;
  backlogBlocks?: number | null;
  reorgDepth?: number | null;
  lastError?: string | null;
  appliedTipHeight?: number | null;
  appliedTipHash?: string | null;
  coreBestHeight?: number | null;
  coreBestHash?: string | null;
}

export interface JsonPage {
  limit: number | null;
  returned: number;
  truncated: boolean;
  moreAvailable: boolean | null;
  totalKnown: number | null;
}

export interface StableJsonEnvelopeBase {
  schema: string;
  command: string;
  generatedAtUnixMs: number;
  warnings: string[];
  explanations: string[];
  nextSteps: string[];
}

export interface StableJsonSuccessEnvelope<T> extends StableJsonEnvelopeBase {
  ok: true;
  data: T;
}

export interface StableJsonErrorEnvelope extends StableJsonEnvelopeBase {
  ok: false;
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
}

export interface MutationJsonEnvelopeBase {
  schema: string;
  ok: boolean;
  command: string;
  generatedAtUnixMs: number;
  outcome: string;
  warnings: string[];
  explanations: string[];
  nextSteps: string[];
}

export interface MutationJsonSuccessEnvelope<T> extends MutationJsonEnvelopeBase {
  ok: true;
  data: T;
}

export interface MutationJsonErrorEnvelope extends MutationJsonEnvelopeBase {
  ok: false;
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
}

export interface PreviewJsonEnvelopeBase {
  schema: string;
  ok: boolean;
  command: string;
  generatedAtUnixMs: number;
  outcome: string;
  warnings: string[];
  explanations: string[];
  nextSteps: string[];
}

export interface PreviewJsonSuccessEnvelope<T> extends PreviewJsonEnvelopeBase {
  ok: true;
  data: T;
}

export interface PreviewJsonErrorEnvelope extends PreviewJsonEnvelopeBase {
  ok: false;
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
}

export function writeJsonValue(stream: WritableLike, value: unknown): void {
  stream.write(`${JSON.stringify(value, jsonReplacer)}\n`);
}

export function isStructuredOutputMode(mode: OutputMode): boolean {
  return mode === "json" || mode === "preview-json";
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function createSuccessEnvelope<T>(
  schema: string,
  command: string,
  data: T,
  options: {
    warnings?: string[];
    explanations?: string[];
    nextSteps?: string[];
    generatedAtUnixMs?: number;
  } = {},
): StableJsonSuccessEnvelope<T> {
  return {
    schema,
    ok: true,
    command,
    generatedAtUnixMs: options.generatedAtUnixMs ?? Date.now(),
    warnings: options.warnings ?? [],
    explanations: options.explanations ?? [],
    nextSteps: options.nextSteps ?? [],
    data,
  };
}

export function createErrorEnvelope(
  schema: string,
  command: string,
  errorCode: string,
  message: string,
  options: {
    warnings?: string[];
    explanations?: string[];
    nextSteps?: string[];
    details?: Record<string, unknown>;
    generatedAtUnixMs?: number;
  } = {},
): StableJsonErrorEnvelope {
  return {
    schema,
    ok: false,
    command,
    generatedAtUnixMs: options.generatedAtUnixMs ?? Date.now(),
    warnings: options.warnings ?? [],
    explanations: options.explanations ?? [],
    nextSteps: options.nextSteps ?? [],
    error: {
      code: errorCode,
      message,
      details: options.details ?? {},
    },
  };
}

export function createPreviewSuccessEnvelope<T>(
  schema: string,
  command: string,
  outcome: string,
  data: T,
  options: {
    warnings?: string[];
    explanations?: string[];
    nextSteps?: string[];
    generatedAtUnixMs?: number;
  } = {},
): PreviewJsonSuccessEnvelope<T> {
  return {
    schema,
    ok: true,
    command,
    generatedAtUnixMs: options.generatedAtUnixMs ?? Date.now(),
    outcome,
    warnings: options.warnings ?? [],
    explanations: options.explanations ?? [],
    nextSteps: options.nextSteps ?? [],
    data,
  };
}

export function createMutationSuccessEnvelope<T>(
  schema: string,
  command: string,
  outcome: string,
  data: T,
  options: {
    warnings?: string[];
    explanations?: string[];
    nextSteps?: string[];
    generatedAtUnixMs?: number;
  } = {},
): MutationJsonSuccessEnvelope<T> {
  return {
    schema,
    ok: true,
    command,
    generatedAtUnixMs: options.generatedAtUnixMs ?? Date.now(),
    outcome,
    warnings: options.warnings ?? [],
    explanations: options.explanations ?? [],
    nextSteps: options.nextSteps ?? [],
    data,
  };
}

export function createPreviewErrorEnvelope(
  schema: string,
  command: string,
  errorCode: string,
  message: string,
  options: {
    outcome?: string;
    warnings?: string[];
    explanations?: string[];
    nextSteps?: string[];
    details?: Record<string, unknown>;
    generatedAtUnixMs?: number;
  } = {},
): PreviewJsonErrorEnvelope {
  return {
    schema,
    ok: false,
    command,
    generatedAtUnixMs: options.generatedAtUnixMs ?? Date.now(),
    outcome: options.outcome ?? "failed",
    warnings: options.warnings ?? [],
    explanations: options.explanations ?? [],
    nextSteps: options.nextSteps ?? [],
    error: {
      code: errorCode,
      message,
      details: options.details ?? {},
    },
  };
}

export function createMutationErrorEnvelope(
  schema: string,
  command: string,
  errorCode: string,
  message: string,
  options: {
    outcome?: string;
    warnings?: string[];
    explanations?: string[];
    nextSteps?: string[];
    details?: Record<string, unknown>;
    generatedAtUnixMs?: number;
  } = {},
): MutationJsonErrorEnvelope {
  return {
    schema,
    ok: false,
    command,
    generatedAtUnixMs: options.generatedAtUnixMs ?? Date.now(),
    outcome: options.outcome ?? "failed",
    warnings: options.warnings ?? [],
    explanations: options.explanations ?? [],
    nextSteps: options.nextSteps ?? [],
    error: {
      code: errorCode,
      message,
      details: options.details ?? {},
    },
  };
}

export function normalizeListPage<T>(items: readonly T[], options: {
  limit: number | null;
  all: boolean;
  defaultLimit: number;
}): { items: T[]; page: JsonPage } {
  const totalKnown = items.length;
  const appliedLimit = options.all ? null : (options.limit ?? options.defaultLimit);
  const pagedItems = appliedLimit === null ? [...items] : items.slice(0, appliedLimit);
  const truncated = appliedLimit !== null && totalKnown > appliedLimit;

  return {
    items: pagedItems,
    page: {
      limit: appliedLimit,
      returned: pagedItems.length,
      truncated,
      moreAvailable: truncated,
      totalKnown,
    },
  };
}

export function createTruncationNote(page: JsonPage): string | null {
  if (!page.truncated || page.limit === null || page.totalKnown === null) {
    return null;
  }

  return `Showing first ${page.returned} of ${page.totalKnown}. Use --limit <n> or --all for more.`;
}

export function classifyCliError(error: unknown): {
  exitCode: number;
  errorCode: string;
  message: string;
} {
  const message = error instanceof Error ? error.message : String(error);

  if (message.startsWith("cli_")) {
    return { exitCode: 2, errorCode: message, message };
  }

  if (/^wallet_init_confirmation_failed_word_\d+$/.test(message)) {
    return { exitCode: 2, errorCode: message, message };
  }

  if (message === "mining_hooks_enable_trust_acknowledgement_required") {
    return { exitCode: 2, errorCode: message, message };
  }

  if (
    message === "mining_setup_invalid_provider"
    || message === "mining_setup_missing_api_key"
  ) {
    return { exitCode: 2, errorCode: message, message };
  }

  if (message.startsWith("mining_hooks_enable_template_created:")) {
    return {
      exitCode: 4,
      errorCode: "mining_hooks_enable_template_created",
      message,
    };
  }

  if (message.startsWith("mining_hooks_enable_validation_failed:")) {
    return {
      exitCode: 5,
      errorCode: "mining_hooks_enable_validation_failed",
      message,
    };
  }

  if (message.endsWith("_typed_ack_required")) {
    return { exitCode: 2, errorCode: message, message };
  }

  if (
    message === "wallet_typed_confirmation_rejected"
    || message === "wallet_export_overwrite_declined"
    || message === "wallet_delete_confirmation_required"
    || message === "wallet_prompt_value_required"
    || message === "wallet_archive_passphrase_mismatch"
    || message === "wallet_restore_mnemonic_invalid"
    || message === "wallet_restore_replace_confirmation_required"
    || message === "wallet_seed_name_invalid"
    || message === "wallet_seed_name_reserved"
    || message === "reset_wallet_choice_invalid"
    || message === "reset_wallet_passphrase_required"
    || message === "reset_wallet_access_failed"
  ) {
    return { exitCode: 2, errorCode: message, message };
  }

  if (message === "not_found") {
    return { exitCode: 3, errorCode: "not_found", message: "Requested object not found." };
  }

  if (message === "wallet_import_archive_not_found") {
    return { exitCode: 3, errorCode: message, message };
  }

  if (message === "wallet_seed_not_found") {
    return { exitCode: 3, errorCode: message, message };
  }

  if (message === "wallet_seed_index_invalid") {
    return { exitCode: 4, errorCode: message, message };
  }

  if (
    message === "reset_process_shutdown_failed"
    || message === "reset_data_root_delete_failed"
    || message === "reset_secret_cleanup_failed"
    || message === "reset_snapshot_preserve_failed"
  ) {
    return { exitCode: 5, errorCode: message, message };
  }

  if (isBlockedError(message)) {
    return { exitCode: 4, errorCode: message, message };
  }

  return { exitCode: 5, errorCode: message, message };
}

function isBlockedError(message: string): boolean {
  if (
    message === "wallet_locked"
    || message === "wallet_uninitialized"
    || message === "local-state-corrupt"
    || message === "wallet_already_initialized"
    || message === "wallet_export_core_replica_not_ready"
    || message === "wallet_export_tip_mismatch"
    || message === "wallet_export_requires_quiescent_local_state"
    || message === "wallet_restore_requires_main_wallet"
    || message === "wallet_seed_name_exists"
    || message === "wallet_seed_not_found"
    || message === "wallet_delete_main_not_supported"
    || message === "wallet_repair_indexer_reset_requires_yes"
    || message === "managed_bitcoind_service_version_mismatch"
    || message === "managed_bitcoind_wallet_root_mismatch"
    || message === "managed_bitcoind_runtime_mismatch"
    || message === "indexer_daemon_service_version_mismatch"
    || message === "indexer_daemon_wallet_root_mismatch"
    || message === "indexer_daemon_schema_mismatch"
    || message === "mine_setup_requires_tty"
    || message === "mining_hooks_enable_requires_tty"
    || message === "mining_preemption_timeout"
    || message === "wallet_secret_provider_linux_secret_tool_missing"
    || message === "wallet_secret_provider_linux_secret_service_unavailable"
    || message === "wallet_secret_provider_linux_runtime_error"
  ) {
    return true;
  }

  return /(?:^|_)(?:locked|uninitialized|repair_required|requires_tty|typed_ack_required|confirmation_rejected|tip_mismatch|core_replica_not_ready|setup|no_eligible_sender|ambiguous_sender|insufficient|stale|paused|validation|catching_up|starting|unavailable|schema_mismatch|service_version_mismatch|wallet_root_mismatch|runtime_mismatch|replica_missing|replica_mismatch|failed)(?:_|$)/.test(message)
    || /repair-required/.test(message);
}

export function formatCliTextError(error: unknown): string[] | null {
  const classified = classifyCliError(error);
  const presentation = createCliErrorPresentation(classified.errorCode, classified.message);

  if (presentation === null) {
    return null;
  }

  const lines = [`What happened: ${presentation.what}`];

  if (presentation.why !== null) {
    lines.push(`Why: ${presentation.why}`);
  }

  if (presentation.next !== null) {
    lines.push(`Next: ${presentation.next}`);
  }

  return lines;
}

export function createCliErrorPresentation(
  errorCode: string,
  fallbackMessage: string,
): {
  what: string;
  why: string | null;
  next: string | null;
} | null {
  if (errorCode === "wallet_locked") {
    return {
      what: "Wallet is locked.",
      why: "This command needs access to the unlocked local wallet state before it can continue. Provider-backed wallets unlock on demand unless they were explicitly locked or the local secret store is unavailable.",
      next: "Run `cogcoin unlock --for 15m` and retry.",
    };
  }

  if (errorCode === "reset_wallet_choice_invalid") {
    return {
      what: "Wallet reset choice is invalid.",
      why: "This reset path accepts only Enter for the default entropy-retaining reset, \"skip\", or \"delete wallet\".",
      next: "Rerun `cogcoin reset` and enter one of the accepted wallet reset choices.",
    };
  }

  if (errorCode === "reset_wallet_passphrase_required") {
    return {
      what: "Wallet-state passphrase is required.",
      why: "The current wallet is passphrase-wrapped, so the entropy-retaining reset path needs that passphrase before it can rebuild a fresh local wallet from the retained mnemonic.",
      next: "Rerun `cogcoin reset` and enter the wallet-state passphrase, or choose \"skip\" or \"delete wallet\" instead.",
    };
  }

  if (errorCode === "reset_wallet_access_failed") {
    return {
      what: "Wallet state could not be opened for entropy-retaining reset.",
      why: "The wallet-state passphrase was not accepted, or the passphrase-wrapped wallet state could not be decrypted cleanly.",
      next: "Rerun `cogcoin reset`, enter the correct wallet-state passphrase, or choose \"skip\" or \"delete wallet\" instead.",
    };
  }

  if (errorCode === "reset_wallet_entropy_reset_unavailable") {
    return {
      what: "Entropy-retaining wallet reset is unavailable.",
      why: "Cogcoin found wallet state, but it could not safely load and reconstruct it into a fresh wallet while preserving only the mnemonic-derived continuity data.",
      next: "Rerun `cogcoin reset` and choose \"skip\" to keep the wallet unchanged, or type \"delete wallet\" to erase it fully.",
    };
  }

  if (errorCode === "reset_process_shutdown_failed") {
    return {
      what: "Reset could not stop all tracked managed processes.",
      why: "At least one Cogcoin-managed background process remained alive after the reset shutdown attempt, so the filesystem reset was aborted before deleting local state.",
      next: "Stop the remaining managed process and rerun `cogcoin reset`.",
    };
  }

  if (errorCode === "reset_data_root_delete_failed") {
    return {
      what: "Reset could not remove the local Cogcoin data roots.",
      why: "The reset flow reached the destructive phase, but at least one local Cogcoin data root could not be deleted completely.",
      next: "Check permissions and any open file handles under the Cogcoin data roots, then rerun `cogcoin reset`.",
    };
  }

  if (errorCode === "reset_secret_cleanup_failed") {
    return {
      what: "Reset finished the filesystem wipe but could not fully clean up wallet secret-provider entries.",
      why: "The local Cogcoin files were already removed or rewritten, but at least one discoverable OS secret-store entry could not be deleted cleanly.",
      next: "Remove the remaining Cogcoin wallet secret from the local secret store, then rerun `cogcoin status` to confirm the new state.",
    };
  }

  if (errorCode === "reset_snapshot_preserve_failed") {
    return {
      what: "Reset could not preserve the downloaded 910000 UTXO snapshot.",
      why: "You asked reset to keep the valid snapshot, but staging or restoring that large bootstrap file did not complete successfully.",
      next: "Rerun `cogcoin reset` and choose to delete the snapshot, or restore the snapshot file manually before retrying.",
    };
  }

  if (errorCode === "wallet_uninitialized") {
    return {
      what: "Wallet is not initialized.",
      why: "There is no local wallet root yet for this command to use.",
      next: "Run `cogcoin init` first.",
    };
  }

  if (errorCode === "wallet_repair_indexer_reset_requires_yes") {
    return {
      what: "Repair needs permission to reset the local indexer database.",
      why: "The local indexer database could not be opened as a healthy Cogcoin store, so repair would need to delete and rebuild it before continuing.",
      next: "Rerun `cogcoin repair --yes` to allow repair to recreate the local indexer database.",
    };
  }

  if (errorCode === "wallet_already_initialized") {
    return {
      what: "Wallet is already initialized.",
      why: "This machine already has a local wallet root, so initialization cannot safely create a second one in the same runtime location.",
      next: "Run `cogcoin status` to inspect the existing wallet, or export/import it instead of reinitializing.",
    };
  }

  if (errorCode === "wallet_restore_requires_main_wallet") {
    return {
      what: "Main wallet is required before importing another seed.",
      why: "Named restore only creates imported seeds. Cogcoin requires the primary `main` wallet to exist first so shared local state has a canonical default seed.",
      next: "Run `cogcoin init`, then rerun `cogcoin restore --seed <name>`.",
    };
  }

  if (errorCode === "wallet_seed_name_exists") {
    return {
      what: "Seed name is already in use.",
      why: "This machine already has a wallet seed registered with that name.",
      next: "Choose a different `--seed` name, or delete the imported seed first with `cogcoin wallet delete --seed <name>`.",
    };
  }

  if (errorCode === "wallet_seed_not_found") {
    return {
      what: "Seed was not found.",
      why: "No local wallet seed is registered under that name.",
      next: "Check `--seed <name>` and retry.",
    };
  }

  if (errorCode === "wallet_seed_index_invalid") {
    return {
      what: "Wallet seed registry is invalid.",
      why: "Cogcoin could not parse or trust the local seed registry file, so it cannot safely decide which named wallet seed to use.",
      next: "Run `cogcoin repair`, then retry the command.",
    };
  }

  if (errorCode === "wallet_delete_main_not_supported") {
    return {
      what: "The main wallet cannot be deleted with `wallet delete`.",
      why: "This command only removes imported seeds. The canonical `main` wallet is part of the base local client state.",
      next: "Use `cogcoin reset` if you need to remove the main wallet.",
    };
  }

  if (errorCode === "local-state-corrupt" || errorCode.includes("repair_required") || errorCode.includes("repair-required")) {
    return {
      what: "Local recovery is required.",
      why: "The wallet detected unresolved or untrusted local state for this operation.",
      next: "Run `cogcoin repair`, then retry the command.",
    };
  }

  if (errorCode.endsWith("_typed_ack_required")) {
    return {
      what: "Typed acknowledgement is still required.",
      why: "`--yes` only bypasses plain yes/no confirmation. This path requires the exact typed acknowledgement because it is higher risk or irreversible.",
      next: "Rerun the command in an interactive terminal and type the requested acknowledgement.",
    };
  }

  if (errorCode === "wallet_typed_confirmation_rejected") {
    return {
      what: "Typed acknowledgement was declined.",
      why: "This secure admin command requires the exact typed acknowledgement before it will continue.",
      next: "Rerun the command in an interactive terminal and type the requested acknowledgement.",
    };
  }

  if (errorCode === "wallet_export_overwrite_declined") {
    return {
      what: "Archive overwrite was declined.",
      why: "The export path already exists, and the command will not replace that archive unless you explicitly approve it.",
      next: "Rerun the command and type `yes` when prompted if you want to overwrite the archive.",
    };
  }

  if (/^wallet_init_confirmation_failed_word_\d+$/.test(errorCode)) {
    return {
      what: "Mnemonic confirmation failed.",
      why: "The requested recovery-phrase confirmation word did not match, so wallet initialization was canceled before it could finish.",
      next: "Run `cogcoin init` again and re-enter the requested confirmation words carefully. The same recovery phrase will be shown until confirmation succeeds.",
    };
  }

  if (errorCode === "wallet_restore_mnemonic_invalid") {
    return {
      what: "Recovery phrase is invalid.",
      why: "Mnemonic-only restore accepts only a valid 24-word English BIP39 phrase with a matching checksum.",
      next: "Rerun `cogcoin restore --seed <name>` and enter the 24 recovery words in the original order.",
    };
  }

  if (errorCode === "wallet_restore_replace_confirmation_required") {
    return {
      what: "Typed replacement acknowledgement is still required.",
      why: "Mnemonic restore will replace the existing local wallet state and managed Core wallet replica only after you type the exact replacement acknowledgement.",
      next: "Rerun `cogcoin restore` in an interactive terminal and type \"RESTORE\" when prompted.",
    };
  }

  if (errorCode === "wallet_seed_name_invalid" || errorCode === "wallet_seed_name_reserved" || errorCode === "cli_invalid_seed_name") {
    return {
      what: "Seed name is invalid.",
      why: "Wallet seed names must be lowercase slugs like `trading` or `cold-backup`, and `main` is reserved.",
      next: "Choose a different seed name and retry.",
    };
  }

  if (errorCode === "cli_missing_seed_name") {
    return {
      what: "A seed name is required.",
      why: "This command needs `--seed <name>` to identify which imported wallet seed it should restore or delete.",
      next: "Rerun the command with `--seed <name>`.",
    };
  }

  if (errorCode === "cli_seed_not_supported_for_command" || errorCode === "wallet_init_seed_not_supported" || errorCode === "wallet_import_seed_not_supported") {
    return {
      what: "This command does not support `--seed`.",
      why: "Only wallet-aware commands are seed-selectable. Global lifecycle and shared service commands still operate on the shared local client state.",
      next: "Drop `--seed` for this command and retry.",
    };
  }

  if (errorCode === "wallet_anchor_clear_inconsistent_state") {
    return {
      what: "Pending anchor state is inconsistent.",
      why: "The domain still shows local pending anchor state, but the wallet could not find a matching clearable reserved anchor family.",
      next: "Run `cogcoin repair`, then inspect the domain again before retrying `cogcoin anchor clear`.",
    };
  }

  if (errorCode.startsWith("wallet_anchor_clear_not_clearable_")) {
    return {
      what: "Pending anchor cannot be cleared safely.",
      why: "This command only clears a local pre-broadcast reservation. The anchor family is already beyond that safe stage or may have been observed by the wallet.",
      next: "Rerun `cogcoin anchor <domain>` to reconcile the family, or run `cogcoin repair` if it remains unresolved.",
    };
  }

  if (errorCode === "mining_hooks_enable_trust_acknowledgement_required") {
    return {
      what: "Trust acknowledgement is still required.",
      why: "Enabling a custom mining hook grants unsandboxed local JavaScript full access to the current OS account and readable local data.",
      next: "Rerun `cogcoin hooks enable mining` in an interactive terminal and type the requested trust acknowledgement.",
    };
  }

  if (errorCode === "mining_hooks_enable_template_created") {
    return {
      what: "Default mining hook template was created.",
      why: "The wallet wrote starter custom-hook files and stopped before enabling custom mode so you can review and edit them first.",
      next: "Edit `generate-sentences.js`, then rerun `cogcoin hooks enable mining`.",
    };
  }

  if (errorCode === "mining_hooks_enable_validation_failed") {
    return {
      what: "Custom mining hook validation failed.",
      why: "The hook files, package shape, trust checks, or isolated validation run did not pass the required checks.",
      next: "Fix the custom mining hook and rerun `cogcoin hooks enable mining`.",
    };
  }

  if (errorCode === "mining_setup_invalid_provider") {
    return {
      what: "Mining provider choice is invalid.",
      why: "Built-in mining setup currently supports only `openai` or `anthropic` as the provider selection.",
      next: "Rerun `cogcoin mine setup` and choose either `openai` or `anthropic`.",
    };
  }

  if (errorCode === "mining_setup_missing_api_key") {
    return {
      what: "Mining provider API key is required.",
      why: "Built-in mining setup cannot save provider configuration without a non-empty API key.",
      next: "Rerun `cogcoin mine setup` and enter the provider API key when prompted.",
    };
  }

  if (errorCode.endsWith("_confirmation_rejected")) {
    return {
      what: "Confirmation was declined.",
      why: "The command requires explicit approval before it will publish a state-changing action.",
      next: "Rerun the command and confirm it. If this command uses a plain yes/no path, you can also add `--yes`.",
    };
  }

  if (errorCode === "wallet_prompt_value_required") {
    return {
      what: "Required input was not provided.",
      why: "This secure admin command needs a non-empty terminal response before it can continue safely.",
      next: "Rerun the command in an interactive terminal and enter the requested value.",
    };
  }

  if (errorCode === "wallet_archive_passphrase_mismatch") {
    return {
      what: "Archive passphrases did not match.",
      why: "The archive passphrase must be entered the same way twice so the wallet does not seal the archive with a typo.",
      next: "Rerun the command and enter the same archive passphrase both times.",
    };
  }

  if (errorCode === "wallet_secret_provider_linux_secret_tool_missing") {
    return {
      what: "Linux secret-store support (`secret-tool`) is not installed.",
      why: "Cogcoin uses `secret-tool` to talk to Secret Service on Linux, but that helper is not available in this environment.",
      next: "Install `secret-tool`/libsecret for this machine, then rerun the command.",
    };
  }

  if (errorCode === "wallet_secret_provider_linux_secret_service_unavailable") {
    return {
      what: "Linux Secret Service is unavailable or locked.",
      why: "The local Secret Service session could not be reached for wallet-secret storage, so the wallet cannot read or write its encryption keys.",
      next: "Start or unlock your desktop keyring/Secret Service session, then rerun the command.",
    };
  }

  if (errorCode === "wallet_secret_provider_linux_runtime_error") {
    return {
      what: "Linux secret-store operation failed.",
      why: "`secret-tool` ran but did not complete a usable wallet-secret operation for this command.",
      next: "Check that Secret Service is running correctly on this machine, then retry.",
    };
  }

  if (errorCode.endsWith("_requires_tty")) {
    return {
      what: "Interactive terminal input is required.",
      why: "This command needs terminal input before it can continue safely.",
      next: "Rerun the command in an interactive terminal.",
    };
  }

  if (errorCode === "wallet_import_archive_not_found") {
    return {
      what: "Wallet archive was not found.",
      why: "The specified import archive path does not exist or is not readable from this machine.",
      next: "Check the archive path and retry.",
    };
  }

  if (errorCode === "wallet_export_requires_quiescent_local_state") {
    return {
      what: "Wallet export is blocked until local state is quiescent.",
      why: "Portable export waits for mining, proactive families, and pending mutations to settle so the archive reflects trustworthy local state.",
      next: "Wait for active local work to finish or repair it, then retry the export.",
    };
  }

  if (errorCode.includes("tip_mismatch") || errorCode.includes("stale") || errorCode.includes("catching_up") || errorCode.includes("starting")) {
    return {
      what: "Trusted service state is not ready.",
      why: "The wallet, bitcoind, or indexer is not yet aligned closely enough for this command to proceed safely.",
      next: "Check `cogcoin status`, wait for services to settle, and retry. If the state stays degraded, run `cogcoin repair`.",
    };
  }

  if (errorCode === "indexer_daemon_service_version_mismatch") {
    return {
      what: "The live indexer daemon is running an incompatible service API version.",
      why: "This wallet only trusts indexer daemons that speak `cogcoin/indexer-ipc/v1`, and the reachable daemon reported a different API version.",
      next: "Run `cogcoin repair` so the wallet can stop the incompatible daemon and restart a compatible managed indexer service.",
    };
  }

  if (errorCode === "indexer_daemon_wallet_root_mismatch") {
    return {
      what: "The live indexer daemon belongs to a different wallet root.",
      why: "Managed indexer daemons are namespaced per wallet root, and the reachable daemon reported a different wallet root than this local wallet.",
      next: "Run `cogcoin repair` so the wallet can stop the conflicting managed daemon and restore the correct local indexer service.",
    };
  }

  if (errorCode === "indexer_daemon_schema_mismatch") {
    return {
      what: "The live indexer daemon is using an incompatible sqlite schema.",
      why: "This wallet only trusts indexer daemons with the expected sqlite schema contract, and the reachable daemon reported a schema mismatch.",
      next: "Run `cogcoin repair` after stopping the incompatible daemon, then retry.",
    };
  }

  if (errorCode === "indexer_daemon_protocol_error") {
    return {
      what: "The live indexer daemon socket is not speaking the expected protocol.",
      why: "A process is bound to the managed indexer socket, but it did not respond with a valid cogcoin indexer IPC status exchange.",
      next: "Run `cogcoin repair` to clear stale managed indexer artifacts and restore a compatible daemon.",
    };
  }

  if (errorCode === "managed_bitcoind_service_version_mismatch" || errorCode.includes("bitcoind_service_version_mismatch")) {
    return {
      what: "The live managed bitcoind service is running an incompatible service version.",
      why: "This wallet only trusts managed bitcoind services that speak `cogcoin/bitcoind-service/v1`, and the reachable service reported a different runtime contract.",
      next: "Run `cogcoin repair` so the wallet can stop the incompatible managed bitcoind service and restart a compatible one.",
    };
  }

  if (errorCode === "managed_bitcoind_wallet_root_mismatch" || errorCode.includes("bitcoind_wallet_root_mismatch")) {
    return {
      what: "The live managed bitcoind service belongs to a different wallet root.",
      why: "Managed bitcoind services are tied to one wallet root, and the reachable service reported a different wallet root than this local wallet expects.",
      next: "Run `cogcoin repair` so the wallet can stop the conflicting managed bitcoind service and restore the correct one.",
    };
  }

  if (errorCode === "managed_bitcoind_runtime_mismatch" || errorCode.includes("bitcoind_runtime_mismatch")) {
    return {
      what: "The live managed bitcoind service runtime does not match this wallet.",
      why: "The reachable service is using a different chain, data directory, or runtime root than this wallet expects, so its status cannot be trusted here.",
      next: "Run `cogcoin repair` so the wallet can clear the conflicting runtime and restart a compatible managed bitcoind service.",
    };
  }

  if (errorCode.includes("bitcoind_replica_missing")) {
    return {
      what: "The managed Core wallet replica is missing.",
      why: "This wallet needs a matching managed Core descriptor-wallet replica before it can safely perform stateful operations.",
      next: "Run `cogcoin repair` to recreate the managed Core wallet replica, then retry.",
    };
  }

  if (errorCode.includes("bitcoind_replica_mismatch")) {
    return {
      what: "The managed Core wallet replica does not match trusted wallet state.",
      why: "The local wallet state and the managed Core replica disagree, so this command refuses to keep going on untrusted Core metadata.",
      next: "Run `cogcoin repair` to recreate or rebind the managed Core wallet replica, then retry.",
    };
  }

  if (errorCode === "mining_preemption_timeout") {
    return {
      what: "Wallet repair is blocked by active mining work.",
      why: "Repair waits for mining generation work to acknowledge preemption before it mutates local indexer runtime artifacts.",
      next: "Pause or stop mining, then rerun `cogcoin repair`.",
    };
  }

  if (errorCode.includes("paused")) {
    return {
      what: "Work is currently paused.",
      why: "Another wallet or mining workflow has priority right now.",
      next: "Wait for the current work to settle, then rerun the command.",
    };
  }

  if (errorCode.includes("setup") || errorCode.includes("validation") || errorCode.includes("core_replica_not_ready")) {
    return {
      what: "Local setup is incomplete.",
      why: "This command depends on a local component that is not ready yet.",
      next: "Review the local status output, finish the required setup or repair step, and retry.",
    };
  }

  if (errorCode.includes("insufficient")) {
    return {
      what: "Available funds are insufficient.",
      why: "The selected wallet identity does not currently have enough spendable funds for this operation.",
      next: "Choose a different identity or add more funds, then retry.",
    };
  }

  if (errorCode === "wallet_register_from_not_supported_for_subdomain") {
    return {
      what: "`--from` is not supported for subdomain registration.",
      why: "Subdomain registration always derives the sender from the anchored parent owner, so this command will not accept an explicit sender override.",
      next: "Retry without `--from`, or register a root domain if you need explicit sender selection.",
    };
  }

  if (errorCode === "wallet_register_sender_not_root_eligible") {
    return {
      what: "Selected sender is not eligible for root registration.",
      why: "Root registration can use funding identity `0` or a locally controlled anchored owner identity with a current canonical anchor outpoint.",
      next: "Run `cogcoin ids`, then retry with `--from id:0` or an anchored local owner selector.",
    };
  }

  if (errorCode === "wallet_register_sender_not_found") {
    return {
      what: "Selected sender was not found locally.",
      why: "The provided selector did not resolve to a locally controlled identity in this wallet.",
      next: "Run `cogcoin ids` and retry with one of the listed selectors.",
    };
  }

  if (errorCode === "wallet_register_sender_read_only") {
    return {
      what: "Selected sender is read-only.",
      why: "This local identity is tracked for visibility only and cannot author new owner transactions.",
      next: "Retry with a locally controlled non-read-only sender.",
    };
  }

  if (errorCode === "wallet_register_sender_address_unavailable") {
    return {
      what: "Selected sender could not be displayed.",
      why: "The selector resolved to a local identity, but the wallet does not have a usable display address for it.",
      next: "Run `cogcoin ids` and retry with a different local sender selector.",
    };
  }

  if (errorCode === "wallet_buy_sender_not_found") {
    return {
      what: "Selected buyer was not found locally.",
      why: "The provided `--from` selector did not resolve to a locally controlled identity in this wallet.",
      next: "Run `cogcoin ids` and retry with one of the listed selectors.",
    };
  }

  if (errorCode === "wallet_buy_sender_read_only") {
    return {
      what: "Selected buyer is read-only.",
      why: "This local identity is tracked for visibility only and cannot author a domain purchase.",
      next: "Retry with a locally controlled non-read-only buyer selector.",
    };
  }

  if (errorCode === "wallet_buy_sender_address_unavailable") {
    return {
      what: "Selected buyer could not be displayed.",
      why: "The selector resolved to a local identity, but the wallet does not have a usable display address for it.",
      next: "Run `cogcoin ids` and retry with a different local buyer selector.",
    };
  }

  if (errorCode === "wallet_buy_already_owner") {
    return {
      what: "Selected buyer already owns the domain.",
      why: "A buy mutation must come from a different local identity than the current domain owner.",
      next: "Choose a different buyer with `--from`, or inspect the current owner with `cogcoin show <domain>`.",
    };
  }

  if (errorCode === "wallet_buy_insufficient_cog_balance") {
    return {
      what: "Selected buyer does not have enough COG.",
      why: "The chosen local identity does not currently have the listed domain price available in spendable COG balance.",
      next: "Choose a different buyer or add more COG to that identity, then retry.",
    };
  }

  if (errorCode === "wallet_transfer_owner_not_locally_controlled" || errorCode === "wallet_sell_owner_not_locally_controlled") {
    return {
      what: "Domain owner is not locally controlled.",
      why: "This command must be authored by the current unanchored domain owner, and that owner identity is not available in this wallet with a usable address.",
      next: "Inspect the current owner with `cogcoin show <domain>`, then retry from the wallet that controls that owner identity.",
    };
  }

  if (errorCode === "wallet_transfer_owner_read_only" || errorCode === "wallet_sell_owner_read_only") {
    return {
      what: "Domain owner is read-only.",
      why: "The current domain owner is tracked locally for visibility, but this wallet cannot author owner mutations from a read-only identity.",
      next: "Use the wallet that controls the owner identity, or import the spendable owner into this wallet before retrying.",
    };
  }

  if (
    errorCode === "wallet_field_create_owner_not_locally_controlled"
    || errorCode === "wallet_field_set_owner_not_locally_controlled"
    || errorCode === "wallet_field_clear_owner_not_locally_controlled"
  ) {
    return {
      what: "Anchored field owner is not locally controlled.",
      why: "Field mutations must be authored by the current anchored owner of the domain, and that owner identity is not available in this wallet with a usable address.",
      next: "Inspect the current owner with `cogcoin show <domain>`, then retry from the wallet that controls that anchored owner identity.",
    };
  }

  if (
    errorCode === "wallet_field_create_owner_read_only"
    || errorCode === "wallet_field_set_owner_read_only"
    || errorCode === "wallet_field_clear_owner_read_only"
  ) {
    return {
      what: "Anchored field owner is read-only.",
      why: "The current anchored owner is tracked locally for visibility, but this wallet cannot author field mutations from a read-only identity.",
      next: "Use the wallet that controls the anchored owner identity, or import the spendable owner into this wallet before retrying.",
    };
  }

  if (
    errorCode === "wallet_domain_endpoint_owner_not_locally_controlled"
    || errorCode === "wallet_domain_delegate_owner_not_locally_controlled"
    || errorCode === "wallet_domain_miner_owner_not_locally_controlled"
    || errorCode === "wallet_domain_canonical_owner_not_locally_controlled"
  ) {
    return {
      what: "Anchored domain owner is not locally controlled.",
      why: "This anchored domain-admin command must be authored by the current anchored owner, and that owner identity is not available in this wallet with a usable address.",
      next: "Inspect the current owner with `cogcoin show <domain>`, then retry from the wallet that controls that anchored owner identity.",
    };
  }

  if (
    errorCode === "wallet_domain_endpoint_owner_read_only"
    || errorCode === "wallet_domain_delegate_owner_read_only"
    || errorCode === "wallet_domain_miner_owner_read_only"
    || errorCode === "wallet_domain_canonical_owner_read_only"
  ) {
    return {
      what: "Anchored domain owner is read-only.",
      why: "The current anchored owner is tracked locally for visibility, but this wallet cannot author anchored admin mutations from a read-only identity.",
      next: "Use the wallet that controls the anchored owner identity, or import the spendable owner into this wallet before retrying.",
    };
  }

  if (
    errorCode === "wallet_rep_give_source_owner_not_locally_controlled"
    || errorCode === "wallet_rep_revoke_source_owner_not_locally_controlled"
  ) {
    return {
      what: "Anchored reputation source owner is not locally controlled.",
      why: "Reputation mutations must be authored by the current anchored owner of the source domain, and that owner identity is not available in this wallet with a usable address.",
      next: "Inspect the current source-domain owner with `cogcoin show <domain>`, then retry from the wallet that controls that anchored owner identity.",
    };
  }

  if (
    errorCode === "wallet_rep_give_source_owner_read_only"
    || errorCode === "wallet_rep_revoke_source_owner_read_only"
  ) {
    return {
      what: "Anchored reputation source owner is read-only.",
      why: "The current anchored source-domain owner is tracked locally for visibility, but this wallet cannot author reputation mutations from a read-only identity.",
      next: "Use the wallet that controls the anchored source-domain owner identity, or import the spendable owner into this wallet before retrying.",
    };
  }

  if (errorCode === "wallet_send_sender_address_unavailable" || errorCode === "wallet_lock_sender_address_unavailable") {
    return {
      what: "Selected sender could not be displayed.",
      why: "The wallet resolved a local sender identity, but it does not have a usable display address for that identity.",
      next: "Run `cogcoin ids` and retry with a different local sender selector.",
    };
  }

  if (errorCode === "wallet_claim_sender_not_local") {
    return {
      what: "The claim sender is not locally controlled.",
      why: "Before timeout, the wallet may only claim as the current recipient-domain owner, and that owner is not available in this wallet.",
      next: "Check the current recipient-domain owner with `cogcoin show <domain>` or use the wallet that controls that owner identity.",
    };
  }

  if (errorCode === "wallet_reclaim_sender_not_local") {
    return {
      what: "The reclaim sender is not locally controlled.",
      why: "After timeout, the wallet may only reclaim as the original locker, and that locker identity is not available in this wallet.",
      next: "Use the wallet that controls the original locker identity, or inspect the lock details with `cogcoin locks`.",
    };
  }

  if (errorCode.includes("ambiguous_sender") || errorCode.includes("no_eligible_sender")) {
    return {
      what: "Sender selection could not be resolved.",
      why: "The wallet could not determine one eligible local sender for this command.",
      next: "Inspect `cogcoin ids` and rerun the command with an explicit `--from` selector when supported.",
    };
  }

  if (classifiedAsBlockedMessage(errorCode)) {
    return {
      what: fallbackMessage,
      why: "The command was blocked by the current local wallet or service state.",
      next: "Review `cogcoin status` and retry after the blocking condition is cleared.",
    };
  }

  return null;
}

function classifiedAsBlockedMessage(errorCode: string): boolean {
  return isBlockedError(errorCode);
}

export function describeCanonicalCommand(parsed: ParsedCliArgs): string {
  const args = parsed.args;

  switch (parsed.command) {
    case "init":
    case "wallet-init":
      return "cogcoin init";
    case "restore":
    case "wallet-restore":
      return "cogcoin restore";
    case "wallet-delete":
      return "cogcoin wallet delete";
    case "wallet-show-mnemonic":
      return "cogcoin wallet show-mnemonic";
    case "unlock":
    case "wallet-unlock":
      return "cogcoin unlock";
    case "reset":
      return "cogcoin reset";
    case "repair":
      return "cogcoin repair";
    case "wallet-lock":
      return "cogcoin wallet lock";
    case "anchor":
    case "domain-anchor":
      return `cogcoin anchor ${args[0] ?? "<domain>"}`;
    case "anchor-clear":
    case "domain-anchor-clear":
      return `cogcoin anchor clear ${args[0] ?? "<domain>"}`;
    case "register":
    case "domain-register":
      return `cogcoin register ${args[0] ?? "<domain>"}`;
    case "transfer":
    case "domain-transfer":
      return `cogcoin transfer ${args[0] ?? "<domain>"}`;
    case "sell":
    case "domain-sell":
      return `cogcoin sell ${args[0] ?? "<domain>"} ${args[1] ?? "<price>"}`;
    case "unsell":
    case "domain-unsell":
      return `cogcoin unsell ${args[0] ?? "<domain>"}`;
    case "buy":
    case "domain-buy":
      return `cogcoin buy ${args[0] ?? "<domain>"}`;
    case "send":
    case "cog-send":
      return `cogcoin send ${args[0] ?? "<amount>"}`;
    case "claim":
    case "cog-claim":
      return `cogcoin claim ${args[0] ?? "<lock-id>"}`;
    case "reclaim":
    case "cog-reclaim":
      return `cogcoin reclaim ${args[0] ?? "<lock-id>"}`;
    case "cog-lock":
      return `cogcoin cog lock ${args[0] ?? "<amount>"}`;
    case "domain-endpoint-set":
      return `cogcoin domain endpoint set ${args[0] ?? "<domain>"}`;
    case "domain-endpoint-clear":
      return `cogcoin domain endpoint clear ${args[0] ?? "<domain>"}`;
    case "domain-delegate-set":
      return `cogcoin domain delegate set ${args[0] ?? "<domain>"} ${args[1] ?? "<btc-target>"}`;
    case "domain-delegate-clear":
      return `cogcoin domain delegate clear ${args[0] ?? "<domain>"}`;
    case "domain-miner-set":
      return `cogcoin domain miner set ${args[0] ?? "<domain>"} ${args[1] ?? "<btc-target>"}`;
    case "domain-miner-clear":
      return `cogcoin domain miner clear ${args[0] ?? "<domain>"}`;
    case "domain-canonical":
      return `cogcoin domain canonical ${args[0] ?? "<domain>"}`;
    case "field-create":
      return `cogcoin field create ${args[0] ?? "<domain>"} ${args[1] ?? "<field>"}`;
    case "field-set":
      return `cogcoin field set ${args[0] ?? "<domain>"} ${args[1] ?? "<field>"}`;
    case "field-clear":
      return `cogcoin field clear ${args[0] ?? "<domain>"} ${args[1] ?? "<field>"}`;
    case "rep-give":
      return `cogcoin rep give ${args[0] ?? "<source-domain>"} ${args[1] ?? "<target-domain>"} ${args[2] ?? "<amount>"}`;
    case "rep-revoke":
      return `cogcoin rep revoke ${args[0] ?? "<source-domain>"} ${args[1] ?? "<target-domain>"} ${args[2] ?? "<amount>"}`;
    case "wallet-address":
    case "address":
      return "cogcoin address";
    case "wallet-ids":
    case "ids":
      return "cogcoin ids";
    case "wallet-status":
      return "cogcoin wallet status";
    case "hooks-mining-status":
      return `cogcoin hooks status${parsed.verify ? " --verify" : ""}`;
    case "hooks-mining-enable":
      return "cogcoin hooks enable mining";
    case "hooks-mining-disable":
      return "cogcoin hooks disable mining";
    case "mine-setup":
      return "cogcoin mine setup";
    case "mine-start":
      return "cogcoin mine start";
    case "mine-stop":
      return "cogcoin mine stop";
    case "mine-status":
      return "cogcoin mine status";
    case "mine-log":
      return `cogcoin mine log${parsed.follow ? " --follow" : ""}`;
    case "cog-balance":
    case "balance":
      return "cogcoin balance";
    case "cog-locks":
    case "locks":
      return "cogcoin locks";
    case "field-list":
    case "fields":
      return `cogcoin fields ${args[0] ?? "<domain>"}`;
    case "field-show":
    case "field":
      return `cogcoin field ${args[0] ?? "<domain>"} ${args[1] ?? "<field>"}`;
    case "domain-show":
    case "show":
      return `cogcoin show ${args[0] ?? "<domain>"}`;
    case "status":
      return "cogcoin status";
    case "domain-list":
    case "domains":
      return "cogcoin domains";
    default:
      return parsed.command === null ? "cogcoin" : `cogcoin ${parsed.command.replaceAll("-", " ")}`;
  }
}

export function inferOutputMode(argv: readonly string[]): OutputMode {
  const index = argv.lastIndexOf("--output");

  if (index === -1) {
    return "text";
  }

  const value = argv[index + 1];
  if (value === "json" || value === "preview-json") {
    return value;
  }

  return "text";
}

export function resolveStableJsonSchema(parsed: ParsedCliArgs): string | null {
  switch (parsed.command) {
    case "status":
      return "cogcoin/status/v1";
    case "bitcoin-start":
      return "cogcoin/bitcoin-start/v1";
    case "bitcoin-stop":
      return "cogcoin/bitcoin-stop/v1";
    case "bitcoin-status":
      return "cogcoin/bitcoin-status/v1";
    case "indexer-start":
      return "cogcoin/indexer-start/v1";
    case "indexer-stop":
      return "cogcoin/indexer-stop/v1";
    case "indexer-status":
      return "cogcoin/indexer-status/v1";
    case "wallet-address":
    case "address":
      return "cogcoin/address/v1";
    case "wallet-ids":
    case "ids":
      return "cogcoin/ids/v1";
    case "wallet-status":
      return "cogcoin/wallet-status/v1";
    case "hooks-mining-status":
      return "cogcoin/hooks-status/v1";
    case "mine-status":
      return "cogcoin/mine-status/v1";
    case "mine-log":
      return "cogcoin/mine-log/v1";
    case "balance":
    case "cog-balance":
      return "cogcoin/balance/v1";
    case "locks":
    case "cog-locks":
      return "cogcoin/locks/v1";
    case "domain-list":
    case "domains":
      return "cogcoin/domains/v1";
    case "domain-show":
    case "show":
      return "cogcoin/show/v1";
    case "fields":
    case "field-list":
      return "cogcoin/fields/v1";
    case "field":
    case "field-show":
      return "cogcoin/field/v1";
    default:
      return null;
  }
}

export function resolveStableMutationJsonSchema(parsed: ParsedCliArgs): string | null {
  switch (parsed.command) {
    case "init":
    case "wallet-init":
      return "cogcoin/init/v1";
    case "restore":
    case "wallet-restore":
      return "cogcoin/restore/v1";
    case "wallet-delete":
      return "cogcoin/wallet-delete/v1";
    case "unlock":
    case "wallet-unlock":
      return "cogcoin/unlock/v1";
    case "reset":
      return "cogcoin/reset/v1";
    case "wallet-export":
      return "cogcoin/wallet-export/v1";
    case "wallet-import":
      return "cogcoin/wallet-import/v1";
    case "wallet-lock":
      return "cogcoin/wallet-lock/v1";
    case "repair":
      return "cogcoin/repair/v1";
    case "anchor":
    case "domain-anchor":
      return "cogcoin/anchor/v1";
    case "anchor-clear":
    case "domain-anchor-clear":
      return "cogcoin/anchor-clear/v1";
    case "register":
    case "domain-register":
      return "cogcoin/register/v1";
    case "transfer":
    case "domain-transfer":
      return "cogcoin/transfer/v1";
    case "sell":
    case "domain-sell":
      return "cogcoin/sell/v1";
    case "unsell":
    case "domain-unsell":
      return "cogcoin/unsell/v1";
    case "buy":
    case "domain-buy":
      return "cogcoin/buy/v1";
    case "send":
    case "cog-send":
      return "cogcoin/send/v1";
    case "claim":
    case "cog-claim":
      return "cogcoin/claim/v1";
    case "reclaim":
    case "cog-reclaim":
      return "cogcoin/reclaim/v1";
    case "cog-lock":
      return "cogcoin/cog-lock/v1";
    case "domain-endpoint-set":
      return "cogcoin/domain-endpoint-set/v1";
    case "domain-endpoint-clear":
      return "cogcoin/domain-endpoint-clear/v1";
    case "domain-delegate-set":
      return "cogcoin/domain-delegate-set/v1";
    case "domain-delegate-clear":
      return "cogcoin/domain-delegate-clear/v1";
    case "domain-miner-set":
      return "cogcoin/domain-miner-set/v1";
    case "domain-miner-clear":
      return "cogcoin/domain-miner-clear/v1";
    case "domain-canonical":
      return "cogcoin/domain-canonical/v1";
    case "field-create":
      return "cogcoin/field-create/v1";
    case "field-set":
      return "cogcoin/field-set/v1";
    case "field-clear":
      return "cogcoin/field-clear/v1";
    case "rep-give":
      return "cogcoin/rep-give/v1";
    case "rep-revoke":
      return "cogcoin/rep-revoke/v1";
    default:
      return null;
  }
}

export function resolveStableMiningControlJsonSchema(parsed: ParsedCliArgs): string | null {
  switch (parsed.command) {
    case "hooks-mining-enable":
      return "cogcoin/hooks-enable-mining/v1";
    case "hooks-mining-disable":
      return "cogcoin/hooks-disable-mining/v1";
    case "mine-setup":
      return "cogcoin/mine-setup/v1";
    case "mine-start":
      return "cogcoin/mine-start/v1";
    case "mine-stop":
      return "cogcoin/mine-stop/v1";
    default:
      return null;
  }
}

export function resolvePreviewJsonSchema(parsed: ParsedCliArgs): string | null {
  const stableMutationSchema = resolveStableMutationJsonSchema(parsed);
  const stableMiningControlSchema = resolveStableMiningControlJsonSchema(parsed);

  switch (parsed.command) {
    case "wallet-lock":
    case "reset":
    case "repair":
    case "anchor":
    case "anchor-clear":
    case "domain-anchor":
    case "domain-anchor-clear":
    case "register":
    case "domain-register":
    case "transfer":
    case "domain-transfer":
    case "sell":
    case "domain-sell":
    case "unsell":
    case "domain-unsell":
    case "buy":
    case "domain-buy":
    case "send":
    case "cog-send":
    case "claim":
    case "cog-claim":
    case "reclaim":
    case "cog-reclaim":
    case "cog-lock":
    case "domain-endpoint-set":
    case "domain-endpoint-clear":
    case "domain-delegate-set":
    case "domain-delegate-clear":
    case "domain-miner-set":
    case "domain-miner-clear":
    case "domain-canonical":
    case "field-create":
    case "field-set":
    case "field-clear":
    case "rep-give":
    case "rep-revoke":
      return stableMutationSchema === null
        ? null
        : stableMutationSchema.replace(/^cogcoin\//, "cogcoin-preview/");
    case "hooks-mining-enable":
    case "hooks-mining-disable":
    case "mine-setup":
    case "mine-start":
    case "mine-stop":
      return stableMiningControlSchema === null
        ? null
        : stableMiningControlSchema.replace(/^cogcoin\//, "cogcoin-preview/");
    default:
      return null;
  }
}

function createSchemaProbe(command: CommandName | null): ParsedCliArgs {
  return {
    command,
    args: [],
    help: false,
    version: false,
    outputMode: "json",
    dbPath: null,
    dataDir: null,
    progressOutput: "auto",
    seedName: null,
    unlockFor: null,
    assumeYes: false,
    forceRace: false,
    anchorMessage: null,
    transferTarget: null,
    endpointText: null,
    endpointJson: null,
    endpointBytes: null,
    fieldPermanent: false,
    fieldFormat: null,
    fieldValue: null,
    fromIdentity: null,
    lockRecipientDomain: null,
    conditionHex: null,
    untilHeight: null,
    preimageHex: null,
    reviewText: null,
    locksClaimableOnly: false,
    locksReclaimableOnly: false,
    domainsAnchoredOnly: false,
    domainsListedOnly: false,
    domainsMineableOnly: false,
    listLimit: null,
    listAll: false,
    verify: false,
    follow: false,
  };
}

function isStableJsonCommand(command: CommandName | null): boolean {
  return resolveStableJsonSchema(createSchemaProbe(command)) !== null;
}

function isStableMutationJsonCommand(command: CommandName | null): boolean {
  return resolveStableMutationJsonSchema(createSchemaProbe(command)) !== null;
}

function isStableMiningControlJsonCommand(command: CommandName | null): boolean {
  return resolveStableMiningControlJsonSchema(createSchemaProbe(command)) !== null;
}

function isPreviewJsonCommand(command: CommandName | null): boolean {
  return resolvePreviewJsonSchema(createSchemaProbe(command)) !== null;
}

export function isJsonOutputSupportedCommand(command: CommandName | null): boolean {
  return isStableJsonCommand(command)
    || isStableMutationJsonCommand(command)
    || isStableMiningControlJsonCommand(command)
    || isPreviewJsonCommand(command);
}

export function isPreviewJsonOutputSupportedCommand(command: CommandName | null): boolean {
  return isPreviewJsonCommand(command);
}

export function createCommandJsonErrorEnvelope(
  parsed: ParsedCliArgs,
  error: unknown,
): StableJsonErrorEnvelope | MutationJsonErrorEnvelope | PreviewJsonErrorEnvelope {
  const classified = classifyCliError(error);
  const presentation = createCliErrorPresentation(classified.errorCode, classified.message);
  const humanMessage = presentation?.what ?? classified.message;
  const explanations = presentation?.why === null || presentation?.why === undefined ? [] : [presentation.why];
  const nextSteps = presentation?.next === null || presentation?.next === undefined ? [] : [presentation.next];
  const details = createCliErrorDetails(classified.errorCode, humanMessage, classified.message);
  const stableMutationSchema = resolveStableMutationJsonSchema(parsed);
  const stableMiningControlSchema = resolveStableMiningControlJsonSchema(parsed);
  const previewSchema = resolvePreviewJsonSchema(parsed);

  if (parsed.outputMode === "preview-json" && previewSchema !== null) {
    return createPreviewErrorEnvelope(
      previewSchema,
      describeCanonicalCommand(parsed),
      classified.errorCode,
      humanMessage,
      {
        explanations,
        nextSteps,
        details,
      },
    );
  }

  if (stableMutationSchema !== null) {
    return createMutationErrorEnvelope(
      stableMutationSchema,
      describeCanonicalCommand(parsed),
      classified.errorCode,
      humanMessage,
      {
        explanations,
        nextSteps,
        details,
      },
    );
  }

  if (stableMiningControlSchema !== null) {
    return createMutationErrorEnvelope(
      stableMiningControlSchema,
      describeCanonicalCommand(parsed),
      classified.errorCode,
      humanMessage,
      {
        explanations,
        nextSteps,
        details,
      },
    );
  }

  if (previewSchema !== null) {
    return createPreviewErrorEnvelope(
      previewSchema,
      describeCanonicalCommand(parsed),
      classified.errorCode,
      humanMessage,
      {
        explanations,
        nextSteps,
        details,
      },
    );
  }

  return createErrorEnvelope(
    resolveStableJsonSchema(parsed) ?? "cogcoin/cli/v1",
    describeCanonicalCommand(parsed),
    classified.errorCode,
    humanMessage,
    {
      explanations,
      nextSteps,
      details,
    },
  );
}

function createCliErrorDetails(
  errorCode: string,
  humanMessage: string,
  rawMessage: string,
): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  const initMatch = /^wallet_init_confirmation_failed_word_(\d+)$/.exec(errorCode);
  const hooksTemplateMatch = /^mining_hooks_enable_template_created:(.+)$/.exec(rawMessage);
  const hooksValidationMatch = /^mining_hooks_enable_validation_failed:(.+)$/.exec(rawMessage);

  if (initMatch !== null) {
    details.wordIndex = Number.parseInt(initMatch[1]!, 10);
  }

  if (hooksTemplateMatch !== null) {
    details.hookRootPath = hooksTemplateMatch[1]!;
  }

  if (hooksValidationMatch !== null) {
    details.validationError = hooksValidationMatch[1]!;
  }

  if (humanMessage !== rawMessage) {
    details.rawMessage = rawMessage;
  }

  return details;
}

export function writeHandledCliError(options: {
  parsed: ParsedCliArgs;
  stdout: WritableLike;
  stderr: WritableLike;
  error: unknown;
}): number {
  const classified = classifyCliError(options.error);

  if (isStructuredOutputMode(options.parsed.outputMode)) {
    writeJsonValue(options.stdout, createCommandJsonErrorEnvelope(options.parsed, options.error));
    return classified.exitCode;
  }

  const formatted = formatCliTextError(options.error);
  if (formatted !== null) {
    for (const line of formatted) {
      options.stderr.write(`${line}\n`);
    }
  } else {
    options.stderr.write(`${classified.message}\n`);
  }

  return classified.exitCode;
}
