import type { CliErrorPresentationRule } from "../types.js";

export const walletMutationErrorRules: readonly CliErrorPresentationRule[] = [
  ({ errorCode }) => {
    if (errorCode.endsWith("_sender_utxo_unavailable")) {
      return {
        what: "Sender identity has no spendable confirmed BTC input.",
        why: "This command preserves the Cogcoin sender identity in vin[0]. The selected sender currently has no confirmed spendable UTXO available for that role.",
        next: "Wait for the sender's BTC output to confirm, or fund that sender identity and retry.",
      };
    }

    if (errorCode.endsWith("_confirmation_rejected")) {
      return {
        what: "Confirmation was declined.",
        why: "The command requires explicit approval before it will publish a state-changing action.",
        next: "Rerun the command and confirm it. If this command uses a plain yes/no path, you can also add `--yes`.",
      };
    }

    if (errorCode === "wallet_anchor_invalid_message" || errorCode.startsWith("wallet_anchor_invalid_message_")) {
      const reason = errorCode.startsWith("wallet_anchor_invalid_message_")
        ? errorCode.slice("wallet_anchor_invalid_message_".length).trim()
        : null;
      return {
        what: "Founding message cannot be encoded in canonical Coglex.",
        why: reason === null || reason === ""
          ? "The supplied founding message could not be encoded into the canonical on-chain Coglex sentence format."
          : reason,
        next: "Retry with a different founding message, or rerun `cogcoin anchor <domain>` without `--message` to skip it.",
      };
    }

    if (errorCode === "wallet_secret_provider_linux_runtime_error") {
      return {
        what: "Linux local wallet-secret access failed.",
        why: "Cogcoin could not read or write the local wallet secret file for this Linux account.",
        next: "Check that the Cogcoin state directory is readable and writable for this Linux user, then retry.",
      };
    }

    if (errorCode === "wallet_secret_provider_macos_runtime_error") {
      return {
        what: "macOS local wallet-secret access failed.",
        why: "Cogcoin could not read or write the password-protected local wallet secret file for this macOS account.",
        next: "Check that the Cogcoin state directory is readable and writable for this macOS user, then retry.",
      };
    }

    if (errorCode === "wallet_secret_provider_windows_runtime_error") {
      return {
        what: "Windows local wallet-secret access failed.",
        why: "Cogcoin could not read or write the local wallet secret file for this Windows account.",
        next: "Check that the Cogcoin state directory is readable and writable for this Windows user, then retry.",
      };
    }

    if (errorCode === "wallet_bitcoin_transfer_insufficient_funds") {
      return {
        what: "Wallet address does not have enough BTC.",
        why: "The requested satoshi amount plus the mining fee exceeds the wallet's spendable BTC balance.",
        next: "Reduce the amount or add more BTC to the wallet address, then retry.",
      };
    }

    if (errorCode.includes("insufficient")) {
      return {
        what: "Available funds are insufficient.",
        why: "The wallet address does not currently have enough spendable funds for this operation.",
        next: "Add more funds to the wallet address, then retry.",
      };
    }

    if (errorCode === "wallet_register_from_not_supported_for_subdomain") {
      return {
        what: "`--from` is not supported for subdomain registration.",
        why: "Cogcoin now uses a single wallet address for local writes, so sender overrides are no longer part of subdomain registration.",
        next: "Retry without `--from`.",
      };
    }

    if (errorCode === "wallet_register_sender_not_root_eligible") {
      return {
        what: "Root registration sender is not eligible.",
        why: "Root registration now always uses the wallet address, and the local wallet state did not produce a usable sender.",
        next: "Inspect `cogcoin address` and retry.",
      };
    }

    if (errorCode === "wallet_register_sender_not_found") {
      return {
        what: "Local sender was not found.",
        why: "The wallet could not resolve a usable local wallet sender for this command.",
        next: "Inspect `cogcoin address` and retry.",
      };
    }

    if (errorCode === "wallet_register_sender_read_only") {
      return {
        what: "Wallet sender is not spendable.",
        why: "This command needs the wallet address to author the transaction, but the local wallet sender is not spendable.",
        next: "Check `cogcoin address`, restore the spendable wallet, and retry.",
      };
    }

    if (errorCode === "wallet_register_sender_address_unavailable") {
      return {
        what: "Wallet address is unavailable.",
        why: "The local wallet sender was resolved, but the wallet does not currently have a usable display address for it.",
        next: "Inspect `cogcoin address` and retry.",
      };
    }

    if (errorCode === "wallet_buy_sender_not_found") {
      return {
        what: "Local buyer was not found.",
        why: "The wallet could not resolve a usable local wallet sender for this purchase.",
        next: "Inspect `cogcoin address` and retry.",
      };
    }

    if (errorCode === "wallet_buy_sender_read_only") {
      return {
        what: "Wallet sender is not spendable.",
        why: "Buying now always uses the wallet address, but the local wallet sender is not spendable.",
        next: "Check `cogcoin address`, restore the spendable wallet, and retry.",
      };
    }

    if (errorCode === "wallet_buy_sender_address_unavailable") {
      return {
        what: "Wallet address is unavailable.",
        why: "The wallet could not produce a usable display address for the local sender.",
        next: "Inspect `cogcoin address` and retry.",
      };
    }

    if (errorCode === "wallet_buy_already_owner") {
      return {
        what: "The wallet already owns the domain.",
        why: "A buy mutation cannot target a domain already owned by this wallet address.",
        next: "Inspect the current owner with `cogcoin show <domain>` and choose a different domain.",
      };
    }

    if (errorCode === "wallet_buy_insufficient_cog_balance") {
      return {
        what: "The wallet does not have enough COG.",
        why: "The wallet address does not currently have the listed domain price available in spendable COG balance.",
        next: "Add more COG to the wallet address, then retry.",
      };
    }

    if (errorCode === "wallet_transfer_owner_not_locally_controlled" || errorCode === "wallet_sell_owner_not_locally_controlled") {
      return {
        what: "Domain owner is not locally controlled.",
        why: "This command must be authored by the current unanchored domain owner, and that current owner script/address is not controlled by this wallet.",
        next: "Inspect the current owner with `cogcoin show <domain>`, then retry from the wallet that controls the owner.",
      };
    }

    if (errorCode === "wallet_transfer_owner_read_only" || errorCode === "wallet_sell_owner_read_only") {
      return {
        what: "Domain owner is not spendable in this wallet.",
        why: "The current domain owner is visible locally, but this wallet cannot author owner mutations from it.",
        next: "Use the wallet that controls the owner, or import the spendable owner into this wallet before retrying.",
      };
    }

    if (
      errorCode === "wallet_field_create_owner_not_locally_controlled"
      || errorCode === "wallet_field_set_owner_not_locally_controlled"
      || errorCode === "wallet_field_clear_owner_not_locally_controlled"
    ) {
      return {
        what: "Anchored field owner is not locally controlled.",
        why: "Field mutations must be authored by the current anchored owner of the domain, and that current owner script/address is not controlled by this wallet.",
        next: "Inspect the current owner with `cogcoin show <domain>`, then retry from the wallet that controls the owner.",
      };
    }

    if (
      errorCode === "wallet_field_create_owner_read_only"
      || errorCode === "wallet_field_set_owner_read_only"
      || errorCode === "wallet_field_clear_owner_read_only"
    ) {
      return {
        what: "Anchored field owner is not spendable in this wallet.",
        why: "The current anchored owner is visible locally, but this wallet cannot author field mutations from it.",
        next: "Use the wallet that controls the owner, or import the spendable owner into this wallet before retrying.",
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
        why: "This anchored domain-admin command must be authored by the current anchored owner, and that current owner script/address is not controlled by this wallet.",
        next: "Inspect the current owner with `cogcoin show <domain>`, then retry from the wallet that controls the owner.",
      };
    }

    if (
      errorCode === "wallet_domain_endpoint_owner_read_only"
      || errorCode === "wallet_domain_delegate_owner_read_only"
      || errorCode === "wallet_domain_miner_owner_read_only"
      || errorCode === "wallet_domain_canonical_owner_read_only"
    ) {
      return {
        what: "Anchored domain owner is not spendable in this wallet.",
        why: "The current anchored owner is visible locally, but this wallet cannot author anchored admin mutations from it.",
        next: "Use the wallet that controls the owner, or import the spendable owner into this wallet before retrying.",
      };
    }

    if (
      errorCode === "wallet_rep_give_source_owner_not_locally_controlled"
      || errorCode === "wallet_rep_revoke_source_owner_not_locally_controlled"
    ) {
      return {
        what: "Anchored reputation source owner is not locally controlled.",
        why: "Reputation mutations must be authored by the current anchored owner of the source domain, and that current owner script/address is not controlled by this wallet.",
        next: "Inspect the current source-domain owner with `cogcoin show <domain>`, then retry from the wallet that controls the owner.",
      };
    }

    if (
      errorCode === "wallet_rep_give_source_owner_read_only"
      || errorCode === "wallet_rep_revoke_source_owner_read_only"
    ) {
      return {
        what: "Anchored reputation source owner is not spendable in this wallet.",
        why: "The current anchored source-domain owner is visible locally, but this wallet cannot author reputation mutations from it.",
        next: "Use the wallet that controls the owner, or import the spendable owner into this wallet before retrying.",
      };
    }

    if (errorCode === "wallet_send_sender_address_unavailable" || errorCode === "wallet_lock_sender_address_unavailable") {
      return {
        what: "Wallet address is unavailable.",
        why: "The wallet could not produce a usable display address for the local sender.",
        next: "Inspect `cogcoin address` and retry.",
      };
    }

    if (errorCode === "wallet_bitcoin_transfer_invalid_amount") {
      return {
        what: "Bitcoin transfer amount is invalid.",
        why: "This command accepts only a positive whole-number satoshi amount such as `1200`.",
        next: "Rerun `cogcoin bitcoin transfer <sats> --to <address>` with a positive integer satoshi amount.",
      };
    }

    if (errorCode === "wallet_bitcoin_transfer_invalid_address") {
      return {
        what: "Bitcoin transfer recipient address is invalid.",
        why: "This command only accepts a standard mainnet BTC address in `--to`.",
        next: "Rerun `cogcoin bitcoin transfer <sats> --to <address>` with a valid mainnet BTC address.",
      };
    }

    if (errorCode === "wallet_bitcoin_transfer_address_required") {
      return {
        what: "Bitcoin transfer recipient must be a standard BTC address.",
        why: "V1 of this command does not support opaque script targets such as `spk:<hex>`.",
        next: "Rerun `cogcoin bitcoin transfer <sats> --to <address>` with a standard mainnet BTC address.",
      };
    }

    if (errorCode === "wallet_bitcoin_transfer_self_transfer") {
      return {
        what: "Bitcoin transfer recipient matches the wallet address.",
        why: "This command rejects self-transfers to the wallet funding script/address.",
        next: "Choose a different recipient address and retry.",
      };
    }

    if (errorCode === "wallet_bitcoin_transfer_confirmation_rejected") {
      return {
        what: "Bitcoin transfer confirmation was rejected.",
        why: "The interactive confirmation was declined before the BTC payment was broadcast.",
        next: "Review the recipient address and amount, then rerun the command if you still want to send BTC.",
      };
    }

    if (errorCode === "wallet_bitcoin_transfer_requires_tty") {
      return {
        what: "Bitcoin transfer confirmation needs an interactive terminal.",
        why: "Without `--yes`, Cogcoin must ask for an interactive confirmation before publishing a BTC payment.",
        next: "Rerun the command in an interactive terminal, or add `--yes` if that is appropriate for your workflow.",
      };
    }

    if (errorCode === "wallet_claim_sender_not_local") {
      return {
        what: "The claim sender is not locally controlled.",
        why: "Before timeout, the wallet may only claim as the current recipient-domain owner, and that owner is not available in this wallet.",
        next: "Check the current recipient-domain owner with `cogcoin show <domain>` or use the wallet that controls the owner.",
      };
    }

    if (errorCode === "wallet_reclaim_sender_not_local") {
      return {
        what: "The reclaim sender is not locally controlled.",
        why: "After timeout, the wallet may only reclaim as the original locker, and that locker is not controlled by this wallet.",
        next: "Use the wallet that controls the original locker, or inspect the lock details with `cogcoin locks`.",
      };
    }

    if (errorCode.includes("ambiguous_sender") || errorCode.includes("no_eligible_sender")) {
      return {
        what: "Sender selection could not be resolved.",
        why: "The wallet could not determine a usable local sender for this command.",
        next: "Inspect `cogcoin address` and `cogcoin status`, then retry.",
      };
    }

    return null;
  },
];
