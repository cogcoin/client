import type { CommandName, OutputMode, ParsedCliArgs, ProgressOutput } from "./types.js";
import {
  isJsonOutputSupportedCommand,
  isPreviewJsonOutputSupportedCommand,
} from "./output.js";

export const HELP_TEXT = `Usage: cogcoin <command> [options]

Commands:
  status                  Show wallet-aware local service and chain status
  status --output json    Emit the stable v1 machine-readable status envelope
  client unlock           Unlock password-protected local wallet secrets for a limited time
  client lock             Flush the cached client password unlock session
  bitcoin start           Start the managed Bitcoin daemon
  bitcoin stop            Stop the managed Bitcoin daemon and paired indexer
  bitcoin status          Show managed Bitcoin daemon status without starting it
  indexer start           Start the managed Cogcoin indexer (and bitcoind if needed)
  indexer stop            Stop the managed Cogcoin indexer only
  indexer status          Show managed Cogcoin indexer status without starting it
  init                    Initialize a new local wallet root
  init --output json      Emit the stable v1 machine-readable init result envelope
  restore                 Restore an imported named seed from a 24-word mnemonic; run sync afterward
  reset                   Factory-reset local Cogcoin state with interactive retention prompts
  repair                  Recover bounded wallet/indexer/runtime state
  wallet address          Alias for address
  wallet ids              Alias for ids
  mine                    Run the miner in the foreground
  mine start              Start the miner as a background worker
  mine stop               Stop the active background miner
  mine setup              Configure the built-in mining provider
  mine setup --output json
                         Emit the stable v1 machine-readable mine setup result envelope
  mine status             Show mining control-plane health and readiness
  mine log                Show recent mining control-plane events
  anchor <domain>         Anchor an owned unanchored domain with the wallet address
  register <domain>
                         Register a root domain or subdomain
  transfer <domain> --to <btc-target>
                          Transfer an unanchored domain to another BTC address or script
  sell <domain> <price>   List an unanchored domain for sale in COG
  unsell <domain>         Clear an active domain listing
  buy <domain>
                         Buy an unanchored listed domain in COG
  send <amount> --to <btc-target>
                         Send COG from the wallet address to another BTC target
  claim <lock-id> --preimage <32-byte-hex>
                         Claim an active COG lock before timeout
  reclaim <lock-id>      Reclaim an expired COG lock as the original locker
  cog lock <amount> --to-domain <domain> (--for <blocks-or-duration> | --until-height <height>) --condition <sha256hex>
                         Lock COG to an anchored recipient domain
  wallet status           Show detailed wallet-local status and service health
  wallet init             Initialize a new local wallet root
  wallet restore          Restore an imported named seed from a 24-word mnemonic; run sync afterward
  wallet delete           Delete one imported named seed without affecting main
  wallet show-mnemonic    Reveal the initialized wallet recovery phrase after typed confirmation
  address                 Show the BTC wallet address for this wallet
  ids                     Show the local wallet address
  balance                 Show local wallet COG balances
  locks                   Show locally related active COG locks
  domain list             Alias for domains
  domain show <domain>    Alias for show <domain>
  domains [--anchored] [--listed] [--mineable]
                         Show locally related domains
  show <domain>           Show one domain and its local-wallet relationship
  fields <domain>         List current fields on a domain
  field <domain> <field>  Show one current field value
  field create <domain> <field>
                         Create a new empty anchored field
  field set <domain> <field>
                         Update an existing anchored field value
  field clear <domain> <field>
                         Clear an existing anchored field value
  rep give <source-domain> <target-domain> <amount>
                         Burn COG as anchored-domain reputation support
  rep revoke <source-domain> <target-domain> <amount>
                         Revoke visible support without refunding burned COG

Options:
  --db <path>       Override the SQLite database path
  --data-dir <path> Override the managed bitcoin datadir
  --for <duration>  Relative timeout for cog lock, like 15m, 2h, or 1d
  --message <text>  Founding message text for anchor
  --to <btc-target> Transfer or send target as an address or spk:<hex>
  --to-domain <domain>
                    Recipient domain for cog lock
  --condition <sha256hex>
                    32-byte lock condition hash
  --until-height <height>
                    Absolute timeout height for cog lock
  --preimage <32-byte-hex>
                    Claim preimage for an active lock
  --review <text>   Optional public review text for reputation operations
  --text <utf8>     UTF-8 payload text for endpoint or field writes
  --json <json>     UTF-8 payload JSON text for endpoint or field writes
  --bytes <spec>    Payload bytes as hex:<hex> or @<path>
  --permanent       Create the field as permanent
  --format <spec>   Advanced field format as raw:<u8>
  --value <spec>    Advanced field value as hex:<hex>, @<path>, or utf8:<text>
  --claimable      Show only currently claimable locks
  --reclaimable    Show only currently reclaimable locks
  --anchored       Show only anchored domains
  --listed         Show only currently listed domains
  --mineable       Show only locally mineable root domains
  --limit <n>      Limit list rows (1..1000)
  --all            Show all rows for list commands
  --follow         Follow mining log output
  --output <mode>  Output mode: text, json, or preview-json
  --progress <mode> Progress output mode: auto, tty, or none
  --seed <name>    Select an imported wallet seed for wallet-aware commands
  --force          Reserved for future use
  --force-race      Allow a visible root registration race
  --yes             Approve eligible plain yes/no mutation confirmations non-interactively
  --help            Show help
  --version         Show package version

Quickstart:
  1. Run \`cogcoin init\` to create the wallet.
  2. Run \`cogcoin sync\` to bootstrap assumeutxo and the managed Bitcoin/indexer state.
  3. Run \`cogcoin address\`, then fund the wallet with about 0.0015 BTC so you can buy a 6+ character domain to start mining and still keep BTC available for mining transaction fees.

Examples:
  cogcoin status --output json
  cogcoin bitcoin status
  cogcoin indexer status
  cogcoin init --output json
  cogcoin restore --seed trading
  cogcoin wallet address
  cogcoin domain list --mineable
  cogcoin register alpha-child
  cogcoin anchor alpha
  cogcoin buy alpha
  cogcoin field set alpha bio --text "hello"
  cogcoin rep give alpha beta 10 --review "great operator"
  cogcoin mine setup --output json
  cogcoin register alpha-child --output preview-json
  cogcoin mine status
`;

function supportsYesFlag(command: CommandName | null): boolean {
  switch (command) {
    case "sync":
    case "follow":
    case "repair":
    case "wallet-delete":
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
    case "field-create":
    case "field-set":
    case "field-clear":
    case "domain-endpoint-set":
    case "domain-endpoint-clear":
    case "domain-delegate-set":
    case "domain-delegate-clear":
    case "domain-miner-set":
    case "domain-miner-clear":
    case "domain-canonical":
    case "rep-give":
    case "rep-revoke":
      return true;
    default:
      return false;
  }
}

function supportsSeedFlag(command: CommandName | null): boolean {
  switch (command) {
    case "status":
    case "anchor":
    case "domain-anchor":
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
    case "domain-endpoint-set":
    case "domain-endpoint-clear":
    case "domain-delegate-set":
    case "domain-delegate-clear":
    case "domain-miner-set":
    case "domain-miner-clear":
    case "domain-canonical":
    case "field-list":
    case "field-show":
    case "field-create":
    case "field-set":
    case "field-clear":
    case "send":
    case "claim":
    case "reclaim":
    case "cog-send":
    case "cog-claim":
    case "cog-reclaim":
    case "cog-lock":
    case "rep-give":
    case "rep-revoke":
    case "cog-balance":
    case "cog-locks":
    case "mine":
    case "mine-start":
    case "mine-stop":
    case "mine-setup":
    case "mine-status":
    case "mine-log":
    case "wallet-delete":
    case "wallet-restore":
    case "restore":
    case "wallet-show-mnemonic":
    case "wallet-status":
    case "wallet-address":
    case "wallet-ids":
    case "address":
    case "ids":
    case "balance":
    case "locks":
    case "domain-list":
    case "domains":
    case "domain-show":
    case "show":
    case "fields":
    case "field":
      return true;
    default:
      return false;
  }
}

function requiresSeedFlag(command: CommandName | null): boolean {
  return command === "restore" || command === "wallet-restore" || command === "wallet-delete";
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  let command: CommandName | null = null;
  const args: string[] = [];
  let help = false;
  let version = false;
  let outputMode: OutputMode = "text";
  let dbPath: string | null = null;
  let dataDir: string | null = null;
  let progressOutput: ProgressOutput = "auto";
  let seedName: string | null = null;
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

    if (token === "--output") {
      index += 1;
      const value = argv[index] ?? null;

      if (value !== "text" && value !== "json" && value !== "preview-json") {
        throw new Error("cli_invalid_output_mode");
      }

      outputMode = value;
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
      index += 1;
      seedName = argv[index] ?? null;

      if (seedName === null) {
        throw new Error("cli_missing_seed_name");
      }

      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(seedName)) {
        throw new Error("cli_invalid_seed_name");
      }

      continue;
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
      if (token === "wallet") {
        const subcommand = argv[index + 1] ?? null;

        if (subcommand === "status") {
          command = "wallet-status";
          index += 1;
          continue;
        }

        if (subcommand === "address") {
          command = "wallet-address";
          index += 1;
          continue;
        }

        if (subcommand === "ids") {
          command = "wallet-ids";
          index += 1;
          continue;
        }

        if (subcommand === "init") {
          command = "wallet-init";
          index += 1;
          continue;
        }

        if (subcommand === "restore") {
          command = "wallet-restore";
          index += 1;
          continue;
        }

        if (subcommand === "delete") {
          command = "wallet-delete";
          index += 1;
          continue;
        }

        if (subcommand === "show-mnemonic") {
          command = "wallet-show-mnemonic";
          index += 1;
          continue;
        }

        if (subcommand === "export") {
          throw new Error("cli_wallet_export_removed");
        }

        if (subcommand === "import") {
          throw new Error("cli_wallet_import_removed");
        }

        throw new Error(`cli_unknown_command_wallet${subcommand === null ? "" : `_${subcommand}`}`);
      }

      if (token === "bitcoin") {
        const subcommand = argv[index + 1] ?? null;

        if (subcommand === "start") {
          command = "bitcoin-start";
          index += 1;
          continue;
        }

        if (subcommand === "stop") {
          command = "bitcoin-stop";
          index += 1;
          continue;
        }

        if (subcommand === "status") {
          command = "bitcoin-status";
          index += 1;
          continue;
        }

        throw new Error(`cli_unknown_command_bitcoin${subcommand === null ? "" : `_${subcommand}`}`);
      }

      if (token === "client") {
        const subcommand = argv[index + 1] ?? null;

        if (subcommand === "unlock") {
          command = "client-unlock";
          index += 1;
          continue;
        }

        if (subcommand === "lock") {
          command = "client-lock";
          index += 1;
          continue;
        }

        throw new Error(`cli_unknown_command_client${subcommand === null ? "" : `_${subcommand}`}`);
      }

      if (token === "indexer") {
        const subcommand = argv[index + 1] ?? null;

        if (subcommand === "start") {
          command = "indexer-start";
          index += 1;
          continue;
        }

        if (subcommand === "stop") {
          command = "indexer-stop";
          index += 1;
          continue;
        }

        if (subcommand === "status") {
          command = "indexer-status";
          index += 1;
          continue;
        }

        throw new Error(`cli_unknown_command_indexer${subcommand === null ? "" : `_${subcommand}`}`);
      }

      if (token === "mine") {
        const subcommand = argv[index + 1] ?? null;

        if (subcommand === null || subcommand.startsWith("--")) {
          command = "mine";
          continue;
        }

        if (subcommand === "start") {
          command = "mine-start";
          index += 1;
          continue;
        }

        if (subcommand === "stop") {
          command = "mine-stop";
          index += 1;
          continue;
        }

        if (subcommand === "setup") {
          command = "mine-setup";
          index += 1;
          continue;
        }

        if (subcommand === "status") {
          command = "mine-status";
          index += 1;
          continue;
        }

        if (subcommand === "log") {
          command = "mine-log";
          index += 1;
          continue;
        }

        throw new Error(`cli_unknown_command_mine${subcommand === null ? "" : `_${subcommand}`}`);
      }

      if (token === "domain") {
        const subcommand = argv[index + 1] ?? null;

        if (subcommand === "register") {
          command = "domain-register";
          index += 1;
          continue;
        }

        if (subcommand === "list") {
          command = "domain-list";
          index += 1;
          continue;
        }

        if (subcommand === "show") {
          command = "domain-show";
          index += 1;
          continue;
        }

        if (subcommand === "anchor") {
          const action = argv[index + 2] ?? null;

          if (action === "clear") {
            throw new Error("cli_anchor_clear_removed");
          }

          command = "domain-anchor";
          index += 1;
          continue;
        }

        if (subcommand === "transfer") {
          command = "domain-transfer";
          index += 1;
          continue;
        }

        if (subcommand === "sell") {
          command = "domain-sell";
          index += 1;
          continue;
        }

        if (subcommand === "unsell") {
          command = "domain-unsell";
          index += 1;
          continue;
        }

        if (subcommand === "buy") {
          command = "domain-buy";
          index += 1;
          continue;
        }

        if (subcommand === "endpoint") {
          const action = argv[index + 2] ?? null;

          if (action === "set") {
            command = "domain-endpoint-set";
            index += 2;
            continue;
          }

          if (action === "clear") {
            command = "domain-endpoint-clear";
            index += 2;
            continue;
          }

          throw new Error(`cli_unknown_command_domain_endpoint${action === null ? "" : `_${action}`}`);
        }

        if (subcommand === "delegate") {
          const action = argv[index + 2] ?? null;

          if (action === "set") {
            command = "domain-delegate-set";
            index += 2;
            continue;
          }

          if (action === "clear") {
            command = "domain-delegate-clear";
            index += 2;
            continue;
          }

          throw new Error(`cli_unknown_command_domain_delegate${action === null ? "" : `_${action}`}`);
        }

        if (subcommand === "miner") {
          const action = argv[index + 2] ?? null;

          if (action === "set") {
            command = "domain-miner-set";
            index += 2;
            continue;
          }

          if (action === "clear") {
            command = "domain-miner-clear";
            index += 2;
            continue;
          }

          throw new Error(`cli_unknown_command_domain_miner${action === null ? "" : `_${action}`}`);
        }

        if (subcommand === "canonical") {
          command = "domain-canonical";
          index += 1;
          continue;
        }

        throw new Error(`cli_unknown_command_domain${subcommand === null ? "" : `_${subcommand}`}`);
      }

      if (token === "cog") {
        const subcommand = argv[index + 1] ?? null;

        if (subcommand === "send") {
          command = "cog-send";
          index += 1;
          continue;
        }

        if (subcommand === "claim") {
          command = "cog-claim";
          index += 1;
          continue;
        }

        if (subcommand === "reclaim") {
          command = "cog-reclaim";
          index += 1;
          continue;
        }

        if (subcommand === "lock") {
          command = "cog-lock";
          index += 1;
          continue;
        }

        if (subcommand === "balance") {
          command = "cog-balance";
          index += 1;
          continue;
        }

        if (subcommand === "locks") {
          command = "cog-locks";
          index += 1;
          continue;
        }

        throw new Error(`cli_unknown_command_cog${subcommand === null ? "" : `_${subcommand}`}`);
      }

      if (token === "rep") {
        const subcommand = argv[index + 1] ?? null;

        if (subcommand === "give") {
          command = "rep-give";
          index += 1;
          continue;
        }

        if (subcommand === "revoke") {
          command = "rep-revoke";
          index += 1;
          continue;
        }

        throw new Error(`cli_unknown_command_rep${subcommand === null ? "" : `_${subcommand}`}`);
      }

      if (token === "field") {
        const subcommand = argv[index + 1] ?? null;

        if (subcommand === "list") {
          command = "field-list";
          index += 1;
          continue;
        }

        if (subcommand === "show") {
          command = "field-show";
          index += 1;
          continue;
        }

        if (subcommand === "create") {
          command = "field-create";
          index += 1;
          continue;
        }

        if (subcommand === "set") {
          command = "field-set";
          index += 1;
          continue;
        }

        if (subcommand === "clear") {
          command = "field-clear";
          index += 1;
          continue;
        }

        command = "field";
        continue;
      }

      if (
        token === "init"
        || token === "restore"
        || token === "reset"
        || token === "repair"
        || token === "sync"
        || token === "status"
        || token === "follow"
        || token === "anchor"
        || token === "register"
        || token === "transfer"
        || token === "sell"
        || token === "unsell"
        || token === "buy"
        || token === "send"
        || token === "claim"
        || token === "reclaim"
        || token === "address"
        || token === "ids"
        || token === "balance"
        || token === "locks"
        || token === "domains"
        || token === "show"
        || token === "fields"
      ) {
        if (token === "anchor" && argv[index + 1] === "clear") {
          throw new Error("cli_anchor_clear_removed");
        }
        command = token as CommandName;
        continue;
      }

      throw new Error(`cli_unknown_command_${token}`);
    }

    args.push(token);
  }

  if (
    (command === "status"
      || command === "bitcoin-start"
      || command === "bitcoin-stop"
      || command === "bitcoin-status"
      || command === "indexer-start"
      || command === "indexer-stop"
      || command === "indexer-status"
      || command === "init"
      || command === "restore"
      || command === "reset"
      || command === "wallet-init"
      || command === "wallet-delete"
      || command === "wallet-restore"
      || command === "wallet-status"
      || command === "repair"
      || command === "sync"
      || command === "follow"
      || command === "mine"
      || command === "mine-start"
      || command === "mine-stop"
      || command === "mine-setup"
      || command === "mine-status"
      || command === "mine-log"
      || command === "wallet-address"
      || command === "wallet-ids"
      || command === "address"
      || command === "ids"
      || command === "balance"
      || command === "cog-balance"
      || command === "locks"
      || command === "cog-locks"
      || command === "domain-list"
      || command === "domains")
    && args.length !== 0
  ) {
    throw new Error(`cli_unexpected_argument_${args[0]}`);
  }

  if ((command === "register" || command === "domain-register") && args.length !== 1) {
    throw new Error("cli_missing_domain_argument");
  }

  if (
    (command === "anchor"
      || command === "domain-anchor")
    && args.length !== 1
  ) {
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

  if ((command === "transfer" || command === "domain-transfer") && args.length !== 1) {
    throw new Error("cli_missing_domain_argument");
  }

  if ((command === "sell" || command === "domain-sell") && args.length !== 2) {
    throw new Error("cli_missing_sell_arguments");
  }

  if ((command === "unsell" || command === "domain-unsell" || command === "buy" || command === "domain-buy") && args.length !== 1) {
    throw new Error("cli_missing_domain_argument");
  }

  if ((command === "send" || command === "cog-send" || command === "cog-lock") && args.length !== 1) {
    throw new Error("cli_missing_amount_argument");
  }

  if ((command === "claim" || command === "cog-claim" || command === "reclaim" || command === "cog-reclaim") && args.length !== 1) {
    throw new Error("cli_missing_lock_argument");
  }

  if ((command === "rep-give" || command === "rep-revoke") && args.length !== 3) {
    throw new Error("cli_missing_reputation_arguments");
  }

  if ((command === "show" || command === "domain-show" || command === "fields") && args.length !== 1) {
    throw new Error(command === "show" ? "cli_missing_domain_argument" : "cli_missing_domain_argument");
  }

  if (command === "field-list" && args.length !== 1) {
    throw new Error("cli_missing_domain_argument");
  }

  if ((command === "field" || command === "field-show" || command === "field-create" || command === "field-set" || command === "field-clear") && args.length !== 2) {
    throw new Error("cli_missing_field_arguments");
  }

  if (
    unlockFor !== null
    && command !== "cog-lock"
  ) {
    throw new Error("cli_unlock_duration_not_supported_for_command");
  }

  if (assumeYes && !supportsYesFlag(command)) {
    throw new Error("cli_yes_not_supported_for_command");
  }

  if (seedName !== null && !supportsSeedFlag(command)) {
    throw new Error("cli_seed_not_supported_for_command");
  }

  if (requiresSeedFlag(command) && seedName === null) {
    throw new Error("cli_missing_seed_name");
  }

  if (forceRace && command !== "register" && command !== "domain-register") {
    throw new Error("cli_force_race_not_supported_for_command");
  }

  if (force) {
    throw new Error("cli_force_not_supported_for_command");
  }

  if (anchorMessage !== null && command !== "anchor" && command !== "domain-anchor") {
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

  if ((command === "field-clear" || command === "field" || command === "field-show" || command === "field-list")
    && (namedPayloadFlagCount > 0 || hasRawPayloadFlags || fieldPermanent)) {
    throw new Error("cli_field_flags_not_supported_for_command");
  }

  if (transferTarget !== null && command !== "transfer" && command !== "domain-transfer") {
    if (command !== "send" && command !== "cog-send") {
      throw new Error("cli_to_not_supported_for_command");
    }
  }

  if ((command === "transfer" || command === "domain-transfer" || command === "send" || command === "cog-send") && transferTarget === null) {
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

  if (preimageHex !== null && command !== "claim" && command !== "cog-claim") {
    throw new Error("cli_preimage_not_supported_for_command");
  }

  if (reviewText !== null && command !== "rep-give" && command !== "rep-revoke") {
    throw new Error("cli_review_not_supported_for_command");
  }

  if ((locksClaimableOnly || locksReclaimableOnly)
    && command !== "locks"
    && command !== "cog-locks") {
    throw new Error("cli_lock_filters_not_supported_for_command");
  }

  if (locksClaimableOnly && locksReclaimableOnly) {
    throw new Error("cli_conflicting_lock_filters");
  }

  if ((domainsAnchoredOnly || domainsListedOnly || domainsMineableOnly)
    && command !== "domain-list"
    && command !== "domains") {
    throw new Error("cli_domain_filters_not_supported_for_command");
  }

  if ((listLimit !== null || listAll)
    && command !== "locks"
    && command !== "cog-locks"
    && command !== "wallet-ids"
    && command !== "ids"
    && command !== "domain-list"
    && command !== "domains"
    && command !== "fields"
    && command !== "field-list"
    && command !== "mine-log") {
    throw new Error("cli_lock_filters_not_supported_for_command");
  }

  if (listAll && listLimit !== null) {
    throw new Error("cli_conflicting_lock_limits");
  }

  if (follow && command !== "mine-log") {
    throw new Error("cli_follow_not_supported_for_command");
  }

  if (command === "mine-log" && follow && outputMode !== "text") {
    throw new Error("cli_follow_json_not_supported");
  }

  if (command === "mine-log" && follow && (listAll || listLimit !== null)) {
    throw new Error("cli_follow_limit_not_supported");
  }

  if (outputMode === "json" && !isJsonOutputSupportedCommand(command)) {
    throw new Error("cli_output_not_supported_for_command");
  }

  if (outputMode === "preview-json" && !isPreviewJsonOutputSupportedCommand(command)) {
    throw new Error("cli_output_not_supported_for_command");
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

  if ((command === "claim" || command === "cog-claim") && preimageHex === null) {
    throw new Error("cli_missing_claim_preimage");
  }

  return {
    command,
    args,
    help,
    version,
    outputMode,
    dbPath,
    dataDir,
    progressOutput,
    seedName,
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
