import type { CliErrorPresentationRule } from "../types.js";

export const miningAndUpdateErrorRules: readonly CliErrorPresentationRule[] = [
  ({ errorCode }) => {
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

    if (errorCode === "mining_setup_missing_model_id") {
      return {
        what: "Mining model ID is required.",
        why: "Built-in mining setup cannot save a custom mining model choice unless it has a non-empty model ID.",
        next: "Rerun `cogcoin mine setup`, choose `Custom model ID...`, and enter the model ID when prompted.",
      };
    }

    if (errorCode === "mining_setup_canceled") {
      return {
        what: "Mining setup was canceled.",
        why: "The interactive mining-model selection was canceled before any provider configuration was saved.",
        next: "Rerun `cogcoin mine setup` when you are ready to choose a provider model.",
      };
    }

    if (errorCode === "mine_prompt_domain_not_mineable") {
      return {
        what: "A new mining prompt override can only target a mineable anchored root domain.",
        why: "Cogcoin only creates new domain prompt overrides for locally controlled anchored root domains that are currently mineable. Existing stored prompt entries can still be edited or cleared by name even when they are dormant.",
        next: "Run `cogcoin domains --mineable` to see eligible domains, or rerun `cogcoin mine prompt <domain>` for an existing stored prompt entry.",
      };
    }

    if (errorCode === "cli_update_requires_tty") {
      return {
        what: "Updating Cogcoin needs an interactive terminal or `--yes`.",
        why: "When a newer client release is available, `cogcoin update` prompts before running the global npm install unless `--yes` is provided.",
        next: "Rerun `cogcoin update` in an interactive terminal, or add `--yes` to apply the update non-interactively.",
      };
    }

    if (errorCode === "cli_update_registry_unavailable") {
      return {
        what: "Cogcoin could not read the latest client version from the npm registry.",
        why: "The explicit update command requires a fresh registry lookup before it can compare versions or run the install.",
        next: "Check network access and rerun `cogcoin update`.",
      };
    }

    if (errorCode === "cli_update_npm_not_found") {
      return {
        what: "Cogcoin could not find npm to install the update.",
        why: "The update command runs `npm install -g @cogcoin/client`, and no usable `npm` executable was available on PATH.",
        next: "Install Node.js/npm or fix PATH, then rerun `cogcoin update`.",
      };
    }

    if (errorCode === "cli_update_install_failed") {
      return {
        what: "Cogcoin update installation failed.",
        why: "The global npm install exited unsuccessfully before the client update completed.",
        next: "Review the npm output above, fix the installation issue, then rerun `cogcoin update`.",
      };
    }

    return null;
  },
];
