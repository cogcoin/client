import { describeBusyLock } from "../classify.js";
import type { CliErrorPresentationRule } from "../types.js";

export const walletAdminErrorRules: readonly CliErrorPresentationRule[] = [
  ({ errorCode, error }) => {
    if (errorCode === "wallet_control_lock_busy") {
      return {
        what: "Another Cogcoin command is already controlling this wallet.",
        why: "Commands that sync, follow, or mutate the local index take an exclusive wallet control lock so they do not write the same sqlite store concurrently.",
        next: "Run `cogcoin repair` to reset the local lock state, then retry.",
      };
    }

    const busyLock = describeBusyLock(errorCode, error);
    if (busyLock === null) {
      return null;
    }

    if (busyLock.lockPath.includes("wallet-control.lock")) {
      return {
        what: busyLock.lockPurpose === null
          ? "Wallet control lock is busy."
          : `Wallet control lock is busy (purpose: ${busyLock.lockPurpose}).`,
        why: "Another Cogcoin command currently holds the exclusive wallet control lock for this wallet.",
        next: "Run `cogcoin repair` to reset the local lock state, then retry.",
      };
    }

    return {
      what: busyLock.lockPurpose === null
        ? `Lock file is busy: ${busyLock.lockPath}.`
        : `Lock file is busy: ${busyLock.lockPath} (purpose: ${busyLock.lockPurpose}).`,
      why: "The command was blocked by the current local wallet or service state.",
      next: "Run `cogcoin repair` to reset the local lock state, then retry.",
    };
  },
  ({ errorCode }) => {
    if (errorCode === "reset_wallet_choice_invalid") {
      return {
        what: "Wallet reset choice is invalid.",
        why: "This reset path accepts only Enter for the default entropy-retaining reset, \"skip\", or \"clear wallet entropy\".",
        next: "Rerun `cogcoin reset` and enter one of the accepted wallet reset choices.",
      };
    }

    if (errorCode === "reset_wallet_entropy_reset_unavailable") {
      return {
        what: "Entropy-retaining wallet reset is unavailable.",
        why: "Cogcoin found wallet state, but it could not safely load and reconstruct it into a fresh wallet while preserving only the mnemonic-derived continuity data.",
        next: "Rerun `cogcoin reset` and choose \"skip\" to keep the wallet unchanged, or type \"clear wallet entropy\" to erase it fully.",
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
        what: "Reset finished the filesystem wipe but could not fully clean up wallet secret-provider material.",
        why: "The local Cogcoin files were already removed or rewritten, but at least one tracked wallet secret could not be deleted cleanly.",
        next: "Remove the remaining wallet secret material, then rerun `cogcoin status` to confirm the new state.",
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
        next: "Run `cogcoin status` to inspect the existing wallet.",
      };
    }

    if (errorCode === "wallet_client_password_setup_required") {
      return {
        what: "Client password setup is still required.",
        why: "This machine has not finished configuring password-protected local wallet secrets yet.",
        next: "Run `cogcoin init` to create the client password and finish local secret setup.",
      };
    }

    if (errorCode === "wallet_client_password_migration_required") {
      return {
        what: "Client password migration is still required.",
        why: "This machine still has wallet secrets in the older platform-specific local format, so Cogcoin will not use them until they are migrated into password-protected local files.",
        next: "Run `cogcoin init` to create the client password and migrate local wallet secrets.",
      };
    }

    if (errorCode === "wallet_client_password_locked") {
      return {
        what: "Client password is locked.",
        why: "This command needs the password-protected local wallet secret, but this process does not currently hold an unlocked client-password session.",
        next: "Rerun the command in an interactive terminal so Cogcoin can prompt for the client password. Separate CLI invocations no longer share unlocked state.",
      };
    }

    if (errorCode === "wallet_client_password_change_requires_tty") {
      return {
        what: "Client password change needs an interactive terminal.",
        why: "Cogcoin has to securely prompt for the current client password and the new password twice before it can rotate local wallet-secret protection.",
        next: "Run `cogcoin client change-password` in an interactive terminal.",
      };
    }

    if (errorCode === "wallet_restore_requires_main_wallet") {
      return {
        what: "Legacy multi-seed restore is no longer available.",
        why: "Cogcoin no longer supports restoring into named imported wallet slots.",
        next: "Run `cogcoin init` and choose \"Restore existing wallet\".",
      };
    }

    if (errorCode === "wallet_seed_name_exists") {
      return {
        what: "Legacy multi-seed state is still present.",
        why: "This machine still has old named-wallet artifacts from the removed multi-seed model.",
        next: "Run `cogcoin reset`, choose \"clear wallet entropy\", then rerun `cogcoin init`.",
      };
    }

    if (errorCode === "wallet_seed_not_found") {
      return {
        what: "Legacy named-wallet state was not found.",
        why: "Cogcoin no longer supports selecting named local wallet seeds.",
        next: "Use the single current wallet, or run `cogcoin reset` and `cogcoin init` to replace it.",
      };
    }

    if (errorCode === "wallet_seed_index_invalid") {
      return {
        what: "Legacy wallet-seed registry is invalid.",
        why: "Cogcoin found old multi-seed metadata from a removed feature and could not trust it for cleanup decisions.",
        next: "Run `cogcoin repair`, or reset the wallet state if you intend to replace the local wallet.",
      };
    }

    if (errorCode === "wallet_delete_main_not_supported") {
      return {
        what: "`wallet delete` is no longer available.",
        why: "Cogcoin no longer supports deleting named imported wallets because the client now has a single local wallet model.",
        next: "Run `cogcoin reset`, choose \"clear wallet entropy\", then rerun `cogcoin init`.",
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
        next: "Rerun `cogcoin init`, choose \"Restore existing wallet\", and enter the 24 recovery words in the original order.",
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
        what: "Named wallet seeds were removed.",
        why: "Cogcoin no longer accepts named local wallet seeds because the client now uses a single wallet model.",
        next: "Run `cogcoin init` for setup, or reset the wallet first if you need to replace it.",
      };
    }

    if (errorCode === "wallet_prompt_value_required") {
      return {
        what: "Required input was not provided.",
        why: "This secure admin command needs a non-empty terminal response before it can continue safely.",
        next: "Rerun the command in an interactive terminal and enter the requested value.",
      };
    }

    if (errorCode === "wallet_state_legacy_envelope_unsupported") {
      return {
        what: "Legacy wallet state is no longer supported.",
        why: "This wallet state was created by an older Cogcoin format that this version no longer loads directly.",
        next: "Restore or otherwise recover the wallet into the current format, then retry the command.",
      };
    }

    return null;
  },
];
