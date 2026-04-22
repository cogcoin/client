import type { CliErrorPresentationRule } from "../types.js";

export const cliSurfaceErrorRules: readonly CliErrorPresentationRule[] = [
  ({ errorCode }) => {
    if (errorCode === "cli_client_unlock_removed") {
      return {
        what: "`client unlock` was removed.",
        why: "Cogcoin no longer shares unlocked client-password sessions across separate CLI commands.",
        next: "Rerun password-aware commands in an interactive terminal so Cogcoin can prompt for the client password when needed.",
      };
    }

    if (errorCode === "cli_client_lock_removed") {
      return {
        what: "`client lock` was removed.",
        why: "Cogcoin no longer keeps reusable unlocked client-password sessions after a command exits.",
        next: "Fresh CLI invocations start locked automatically and prompt when wallet-local secrets are needed.",
      };
    }

    if (errorCode === "cli_restore_removed" || errorCode === "cli_wallet_restore_removed") {
      return {
        what: "Standalone restore commands were removed.",
        why: "Cogcoin now uses `cogcoin init` as the single wallet setup entrypoint for both new and restored wallets.",
        next: "Run `cogcoin init` and choose \"Restore existing wallet\".",
      };
    }

    if (errorCode === "cli_wallet_delete_removed") {
      return {
        what: "`wallet delete` was removed.",
        why: "Cogcoin no longer supports multiple local wallet seeds, so replacing the wallet now flows through reset and init.",
        next: "Run `cogcoin reset`, choose \"clear wallet entropy\", then rerun `cogcoin init`.",
      };
    }

    if (errorCode === "cli_seed_removed") {
      return {
        what: "`--seed` was removed.",
        why: "Cogcoin now supports only a single local wallet instead of multiple named wallet seeds.",
        next: "Use the current wallet directly, or run `cogcoin reset`, choose \"clear wallet entropy\", then rerun `cogcoin init` to import a different wallet.",
      };
    }

    if (errorCode === "cli_missing_seed_name") {
      return {
        what: "Named wallet seeds were removed.",
        why: "This version of Cogcoin no longer supports `--seed`.",
        next: "Drop `--seed` and retry, or use reset plus init if you need to replace the wallet.",
      };
    }

    if (errorCode === "cli_seed_not_supported_for_command" || errorCode === "wallet_init_seed_not_supported") {
      return {
        what: "Named wallet seeds were removed.",
        why: "Cogcoin now operates on a single local wallet instead of multiple named wallet seeds.",
        next: "Drop `--seed` and retry.",
      };
    }

    if (errorCode === "cli_from_not_supported_for_command") {
      return {
        what: "`--from` is no longer supported.",
        why: "Cogcoin now uses a single wallet address for local transaction authorship, so sender selection is no longer part of the CLI.",
        next: "Retry the command without `--from`.",
      };
    }

    if (errorCode === "cli_missing_satvb") {
      return {
        what: "A sat/vB value is required.",
        why: "`--satvb` needs an explicit positive fee rate value in sat/vB for the mutation you are submitting.",
        next: "Rerun the command with `--satvb <number>`.",
      };
    }

    if (errorCode === "cli_invalid_satvb") {
      return {
        what: "The sat/vB value is invalid.",
        why: "`--satvb` accepts only a positive finite decimal number such as `12` or `12.5`.",
        next: "Choose a positive sat/vB value and retry.",
      };
    }

    if (errorCode === "cli_satvb_not_supported_for_command") {
      return {
        what: "This command does not support `--satvb`.",
        why: "The fee-rate override only applies to wallet mutation commands that build and broadcast transactions.",
        next: "Drop `--satvb` for this command, or use it with a wallet mutation command like `cogcoin register` or `cogcoin send`.",
      };
    }

    if (errorCode === "cli_anchor_clear_removed") {
      return {
        what: "`anchor clear` is no longer available.",
        why: "Anchor is now a direct single-transaction wallet mutation, so there is no separate cleanup command for reserved local workflow state.",
        next: "Retry with `cogcoin anchor <domain>` or inspect the domain with `cogcoin show <domain>`.",
      };
    }

    if (errorCode === "cli_wallet_export_removed") {
      return {
        what: "`wallet export` is no longer available.",
        why: "Portable encrypted wallet archives were removed from the client, so wallet state is no longer exported through a `.cogcoin` archive file.",
        next: "Use the wallet mnemonic as the supported recovery path, or retry with another wallet command.",
      };
    }

    if (errorCode === "cli_wallet_import_removed") {
      return {
        what: "`wallet import` is no longer available.",
        why: "Portable encrypted wallet archives were removed from the client, so this version no longer imports wallet state from archive files.",
        next: "Use `cogcoin init`, choose \"Restore existing wallet\", and enter the recovery mnemonic instead.",
      };
    }

    if (errorCode === "cli_field_create_initial_value_not_supported") {
      return {
        what: "`field create` no longer accepts an initial value.",
        why: "Field creation is now always a single FIELD_REG transaction. Any field value must be written afterward with a separate `field set` command.",
        next: "Create the field first, then run `cogcoin field set <domain> <field> ...`.",
      };
    }

    return null;
  },
];
