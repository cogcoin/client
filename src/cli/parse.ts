import type { CommandName, ParsedCliArgs, ProgressOutput } from "./types.js";
import {
  commandSupportsSatvb,
  commandSupportsYesFlag,
  getCommandHandlerFamily,
  renderHelpText,
  resolveCommandMatch,
  resolveUnknownCommandError,
} from "./command-registry.js";

export const HELP_TEXT = renderHelpText();

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  let command: CommandName | null = null;
  let commandFamily: ParsedCliArgs["commandFamily"] = null;
  let invokedCommandTokens: readonly string[] | null = null;
  let invokedCommandPath: string | null = null;
  const args: string[] = [];
  let help = false;
  let version = false;
  let dbPath: string | null = null;
  let dataDir: string | null = null;
  let progressOutput: ProgressOutput = "auto";
  let unlockFor: string | null = null;
  let assumeYes = false;
  let force = false;
  let forceRace = false;
  let anchorMessage: string | null = null;
  let transferTarget: string | null = null;
  let endpointText: string | null = null;
  let endpointJson: string | null = null;
  let endpointBytes: string | null = null;
  let fieldPermanent = false;
  let fieldFormat: string | null = null;
  let fieldValue: string | null = null;
  let lockRecipientDomain: string | null = null;
  let conditionHex: string | null = null;
  let untilHeight: string | null = null;
  let preimageHex: string | null = null;
  let reviewText: string | null = null;
  let satvb: number | null = null;
  let locksClaimableOnly = false;
  let locksReclaimableOnly = false;
  let domainsAnchoredOnly = false;
  let domainsListedOnly = false;
  let domainsMineableOnly = false;
  let listLimit: number | null = null;
  let listAll = false;
  let follow = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--help") {
      help = true;
      continue;
    }

    if (token === "--version") {
      version = true;
      continue;
    }

    if (token === "--db") {
      index += 1;
      dbPath = argv[index] ?? null;

      if (dbPath === null) {
        throw new Error("cli_missing_db_path");
      }

      continue;
    }

    if (token === "--seed") {
      throw new Error("cli_seed_removed");
    }

    if (token === "--data-dir") {
      index += 1;
      dataDir = argv[index] ?? null;

      if (dataDir === null) {
        throw new Error("cli_missing_data_dir");
      }

      continue;
    }

    if (token === "--progress") {
      index += 1;
      const value = argv[index] ?? null;

      if (value !== "auto" && value !== "tty" && value !== "none") {
        throw new Error("cli_invalid_progress_output");
      }

      progressOutput = value;
      continue;
    }

    if (token === "--for") {
      index += 1;
      unlockFor = argv[index] ?? null;

      if (unlockFor === null) {
        throw new Error("cli_missing_unlock_duration");
      }

      continue;
    }

    if (token === "--to") {
      index += 1;
      transferTarget = argv[index] ?? null;

      if (transferTarget === null) {
        throw new Error("cli_missing_transfer_target");
      }

      continue;
    }

    if (token === "--text") {
      index += 1;
      endpointText = argv[index] ?? null;

      if (endpointText === null) {
        throw new Error("cli_missing_endpoint_text");
      }

      continue;
    }

    if (token === "--json") {
      index += 1;
      endpointJson = argv[index] ?? null;

      if (endpointJson === null) {
        throw new Error("cli_missing_endpoint_json");
      }

      continue;
    }

    if (token === "--bytes") {
      index += 1;
      endpointBytes = argv[index] ?? null;

      if (endpointBytes === null) {
        throw new Error("cli_missing_endpoint_bytes");
      }

      continue;
    }

    if (token === "--permanent") {
      fieldPermanent = true;
      continue;
    }

    if (token === "--format") {
      index += 1;
      fieldFormat = argv[index] ?? null;

      if (fieldFormat === null) {
        throw new Error("cli_missing_field_format");
      }

      continue;
    }

    if (token === "--value") {
      index += 1;
      fieldValue = argv[index] ?? null;

      if (fieldValue === null) {
        throw new Error("cli_missing_field_value");
      }

      continue;
    }

    if (token === "--message") {
      index += 1;
      anchorMessage = argv[index] ?? null;

      if (anchorMessage === null) {
        throw new Error("cli_missing_anchor_message");
      }

      continue;
    }

    if (token === "--from") {
      throw new Error("cli_from_not_supported_for_command");
    }

    if (token === "--to-domain") {
      index += 1;
      lockRecipientDomain = argv[index] ?? null;

      if (lockRecipientDomain === null) {
        throw new Error("cli_missing_lock_domain");
      }

      continue;
    }

    if (token === "--condition") {
      index += 1;
      conditionHex = argv[index] ?? null;

      if (conditionHex === null) {
        throw new Error("cli_missing_lock_condition");
      }

      continue;
    }

    if (token === "--until-height") {
      index += 1;
      untilHeight = argv[index] ?? null;

      if (untilHeight === null) {
        throw new Error("cli_missing_until_height");
      }

      continue;
    }

    if (token === "--preimage") {
      index += 1;
      preimageHex = argv[index] ?? null;

      if (preimageHex === null) {
        throw new Error("cli_missing_claim_preimage");
      }

      continue;
    }

    if (token === "--review") {
      index += 1;
      reviewText = argv[index] ?? null;

      if (reviewText === null) {
        throw new Error("cli_missing_review_text");
      }

      continue;
    }

    if (token === "--satvb") {
      index += 1;
      const value = argv[index] ?? null;

      if (value === null || value.startsWith("--")) {
        throw new Error("cli_missing_satvb");
      }

      satvb = Number(value);

      if (!Number.isFinite(satvb) || satvb <= 0) {
        throw new Error("cli_invalid_satvb");
      }

      continue;
    }

    if (token === "--claimable") {
      locksClaimableOnly = true;
      continue;
    }

    if (token === "--reclaimable") {
      locksReclaimableOnly = true;
      continue;
    }

    if (token === "--anchored") {
      domainsAnchoredOnly = true;
      continue;
    }

    if (token === "--listed") {
      domainsListedOnly = true;
      continue;
    }

    if (token === "--mineable") {
      domainsMineableOnly = true;
      continue;
    }

    if (token === "--limit") {
      index += 1;
      const value = argv[index] ?? null;

      if (value === null || !/^[1-9]\d*$/.test(value)) {
        throw new Error("cli_invalid_limit");
      }

      listLimit = Number(value);

      if (listLimit < 1 || listLimit > 1000) {
        throw new Error("cli_invalid_limit");
      }

      continue;
    }

    if (token === "--all") {
      listAll = true;
      continue;
    }

    if (token === "--follow") {
      follow = true;
      continue;
    }

    if (token === "--yes") {
      assumeYes = true;
      continue;
    }

    if (token === "--force") {
      force = true;
      continue;
    }

    if (token === "--force-race") {
      forceRace = true;
      continue;
    }

    if (token?.startsWith("--")) {
      throw new Error(`cli_unknown_flag_${token.slice(2)}`);
    }

    if (command === null) {
      const match = resolveCommandMatch(argv, index);

      if (match === null) {
        throw new Error(resolveUnknownCommandError(argv, index));
      }

      command = match.command;
      commandFamily = getCommandHandlerFamily(match.command);
      invokedCommandTokens = [...match.invokedTokens];
      invokedCommandPath = match.invokedTokens.join(" ");
      index += match.consumedTokens - 1;
      continue;
    }

    args.push(token);
  }

  if (
    (command === "status"
      || command === "update"
      || command === "bitcoin-start"
      || command === "bitcoin-stop"
      || command === "bitcoin-status"
      || command === "indexer-start"
      || command === "indexer-stop"
      || command === "indexer-status"
      || command === "init"
      || command === "reset"
      || command === "wallet-status"
      || command === "repair"
      || command === "sync"
      || command === "follow"
      || command === "mine"
      || command === "mine-setup"
      || command === "mine-prompt-list"
      || command === "mine-status"
      || command === "mine-log"
      || command === "address"
      || command === "ids"
      || command === "balance"
      || command === "locks"
      || command === "domains")
    && args.length !== 0
  ) {
    throw new Error(`cli_unexpected_argument_${args[0]}`);
  }

  if (command === "register" && args.length !== 1) {
    throw new Error("cli_missing_domain_argument");
  }

  if (command === "anchor" && args.length !== 1) {
    throw new Error("cli_missing_domain_argument");
  }

  if (command === "mine-prompt" && args.length !== 1) {
    throw new Error("cli_missing_domain_argument");
  }

  if (
    (command === "domain-endpoint-set"
      || command === "domain-endpoint-clear"
      || command === "domain-delegate-clear"
      || command === "domain-miner-clear"
      || command === "domain-canonical")
    && args.length !== 1
  ) {
    throw new Error("cli_missing_domain_argument");
  }

  if (command === "domain-delegate-set" && args.length !== 2) {
    throw new Error("cli_missing_delegate_arguments");
  }

  if (command === "domain-miner-set" && args.length !== 2) {
    throw new Error("cli_missing_miner_arguments");
  }

  if (command === "transfer" && args.length !== 1) {
    throw new Error("cli_missing_domain_argument");
  }

  if (command === "sell" && args.length !== 2) {
    throw new Error("cli_missing_sell_arguments");
  }

  if ((command === "unsell" || command === "buy") && args.length !== 1) {
    throw new Error("cli_missing_domain_argument");
  }

  if ((command === "send" || command === "cog-lock" || command === "bitcoin-transfer") && args.length !== 1) {
    throw new Error("cli_missing_amount_argument");
  }

  if ((command === "claim" || command === "reclaim") && args.length !== 1) {
    throw new Error("cli_missing_lock_argument");
  }

  if ((command === "rep-give" || command === "rep-revoke") && args.length !== 3) {
    throw new Error("cli_missing_reputation_arguments");
  }

  if ((command === "show" || command === "fields") && args.length !== 1) {
    throw new Error(command === "show" ? "cli_missing_domain_argument" : "cli_missing_domain_argument");
  }

  if ((command === "field" || command === "field-create" || command === "field-set" || command === "field-clear") && args.length !== 2) {
    throw new Error("cli_missing_field_arguments");
  }

  if (
    unlockFor !== null
    && command !== "cog-lock"
  ) {
    throw new Error("cli_unlock_duration_not_supported_for_command");
  }

  if (assumeYes && !commandSupportsYesFlag(command)) {
    throw new Error("cli_yes_not_supported_for_command");
  }

  if (forceRace && command !== "register") {
    throw new Error("cli_force_race_not_supported_for_command");
  }

  if (force) {
    throw new Error("cli_force_not_supported_for_command");
  }

  if (anchorMessage !== null && command !== "anchor") {
    throw new Error("cli_message_not_supported_for_command");
  }

  const namedPayloadFlagCount = Number(endpointText !== null) + Number(endpointJson !== null) + Number(endpointBytes !== null);
  const hasRawPayloadFlags = fieldFormat !== null || fieldValue !== null;

  if ((endpointText !== null || endpointJson !== null || endpointBytes !== null)
    && command !== "domain-endpoint-set"
    && command !== "field-create"
    && command !== "field-set") {
    throw new Error("cli_endpoint_payload_not_supported_for_command");
  }

  if (command === "domain-endpoint-set" && namedPayloadFlagCount !== 1) {
    throw new Error("cli_endpoint_requires_exactly_one_payload_flag");
  }

  if (fieldPermanent && command !== "field-create") {
    throw new Error("cli_permanent_not_supported_for_command");
  }

  if (hasRawPayloadFlags && command !== "field-create" && command !== "field-set") {
    throw new Error("cli_field_value_not_supported_for_command");
  }

  if (command === "field-create" && (namedPayloadFlagCount > 0 || hasRawPayloadFlags)) {
    throw new Error("cli_field_create_initial_value_not_supported");
  }

  if (command === "field-set" && namedPayloadFlagCount > 0 && hasRawPayloadFlags) {
    throw new Error("cli_field_conflicting_payload_flags");
  }

  if (command === "field-set" && namedPayloadFlagCount > 1) {
    throw new Error("cli_field_requires_exactly_one_named_payload_flag");
  }

  if (command === "field-set" && fieldFormat !== null && fieldValue === null) {
    throw new Error("cli_missing_field_value");
  }

  if (command === "field-set" && fieldFormat === null && fieldValue !== null) {
    throw new Error("cli_missing_field_format");
  }

  if (command === "field-set" && namedPayloadFlagCount === 0 && !hasRawPayloadFlags) {
    throw new Error("cli_field_set_requires_value");
  }

  if ((command === "field-clear" || command === "field" || command === "fields")
    && (namedPayloadFlagCount > 0 || hasRawPayloadFlags || fieldPermanent)) {
    throw new Error("cli_field_flags_not_supported_for_command");
  }

  if (transferTarget !== null && command !== "transfer") {
    if (command !== "send" && command !== "bitcoin-transfer") {
      throw new Error("cli_to_not_supported_for_command");
    }
  }

  if (
    (command === "transfer" || command === "send" || command === "bitcoin-transfer")
    && transferTarget === null
  ) {
    throw new Error("cli_missing_transfer_target");
  }

  if (lockRecipientDomain !== null && command !== "cog-lock") {
    throw new Error("cli_to_domain_not_supported_for_command");
  }

  if (conditionHex !== null && command !== "cog-lock") {
    throw new Error("cli_condition_not_supported_for_command");
  }

  if (untilHeight !== null && command !== "cog-lock") {
    throw new Error("cli_until_height_not_supported_for_command");
  }

  if (preimageHex !== null && command !== "claim") {
    throw new Error("cli_preimage_not_supported_for_command");
  }

  if (reviewText !== null && command !== "rep-give" && command !== "rep-revoke") {
    throw new Error("cli_review_not_supported_for_command");
  }

  if (satvb !== null && !commandSupportsSatvb(command)) {
    throw new Error("cli_satvb_not_supported_for_command");
  }

  if ((locksClaimableOnly || locksReclaimableOnly)
    && command !== "locks") {
    throw new Error("cli_lock_filters_not_supported_for_command");
  }

  if (locksClaimableOnly && locksReclaimableOnly) {
    throw new Error("cli_conflicting_lock_filters");
  }

  if ((domainsAnchoredOnly || domainsListedOnly || domainsMineableOnly)
    && command !== "domains") {
    throw new Error("cli_domain_filters_not_supported_for_command");
  }

  if ((listLimit !== null || listAll)
    && command !== "locks"
    && command !== "ids"
    && command !== "domains"
    && command !== "fields"
    && command !== "mine-log") {
    throw new Error("cli_lock_filters_not_supported_for_command");
  }

  if (listAll && listLimit !== null) {
    throw new Error("cli_conflicting_lock_limits");
  }

  if (follow && command !== "mine-log") {
    throw new Error("cli_follow_not_supported_for_command");
  }

  if (command === "mine-log" && follow && (listAll || listLimit !== null)) {
    throw new Error("cli_follow_limit_not_supported");
  }

  if (command === "cog-lock") {
    if (lockRecipientDomain === null) {
      throw new Error("cli_missing_lock_domain");
    }
    if (conditionHex === null) {
      throw new Error("cli_missing_lock_condition");
    }
    if ((unlockFor === null) === (untilHeight === null)) {
      throw new Error("cli_lock_timeout_requires_exactly_one_mode");
    }
  }

  if (command === "claim" && preimageHex === null) {
    throw new Error("cli_missing_claim_preimage");
  }

  return {
    command,
    commandFamily,
    invokedCommandTokens,
    invokedCommandPath,
    args,
    help,
    version,
    dbPath,
    dataDir,
    progressOutput,
    unlockFor,
    assumeYes,
    force,
    forceRace,
    anchorMessage,
    transferTarget,
    endpointText,
    endpointJson,
    endpointBytes,
    fieldPermanent,
    fieldFormat,
    fieldValue,
    lockRecipientDomain,
    conditionHex,
    untilHeight,
    preimageHex,
    reviewText,
    satvb,
    locksClaimableOnly,
    locksReclaimableOnly,
    domainsAnchoredOnly,
    domainsListedOnly,
    domainsMineableOnly,
    listLimit,
    listAll,
    follow,
  };
}
