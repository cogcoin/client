export type CommandHandlerFamily =
  | "status"
  | "update"
  | "sync"
  | "follow"
  | "client-admin"
  | "service-runtime"
  | "wallet-admin"
  | "wallet-read"
  | "wallet-mutation"
  | "mining-admin"
  | "mining-runtime"
  | "mining-read";

export type CommandName =
  | "init"
  | "reset"
  | "repair"
  | "update"
  | "sync"
  | "status"
  | "client-lock"
  | "client-change-password"
  | "client-unlock"
  | "follow"
  | "bitcoin-start"
  | "bitcoin-stop"
  | "bitcoin-status"
  | "bitcoin-transfer"
  | "indexer-start"
  | "indexer-stop"
  | "indexer-status"
  | "anchor"
  | "register"
  | "transfer"
  | "sell"
  | "unsell"
  | "buy"
  | "domain-endpoint-set"
  | "domain-endpoint-clear"
  | "domain-delegate-set"
  | "domain-delegate-clear"
  | "domain-miner-set"
  | "domain-miner-clear"
  | "domain-canonical"
  | "fields"
  | "field"
  | "field-create"
  | "field-set"
  | "field-clear"
  | "send"
  | "claim"
  | "reclaim"
  | "cog-lock"
  | "rep-give"
  | "rep-revoke"
  | "mine"
  | "mine-start"
  | "mine-stop"
  | "mine-setup"
  | "mine-prompt"
  | "mine-prompt-list"
  | "mine-status"
  | "mine-log"
  | "wallet-show-mnemonic"
  | "wallet-status"
  | "address"
  | "ids"
  | "balance"
  | "locks"
  | "domains"
  | "show";

type AliasMatchMode = "always" | "requires-arg" | "end-or-flag";

interface HelpEntry {
  usage: string;
  description: string;
}

interface CommandAlias {
  tokens: readonly string[];
  matchMode?: AliasMatchMode;
}

export interface CommandSpec {
  id: CommandName;
  handlerFamily: CommandHandlerFamily;
  supportsYes: boolean;
  supportsSatvb: boolean;
  aliases: readonly CommandAlias[];
  helpEntries: readonly HelpEntry[];
  describeCommand(args: readonly string[], options: { follow: boolean }): string;
}

interface RemovedPathSpec {
  tokens: readonly string[];
  errorCode: string;
}

interface UnknownPrefixSpec {
  tokens: readonly string[];
  errorPrefix: string;
}

export interface CommandMatch {
  command: CommandName;
  consumedTokens: number;
  invokedTokens: readonly string[];
}

const commandSpecs = [
  {
    id: "status",
    handlerFamily: "status",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [{ tokens: ["status"] }],
    helpEntries: [
      {
        usage: "status",
        description: "Show wallet-aware local service and chain status",
      },
    ],
    describeCommand() {
      return "cogcoin status";
    },
  },
  {
    id: "update",
    handlerFamily: "update",
    supportsYes: true,
    supportsSatvb: false,
    aliases: [{ tokens: ["update"] }],
    helpEntries: [
      {
        usage: "update",
        description: "Show the current and latest client versions and install updates",
      },
    ],
    describeCommand() {
      return "cogcoin update";
    },
  },
  {
    id: "client-unlock",
    handlerFamily: "client-admin",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [{ tokens: ["client", "unlock"] }],
    helpEntries: [
      {
        usage: "client unlock",
        description: "Unlock password-protected local wallet secrets for a limited time",
      },
    ],
    describeCommand() {
      return "cogcoin client unlock";
    },
  },
  {
    id: "client-lock",
    handlerFamily: "client-admin",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [{ tokens: ["client", "lock"] }],
    helpEntries: [
      {
        usage: "client lock",
        description: "Flush the cached client password unlock session",
      },
    ],
    describeCommand() {
      return "cogcoin client lock";
    },
  },
  {
    id: "client-change-password",
    handlerFamily: "client-admin",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [{ tokens: ["client", "change-password"] }],
    helpEntries: [
      {
        usage: "client change-password",
        description: "Rotate the client password that protects local wallet secrets",
      },
    ],
    describeCommand() {
      return "cogcoin client change-password";
    },
  },
  {
    id: "bitcoin-start",
    handlerFamily: "service-runtime",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [{ tokens: ["bitcoin", "start"] }],
    helpEntries: [
      {
        usage: "bitcoin start",
        description: "Start the managed Bitcoin daemon",
      },
    ],
    describeCommand() {
      return "cogcoin bitcoin start";
    },
  },
  {
    id: "bitcoin-stop",
    handlerFamily: "service-runtime",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [{ tokens: ["bitcoin", "stop"] }],
    helpEntries: [
      {
        usage: "bitcoin stop",
        description: "Stop the managed Bitcoin daemon and paired indexer",
      },
    ],
    describeCommand() {
      return "cogcoin bitcoin stop";
    },
  },
  {
    id: "bitcoin-status",
    handlerFamily: "service-runtime",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [{ tokens: ["bitcoin", "status"] }],
    helpEntries: [
      {
        usage: "bitcoin status",
        description: "Show managed Bitcoin daemon status without starting it",
      },
    ],
    describeCommand() {
      return "cogcoin bitcoin status";
    },
  },
  {
    id: "bitcoin-transfer",
    handlerFamily: "wallet-mutation",
    supportsYes: true,
    supportsSatvb: false,
    aliases: [{ tokens: ["bitcoin", "transfer"] }],
    helpEntries: [
      {
        usage: "bitcoin transfer <sats> --to <address>",
        description: "Send plain BTC from the wallet address",
      },
    ],
    describeCommand(args) {
      return `cogcoin bitcoin transfer ${args[0] ?? "<sats>"}`;
    },
  },
  {
    id: "indexer-start",
    handlerFamily: "service-runtime",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [{ tokens: ["indexer", "start"] }],
    helpEntries: [
      {
        usage: "indexer start",
        description: "Start the managed Cogcoin indexer (and bitcoind if needed)",
      },
    ],
    describeCommand() {
      return "cogcoin indexer start";
    },
  },
  {
    id: "indexer-stop",
    handlerFamily: "service-runtime",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [{ tokens: ["indexer", "stop"] }],
    helpEntries: [
      {
        usage: "indexer stop",
        description: "Stop the managed Cogcoin indexer only",
      },
    ],
    describeCommand() {
      return "cogcoin indexer stop";
    },
  },
  {
    id: "indexer-status",
    handlerFamily: "service-runtime",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [{ tokens: ["indexer", "status"] }],
    helpEntries: [
      {
        usage: "indexer status",
        description: "Show managed Cogcoin indexer status without starting it",
      },
    ],
    describeCommand() {
      return "cogcoin indexer status";
    },
  },
  {
    id: "init",
    handlerFamily: "wallet-admin",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [
      { tokens: ["init"] },
      { tokens: ["wallet", "init"] },
    ],
    helpEntries: [
      {
        usage: "init",
        description: "Initialize a new wallet or restore an existing wallet",
      },
      {
        usage: "wallet init",
        description: "Alias for init",
      },
    ],
    describeCommand() {
      return "cogcoin init";
    },
  },
  {
    id: "reset",
    handlerFamily: "wallet-admin",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [{ tokens: ["reset"] }],
    helpEntries: [
      {
        usage: "reset",
        description: "Factory-reset local Cogcoin state with interactive retention prompts",
      },
    ],
    describeCommand() {
      return "cogcoin reset";
    },
  },
  {
    id: "repair",
    handlerFamily: "wallet-admin",
    supportsYes: true,
    supportsSatvb: false,
    aliases: [{ tokens: ["repair"] }],
    helpEntries: [
      {
        usage: "repair",
        description: "Recover bounded wallet/indexer/runtime state",
      },
    ],
    describeCommand() {
      return "cogcoin repair";
    },
  },
  {
    id: "address",
    handlerFamily: "wallet-read",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [
      { tokens: ["address"] },
      { tokens: ["wallet", "address"] },
    ],
    helpEntries: [
      {
        usage: "wallet address",
        description: "Alias for address",
      },
      {
        usage: "address",
        description: "Show the BTC wallet address for this wallet",
      },
    ],
    describeCommand() {
      return "cogcoin address";
    },
  },
  {
    id: "ids",
    handlerFamily: "wallet-read",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [
      { tokens: ["ids"] },
      { tokens: ["wallet", "ids"] },
    ],
    helpEntries: [
      {
        usage: "wallet ids",
        description: "Alias for ids",
      },
      {
        usage: "ids",
        description: "Show the local wallet address",
      },
    ],
    describeCommand() {
      return "cogcoin ids";
    },
  },
  {
    id: "mine",
    handlerFamily: "mining-runtime",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [{ tokens: ["mine"], matchMode: "end-or-flag" }],
    helpEntries: [
      {
        usage: "mine",
        description: "Run the miner in the foreground",
      },
    ],
    describeCommand() {
      return "cogcoin mine";
    },
  },
  {
    id: "mine-start",
    handlerFamily: "mining-runtime",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [{ tokens: ["mine", "start"] }],
    helpEntries: [
      {
        usage: "mine start",
        description: "Start the miner as a background worker",
      },
    ],
    describeCommand() {
      return "cogcoin mine start";
    },
  },
  {
    id: "mine-stop",
    handlerFamily: "mining-runtime",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [{ tokens: ["mine", "stop"] }],
    helpEntries: [
      {
        usage: "mine stop",
        description: "Stop the active background miner",
      },
    ],
    describeCommand() {
      return "cogcoin mine stop";
    },
  },
  {
    id: "mine-setup",
    handlerFamily: "mining-admin",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [{ tokens: ["mine", "setup"] }],
    helpEntries: [
      {
        usage: "mine setup",
        description: "Configure the built-in mining provider",
      },
    ],
    describeCommand() {
      return "cogcoin mine setup";
    },
  },
  {
    id: "mine-prompt-list",
    handlerFamily: "mining-read",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [
      { tokens: ["mine", "prompt"], matchMode: "end-or-flag" },
      { tokens: ["mine", "prompt", "list"] },
    ],
    helpEntries: [
      {
        usage: "mine prompt",
        description: "Show per-domain mining prompt state",
      },
      {
        usage: "mine prompt list",
        description: "Alias for mine prompt",
      },
    ],
    describeCommand() {
      return "cogcoin mine prompt";
    },
  },
  {
    id: "mine-prompt",
    handlerFamily: "mining-admin",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [{ tokens: ["mine", "prompt"], matchMode: "requires-arg" }],
    helpEntries: [
      {
        usage: "mine prompt <domain>",
        description: "Configure a per-domain mining prompt override",
      },
    ],
    describeCommand(args) {
      return `cogcoin mine prompt ${args[0] ?? "<domain>"}`;
    },
  },
  {
    id: "mine-status",
    handlerFamily: "mining-read",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [{ tokens: ["mine", "status"] }],
    helpEntries: [
      {
        usage: "mine status",
        description: "Show mining control-plane health and readiness",
      },
    ],
    describeCommand() {
      return "cogcoin mine status";
    },
  },
  {
    id: "mine-log",
    handlerFamily: "mining-read",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [{ tokens: ["mine", "log"] }],
    helpEntries: [
      {
        usage: "mine log",
        description: "Show recent mining control-plane events",
      },
    ],
    describeCommand(_args, options) {
      return `cogcoin mine log${options.follow ? " --follow" : ""}`;
    },
  },
  {
    id: "anchor",
    handlerFamily: "wallet-mutation",
    supportsYes: false,
    supportsSatvb: true,
    aliases: [
      { tokens: ["anchor"] },
      { tokens: ["domain", "anchor"] },
    ],
    helpEntries: [
      {
        usage: "anchor <domain>",
        description: "Anchor an owned unanchored domain with the wallet address",
      },
    ],
    describeCommand(args) {
      return `cogcoin anchor ${args[0] ?? "<domain>"}`;
    },
  },
  {
    id: "register",
    handlerFamily: "wallet-mutation",
    supportsYes: true,
    supportsSatvb: true,
    aliases: [
      { tokens: ["register"] },
      { tokens: ["domain", "register"] },
    ],
    helpEntries: [
      {
        usage: "register <domain>",
        description: "Register a root domain or subdomain",
      },
    ],
    describeCommand(args) {
      return `cogcoin register ${args[0] ?? "<domain>"}`;
    },
  },
  {
    id: "transfer",
    handlerFamily: "wallet-mutation",
    supportsYes: true,
    supportsSatvb: true,
    aliases: [
      { tokens: ["transfer"] },
      { tokens: ["domain", "transfer"] },
    ],
    helpEntries: [
      {
        usage: "transfer <domain> --to <btc-target>",
        description: "Transfer an unanchored domain to another BTC address or script",
      },
    ],
    describeCommand(args) {
      return `cogcoin transfer ${args[0] ?? "<domain>"}`;
    },
  },
  {
    id: "sell",
    handlerFamily: "wallet-mutation",
    supportsYes: true,
    supportsSatvb: true,
    aliases: [
      { tokens: ["sell"] },
      { tokens: ["domain", "sell"] },
    ],
    helpEntries: [
      {
        usage: "sell <domain> <price>",
        description: "List an unanchored domain for sale in COG",
      },
    ],
    describeCommand(args) {
      return `cogcoin sell ${args[0] ?? "<domain>"} ${args[1] ?? "<price>"}`;
    },
  },
  {
    id: "unsell",
    handlerFamily: "wallet-mutation",
    supportsYes: true,
    supportsSatvb: true,
    aliases: [
      { tokens: ["unsell"] },
      { tokens: ["domain", "unsell"] },
    ],
    helpEntries: [
      {
        usage: "unsell <domain>",
        description: "Clear an active domain listing",
      },
    ],
    describeCommand(args) {
      return `cogcoin unsell ${args[0] ?? "<domain>"}`;
    },
  },
  {
    id: "buy",
    handlerFamily: "wallet-mutation",
    supportsYes: true,
    supportsSatvb: true,
    aliases: [
      { tokens: ["buy"] },
      { tokens: ["domain", "buy"] },
    ],
    helpEntries: [
      {
        usage: "buy <domain>",
        description: "Buy an unanchored listed domain in COG",
      },
    ],
    describeCommand(args) {
      return `cogcoin buy ${args[0] ?? "<domain>"}`;
    },
  },
  {
    id: "send",
    handlerFamily: "wallet-mutation",
    supportsYes: true,
    supportsSatvb: true,
    aliases: [
      { tokens: ["send"] },
      { tokens: ["cog", "send"] },
    ],
    helpEntries: [
      {
        usage: "send <amount> --to <btc-target>",
        description: "Send COG from the wallet address to another BTC target",
      },
    ],
    describeCommand(args) {
      return `cogcoin send ${args[0] ?? "<amount>"}`;
    },
  },
  {
    id: "claim",
    handlerFamily: "wallet-mutation",
    supportsYes: true,
    supportsSatvb: true,
    aliases: [
      { tokens: ["claim"] },
      { tokens: ["cog", "claim"] },
    ],
    helpEntries: [
      {
        usage: "claim <lock-id> --preimage <32-byte-hex>",
        description: "Claim an active COG lock before timeout",
      },
    ],
    describeCommand(args) {
      return `cogcoin claim ${args[0] ?? "<lock-id>"}`;
    },
  },
  {
    id: "reclaim",
    handlerFamily: "wallet-mutation",
    supportsYes: true,
    supportsSatvb: true,
    aliases: [
      { tokens: ["reclaim"] },
      { tokens: ["cog", "reclaim"] },
    ],
    helpEntries: [
      {
        usage: "reclaim <lock-id>",
        description: "Reclaim an expired COG lock as the original locker",
      },
    ],
    describeCommand(args) {
      return `cogcoin reclaim ${args[0] ?? "<lock-id>"}`;
    },
  },
  {
    id: "cog-lock",
    handlerFamily: "wallet-mutation",
    supportsYes: true,
    supportsSatvb: true,
    aliases: [{ tokens: ["cog", "lock"] }],
    helpEntries: [
      {
        usage: "cog lock <amount> --to-domain <domain> (--for <blocks-or-duration> | --until-height <height>) --condition <sha256hex>",
        description: "Lock COG to an anchored recipient domain",
      },
    ],
    describeCommand(args) {
      return `cogcoin cog lock ${args[0] ?? "<amount>"}`;
    },
  },
  {
    id: "wallet-status",
    handlerFamily: "wallet-read",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [{ tokens: ["wallet", "status"] }],
    helpEntries: [
      {
        usage: "wallet status",
        description: "Show detailed wallet-local status and service health",
      },
    ],
    describeCommand() {
      return "cogcoin wallet status";
    },
  },
  {
    id: "wallet-show-mnemonic",
    handlerFamily: "wallet-admin",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [{ tokens: ["wallet", "show-mnemonic"] }],
    helpEntries: [
      {
        usage: "wallet show-mnemonic",
        description: "Reveal the initialized wallet recovery phrase after typed confirmation",
      },
    ],
    describeCommand() {
      return "cogcoin wallet show-mnemonic";
    },
  },
  {
    id: "balance",
    handlerFamily: "wallet-read",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [
      { tokens: ["balance"] },
      { tokens: ["cog", "balance"] },
    ],
    helpEntries: [
      {
        usage: "balance",
        description: "Show local wallet COG balances",
      },
    ],
    describeCommand() {
      return "cogcoin balance";
    },
  },
  {
    id: "locks",
    handlerFamily: "wallet-read",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [
      { tokens: ["locks"] },
      { tokens: ["cog", "locks"] },
    ],
    helpEntries: [
      {
        usage: "locks",
        description: "Show locally related active COG locks",
      },
    ],
    describeCommand() {
      return "cogcoin locks";
    },
  },
  {
    id: "domains",
    handlerFamily: "wallet-read",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [
      { tokens: ["domains"] },
      { tokens: ["domain", "list"] },
    ],
    helpEntries: [
      {
        usage: "domain list",
        description: "Alias for domains",
      },
      {
        usage: "domains [--anchored] [--listed] [--mineable]",
        description: "Show locally related domains",
      },
    ],
    describeCommand() {
      return "cogcoin domains";
    },
  },
  {
    id: "show",
    handlerFamily: "wallet-read",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [
      { tokens: ["show"] },
      { tokens: ["domain", "show"] },
    ],
    helpEntries: [
      {
        usage: "domain show <domain>",
        description: "Alias for show <domain>",
      },
      {
        usage: "show <domain>",
        description: "Show one domain and its local-wallet relationship",
      },
    ],
    describeCommand(args) {
      return `cogcoin show ${args[0] ?? "<domain>"}`;
    },
  },
  {
    id: "fields",
    handlerFamily: "wallet-read",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [
      { tokens: ["fields"] },
      { tokens: ["field", "list"] },
    ],
    helpEntries: [
      {
        usage: "fields <domain>",
        description: "List current fields on a domain",
      },
    ],
    describeCommand(args) {
      return `cogcoin fields ${args[0] ?? "<domain>"}`;
    },
  },
  {
    id: "field",
    handlerFamily: "wallet-read",
    supportsYes: false,
    supportsSatvb: false,
    aliases: [
      { tokens: ["field"], matchMode: "always" },
      { tokens: ["field", "show"] },
    ],
    helpEntries: [
      {
        usage: "field <domain> <field>",
        description: "Show one current field value",
      },
    ],
    describeCommand(args) {
      return `cogcoin field ${args[0] ?? "<domain>"} ${args[1] ?? "<field>"}`;
    },
  },
  {
    id: "field-create",
    handlerFamily: "wallet-mutation",
    supportsYes: true,
    supportsSatvb: true,
    aliases: [{ tokens: ["field", "create"] }],
    helpEntries: [
      {
        usage: "field create <domain> <field>",
        description: "Create a new empty anchored field",
      },
    ],
    describeCommand(args) {
      return `cogcoin field create ${args[0] ?? "<domain>"} ${args[1] ?? "<field>"}`;
    },
  },
  {
    id: "field-set",
    handlerFamily: "wallet-mutation",
    supportsYes: true,
    supportsSatvb: true,
    aliases: [{ tokens: ["field", "set"] }],
    helpEntries: [
      {
        usage: "field set <domain> <field>",
        description: "Update an existing anchored field value",
      },
    ],
    describeCommand(args) {
      return `cogcoin field set ${args[0] ?? "<domain>"} ${args[1] ?? "<field>"}`;
    },
  },
  {
    id: "field-clear",
    handlerFamily: "wallet-mutation",
    supportsYes: true,
    supportsSatvb: true,
    aliases: [{ tokens: ["field", "clear"] }],
    helpEntries: [
      {
        usage: "field clear <domain> <field>",
        description: "Clear an existing anchored field value",
      },
    ],
    describeCommand(args) {
      return `cogcoin field clear ${args[0] ?? "<domain>"} ${args[1] ?? "<field>"}`;
    },
  },
  {
    id: "domain-endpoint-set",
    handlerFamily: "wallet-mutation",
    supportsYes: true,
    supportsSatvb: true,
    aliases: [{ tokens: ["domain", "endpoint", "set"] }],
    helpEntries: [],
    describeCommand(args) {
      return `cogcoin domain endpoint set ${args[0] ?? "<domain>"}`;
    },
  },
  {
    id: "domain-endpoint-clear",
    handlerFamily: "wallet-mutation",
    supportsYes: true,
    supportsSatvb: true,
    aliases: [{ tokens: ["domain", "endpoint", "clear"] }],
    helpEntries: [],
    describeCommand(args) {
      return `cogcoin domain endpoint clear ${args[0] ?? "<domain>"}`;
    },
  },
  {
    id: "domain-delegate-set",
    handlerFamily: "wallet-mutation",
    supportsYes: true,
    supportsSatvb: true,
    aliases: [{ tokens: ["domain", "delegate", "set"] }],
    helpEntries: [],
    describeCommand(args) {
      return `cogcoin domain delegate set ${args[0] ?? "<domain>"} ${args[1] ?? "<btc-target>"}`;
    },
  },
  {
    id: "domain-delegate-clear",
    handlerFamily: "wallet-mutation",
    supportsYes: true,
    supportsSatvb: true,
    aliases: [{ tokens: ["domain", "delegate", "clear"] }],
    helpEntries: [],
    describeCommand(args) {
      return `cogcoin domain delegate clear ${args[0] ?? "<domain>"}`;
    },
  },
  {
    id: "domain-miner-set",
    handlerFamily: "wallet-mutation",
    supportsYes: true,
    supportsSatvb: true,
    aliases: [{ tokens: ["domain", "miner", "set"] }],
    helpEntries: [],
    describeCommand(args) {
      return `cogcoin domain miner set ${args[0] ?? "<domain>"} ${args[1] ?? "<btc-target>"}`;
    },
  },
  {
    id: "domain-miner-clear",
    handlerFamily: "wallet-mutation",
    supportsYes: true,
    supportsSatvb: true,
    aliases: [{ tokens: ["domain", "miner", "clear"] }],
    helpEntries: [],
    describeCommand(args) {
      return `cogcoin domain miner clear ${args[0] ?? "<domain>"}`;
    },
  },
  {
    id: "domain-canonical",
    handlerFamily: "wallet-mutation",
    supportsYes: true,
    supportsSatvb: true,
    aliases: [{ tokens: ["domain", "canonical"] }],
    helpEntries: [],
    describeCommand(args) {
      return `cogcoin domain canonical ${args[0] ?? "<domain>"}`;
    },
  },
  {
    id: "rep-give",
    handlerFamily: "wallet-mutation",
    supportsYes: true,
    supportsSatvb: true,
    aliases: [{ tokens: ["rep", "give"] }],
    helpEntries: [
      {
        usage: "rep give <source-domain> <target-domain> <amount>",
        description: "Burn COG as anchored-domain reputation support",
      },
    ],
    describeCommand(args) {
      return `cogcoin rep give ${args[0] ?? "<source-domain>"} ${args[1] ?? "<target-domain>"} ${args[2] ?? "<amount>"}`;
    },
  },
  {
    id: "rep-revoke",
    handlerFamily: "wallet-mutation",
    supportsYes: true,
    supportsSatvb: true,
    aliases: [{ tokens: ["rep", "revoke"] }],
    helpEntries: [
      {
        usage: "rep revoke <source-domain> <target-domain> <amount>",
        description: "Revoke visible support without refunding burned COG",
      },
    ],
    describeCommand(args) {
      return `cogcoin rep revoke ${args[0] ?? "<source-domain>"} ${args[1] ?? "<target-domain>"} ${args[2] ?? "<amount>"}`;
    },
  },
  {
    id: "sync",
    handlerFamily: "sync",
    supportsYes: true,
    supportsSatvb: false,
    aliases: [{ tokens: ["sync"] }],
    helpEntries: [],
    describeCommand() {
      return "cogcoin sync";
    },
  },
  {
    id: "follow",
    handlerFamily: "follow",
    supportsYes: true,
    supportsSatvb: false,
    aliases: [{ tokens: ["follow"] }],
    helpEntries: [],
    describeCommand() {
      return "cogcoin follow";
    },
  },
] as const satisfies readonly CommandSpec[];

const removedPathSpecs = [
  { tokens: ["restore"], errorCode: "cli_restore_removed" },
  { tokens: ["wallet", "delete"], errorCode: "cli_wallet_delete_removed" },
  { tokens: ["wallet", "restore"], errorCode: "cli_wallet_restore_removed" },
  { tokens: ["wallet", "export"], errorCode: "cli_wallet_export_removed" },
  { tokens: ["wallet", "import"], errorCode: "cli_wallet_import_removed" },
  { tokens: ["anchor", "clear"], errorCode: "cli_anchor_clear_removed" },
  { tokens: ["domain", "anchor", "clear"], errorCode: "cli_anchor_clear_removed" },
] as const satisfies readonly RemovedPathSpec[];

const unknownPrefixSpecs = [
  { tokens: ["domain", "endpoint"], errorPrefix: "cli_unknown_command_domain_endpoint" },
  { tokens: ["domain", "delegate"], errorPrefix: "cli_unknown_command_domain_delegate" },
  { tokens: ["domain", "miner"], errorPrefix: "cli_unknown_command_domain_miner" },
  { tokens: ["wallet"], errorPrefix: "cli_unknown_command_wallet" },
  { tokens: ["bitcoin"], errorPrefix: "cli_unknown_command_bitcoin" },
  { tokens: ["client"], errorPrefix: "cli_unknown_command_client" },
  { tokens: ["indexer"], errorPrefix: "cli_unknown_command_indexer" },
  { tokens: ["mine"], errorPrefix: "cli_unknown_command_mine" },
  { tokens: ["domain"], errorPrefix: "cli_unknown_command_domain" },
  { tokens: ["cog"], errorPrefix: "cli_unknown_command_cog" },
  { tokens: ["rep"], errorPrefix: "cli_unknown_command_rep" },
] as const satisfies readonly UnknownPrefixSpec[];

const optionsSection = `Options:
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
  --satvb <n>       Override the mutation fee rate in sat/vB
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
  --progress <mode> Progress output mode: auto, tty, or none
  --force          Reserved for future use
  --force-race      Allow a visible root registration race
  --yes             Approve eligible plain yes/no mutation confirmations non-interactively
  --help            Show help
  --version         Show package version`;

const quickstartSection = `Quickstart:
  1. Run \`cogcoin init\` to create or restore a wallet.
  2. Run \`cogcoin sync\` to bootstrap assumeutxo and the managed Bitcoin/indexer state.
  3. Run \`cogcoin address\`, then fund the wallet with about 0.0015 BTC so you can buy a 6+ character domain to start mining and still keep BTC available for mining transaction fees.`;

const examplesSection = `Examples:
  cogcoin status
  cogcoin bitcoin status
  cogcoin indexer status
  cogcoin init
  cogcoin wallet address
  cogcoin domain list --mineable
  cogcoin register alpha-child
  cogcoin anchor alpha
  cogcoin register alpha --satvb 12.5
  cogcoin buy alpha
  cogcoin field set alpha bio --text "hello"
  cogcoin rep give alpha beta 10 --review "great operator"
  cogcoin mine setup
  cogcoin mine prompt
  cogcoin mine prompt alpha
  cogcoin register alpha-child
  cogcoin mine status`;

const commandSpecById = new Map<CommandName, CommandSpec>(
  commandSpecs.map((spec) => [spec.id, spec]),
);

const commandAliasEntries = commandSpecs.flatMap((spec) => spec.aliases.map((alias) => ({
  command: spec.id,
  tokens: alias.tokens,
  matchMode: (alias as CommandAlias).matchMode ?? "always",
}))).sort((left, right) => right.tokens.length - left.tokens.length);

function matchesTokens(argv: readonly string[], startIndex: number, tokens: readonly string[]): boolean {
  for (let offset = 0; offset < tokens.length; offset += 1) {
    if (argv[startIndex + offset] !== tokens[offset]) {
      return false;
    }
  }

  return true;
}

function nextTokenAfterMatch(
  argv: readonly string[],
  startIndex: number,
  tokens: readonly string[],
): string | null {
  return argv[startIndex + tokens.length] ?? null;
}

function aliasMatches(
  argv: readonly string[],
  startIndex: number,
  alias: { tokens: readonly string[]; matchMode: AliasMatchMode },
): boolean {
  if (!matchesTokens(argv, startIndex, alias.tokens)) {
    return false;
  }

  const nextToken = nextTokenAfterMatch(argv, startIndex, alias.tokens);

  switch (alias.matchMode) {
    case "always":
      return true;
    case "requires-arg":
      return nextToken !== null && !nextToken.startsWith("--");
    case "end-or-flag":
      return nextToken === null || nextToken.startsWith("--");
    default:
      return false;
  }
}

export function getCommandSpec(command: CommandName | null): CommandSpec | null {
  return command === null ? null : (commandSpecById.get(command) ?? null);
}

export function resolveCommandMatch(argv: readonly string[], startIndex: number): CommandMatch | null {
  for (const removed of removedPathSpecs) {
    if (matchesTokens(argv, startIndex, removed.tokens)) {
      throw new Error(removed.errorCode);
    }
  }

  for (const alias of commandAliasEntries) {
    if (!aliasMatches(argv, startIndex, alias)) {
      continue;
    }

    return {
      command: alias.command,
      consumedTokens: alias.tokens.length,
      invokedTokens: alias.tokens,
    };
  }

  return null;
}

export function resolveUnknownCommandError(argv: readonly string[], startIndex: number): string {
  for (const prefix of unknownPrefixSpecs) {
    if (!matchesTokens(argv, startIndex, prefix.tokens)) {
      continue;
    }

    const nextToken = argv[startIndex + prefix.tokens.length] ?? null;
    return `${prefix.errorPrefix}${nextToken === null ? "" : `_${nextToken}`}`;
  }

  return `cli_unknown_command_${argv[startIndex] ?? ""}`;
}

export function getCommandHandlerFamily(command: CommandName | null): CommandHandlerFamily | null {
  return getCommandSpec(command)?.handlerFamily ?? null;
}

export function commandSupportsYesFlag(command: CommandName | null): boolean {
  return getCommandSpec(command)?.supportsYes ?? false;
}

export function commandSupportsSatvb(command: CommandName | null): boolean {
  return getCommandSpec(command)?.supportsSatvb ?? false;
}

export function describeCanonicalCommandFromArgs(
  command: CommandName | null,
  args: readonly string[],
  options: { follow: boolean } = { follow: false },
): string {
  const spec = getCommandSpec(command);

  if (spec === null) {
    return command === null ? "cogcoin" : `cogcoin ${command.replaceAll("-", " ")}`;
  }

  return spec.describeCommand(args, options);
}

export function renderHelpText(): string {
  const commandLines = commandSpecs.flatMap((spec) => spec.helpEntries.map((entry) => {
    const paddedUsage = entry.usage.padEnd(24, " ");
    const gap = entry.usage.length >= 24 ? " " : "";
    return `  ${paddedUsage}${gap}${entry.description}`;
  }));

  return [
    "Usage: cogcoin <command> [options]",
    "",
    "Commands:",
    ...commandLines,
    "",
    optionsSection,
    "",
    quickstartSection,
    "",
    examplesSection,
  ].join("\n");
}

export function listCommandSpecsForTesting(): readonly CommandSpec[] {
  return commandSpecs;
}
