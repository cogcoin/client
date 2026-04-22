import { FileLockBusyError } from "../../wallet/fs/lock.js";
import type { CliErrorClassification } from "./types.js";

export function classifyCliError(error: unknown): CliErrorClassification {
  const message = error instanceof Error ? error.message : String(error);

  if (message.startsWith("cli_")) {
    return { exitCode: 2, errorCode: message, message };
  }

  if (/^wallet_init_confirmation_failed_word_\d+$/.test(message)) {
    return { exitCode: 2, errorCode: message, message };
  }

  if (
    message === "mining_setup_invalid_provider"
    || message === "mining_setup_missing_api_key"
    || message === "mining_setup_missing_model_id"
    || message === "mining_setup_canceled"
  ) {
    return { exitCode: 2, errorCode: message, message };
  }

  if (message.endsWith("_typed_ack_required")) {
    return { exitCode: 2, errorCode: message, message };
  }

  if (
    message === "wallet_typed_confirmation_rejected"
    || message === "wallet_delete_confirmation_required"
    || message === "wallet_prompt_value_required"
    || message === "wallet_restore_mnemonic_invalid"
    || message === "wallet_restore_replace_confirmation_required"
    || message === "wallet_seed_name_invalid"
    || message === "wallet_seed_name_reserved"
    || message === "reset_wallet_choice_invalid"
  ) {
    return { exitCode: 2, errorCode: message, message };
  }

  if (message === "not_found") {
    return { exitCode: 3, errorCode: "not_found", message: "Requested object not found." };
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

export function isBlockedError(message: string): boolean {
  if (
    message === "wallet_control_lock_busy"
    || message.startsWith("file_lock_busy_")
  ) {
    return true;
  }

  if (
    message === "wallet_uninitialized"
    || message === "local-state-corrupt"
    || message === "wallet_already_initialized"
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
    || message === "mine_prompt_requires_tty"
    || message === "mine_prompt_domain_not_mineable"
    || message === "mining_preemption_timeout"
    || message === "wallet_client_password_setup_required"
    || message === "wallet_client_password_migration_required"
    || message === "wallet_client_password_locked"
    || message === "wallet_secret_provider_linux_runtime_error"
    || message === "wallet_secret_provider_macos_runtime_error"
    || message === "wallet_secret_provider_windows_runtime_error"
    || message === "wallet_state_legacy_envelope_unsupported"
  ) {
    return true;
  }

  return /(?:^|_)(?:locked|uninitialized|repair_required|requires_tty|typed_ack_required|confirmation_rejected|tip_mismatch|core_replica_not_ready|setup|no_eligible_sender|ambiguous_sender|insufficient|stale|paused|validation|catching_up|starting|unavailable|schema_mismatch|service_version_mismatch|wallet_root_mismatch|runtime_mismatch|replica_missing|replica_mismatch|failed)(?:_|$)/.test(message)
    || /repair-required/.test(message);
}

export function describeBusyLock(
  errorCode: string,
  error?: unknown,
): {
  lockPath: string;
  lockPurpose: string | null;
} | null {
  if (!errorCode.startsWith("file_lock_busy_")) {
    return null;
  }

  return {
    lockPath: errorCode.slice("file_lock_busy_".length),
    lockPurpose: error instanceof FileLockBusyError
      ? error.existingMetadata?.purpose ?? null
      : null,
  };
}
