# `@cogcoin/client`

`@cogcoin/client@1.1.4` is the reference Cogcoin client package for applications that want a local wallet, durable SQLite-backed state, and a managed Bitcoin Core integration around `@cogcoin/indexer`. It publishes the reusable client APIs, the SQLite adapter, the managed `bitcoind` integration, and the first-party `cogcoin` CLI in one package.

Use Node 22 or newer.

## Quick Start

Install the package:

```bash
npm install -g @cogcoin/client
cogcoin init
cogcoin address  # Send 0.0015 BTC to address
cogcoin register <domainname> # 6+ character domain for 0.001 BTC
cogcoin anchor <domainname> # You can leave a founding message permanently on Bitcoin!
cogcoin mine setup
cogcoin mine # Use remaining ~0.0005 BTC for mining tx, ~1000 sats per entry (0.00001 BTC)
```

## Preview

```bash

     ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
   ▄▀                  ▀▄
   █  ▄▀▀▀▀▀▀▀▀▀▀▀▀▀▀▄  █    Welcome to...
   █  █              █  █
   █  █   █   █  █   █  █     █████  █████   █████   █████  █████  ██ ███    ██
   █  █       █      █  █    ██     ██   ██ ██      ██     ██   ██ ██ ████   ██
   █  █      ▄█      █  █    ██     ██   ██ ██  ███ ██     ██   ██ ██ ██ ██  ██
   █  █    ▄    ▄    █  █    ██     ██   ██ ██   ██ ██     ██   ██ ██ ██  ██ ██
   █  █     ▀▀▀▀     █  █     █████  █████   █████   █████  █████  ██ ██   ████
   █  ▀▄▄▄▄▄▄▄▄▄▄▄▄▄▄▀  █
   █                    █        ┏┳┓╻┏┓╻┏━╸   ╻ ╻╻╺┳╸╻ ╻   ╻ ╻┏━┓┏━┓╺┳┓┏━┓    
   █                    █        ┃┃┃┃┃┗┫┣╸    ┃╻┃┃ ┃ ┣━┫   ┃╻┃┃ ┃┣┳┛ ┃┃┗━┓
   █   ▄▄      ▄▄▄▄▄▄   █        ╹ ╹╹╹ ╹┗━╸   ┗┻┛╹ ╹ ╹ ╹   ┗┻┛┗━┛╹┗╸╺┻┛┗━┛
   █                    █
   ▀▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▀            We are so happy to have you here!        
    █▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄█


```

```bash
                            ⛭ Behold, your Cogcoin wallet. ⛭                    
▐▀▀▀▀▀▀▀▀▚  ╔──────────────────────────────────────────────────────────────────╗
▛▞▀▀▀▀▀▀▀▀▚ │                                                                  │
▌▝▀▀▀▀▀▀▀▀▀▌│ Funding address: bc1qsamplewallet0000000000000000000000000      │
▌   ▗▙▙    ▌│                                                                  │
▌   ▐  ▌   ▌│ Bitcoin Balance: 0.00150000 BTC                                  │
▌   ▐▀▀▚   ▌│ Cogcoin Balance: 12.50000000 COG                                 │
▌   ▐▄▄▞   ▌│                                                                  │
▌    ▘▘    ▌│ mempool.space/address/bc1qsamplewallet0000000000000000000000000 |
▝▀▀▀▀▀▀▀▀▀▀▘╚──────────────────────────────────────────────────────────────────╝

Anchored Domains
⌂ cogdemo

Unanchored Domains
--- No unanchored domains ---
```

```bash
 _____                                                                    _____ 
( ___ ) 12.500 COG            ⛭  C O G C O I N  ⛭             150000 SAT ( ___ )
 |   |~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~|   | 
 |   |                                                                    |   | 
 |   |                                                                    |   | 
 |   |                              945516  945515  945514  945513  945512|   | 
 |   |_|"""""|                     _|"""""|_|"""""|_|"""""|_|"""""|_|"""""|   | 
 |   |"`-0-0-'                     "`-0-0-'"`-0-0-'"`-0-0-'"`-0-0-'"`-0-0-|   | 
 |   | ~10 min                                                            |   | 
 |   |                                                                    |   | 
 |   |                                                                    |   | 
 |___|~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~|___| 
(_____)                       Waiting for indexer                        (_____)

[░░░░░░░░░░░░░░░░████] Mining is waiting for Bitcoin Core and the indexer to align.
Required words: OWNER, OLYMPIC, ERODE, DESK, DIFFER
@cogdemo: By the desk, the owner observed that Olympic lettering could erode over time, though experts differ.
```

## Links

- Website: [cogcoin.org](https://cogcoin.org)
- Whitepaper: [cogcoin.org/whitepaper.md](https://cogcoin.org/whitepaper.md)
- Source: [github.com/cogcoin/client](https://github.com/cogcoin/client)
- Bitcoin package: [npmjs.com/package/@cogcoin/bitcoin](https://www.npmjs.com/package/@cogcoin/bitcoin)
- Genesis package: [npmjs.com/package/@cogcoin/genesis](https://www.npmjs.com/package/@cogcoin/genesis)
- Indexer package: [npmjs.com/package/@cogcoin/indexer](https://www.npmjs.com/package/@cogcoin/indexer)
- Scoring package: [npmjs.com/package/@cogcoin/scoring](https://www.npmjs.com/package/@cogcoin/scoring)

## Dependency Surface

The published package depends on:

- `@cogcoin/bitcoin@30.2.0`
- `@cogcoin/genesis@1.0.0`
- `@cogcoin/indexer@1.0.1`
- `@cogcoin/scoring@1.0.0`
- `@scure/base@^2.0.0`
- `@scure/bip32@^2.0.1`
- `@scure/bip39@^2.0.1`
- `better-sqlite3@12.8.0`
- `hash-wasm@^4.12.0`
- `zeromq@6.5.0`

`@cogcoin/vectors` is kept as a repository development dependency for conformance tests and is not part of the published runtime dependency surface.

## API

Root package:

- `openClient(options)`
- `createClientStoreAdapter(store)`

SQLite subpath:

- `@cogcoin/client/sqlite`
- `openSqliteStore(options)`
- `migrateSqliteStore(database)`

Managed node subpath:

- `@cogcoin/client/bitcoind`
- `openManagedBitcoindClient(options)`

## CLI

The installed `cogcoin` command covers the first-party local wallet and node workflow:

- update commands such as `update` to compare the current CLI version with the latest npm release and install it
- wallet lifecycle commands such as `init`, `reset`, `wallet show-mnemonic`, and `repair`
- sync and service commands such as `status`, `sync`, `follow`, `bitcoin start`, `bitcoin stop`, `bitcoin status`, `indexer start`, `indexer stop`, and `indexer status`
- domain and field commands such as `register`, `anchor`, `show`, `domains`, `fields`, `buy`, `sell`, and `transfer`
- COG and reputation commands such as `send`, `cog lock`, `claim`, `reclaim`, `rep give`, and `rep revoke`
- mining commands such as `mine`, `mine start`, `mine stop`, `mine status`, `mine log`, `mine setup`, `mine prompt`, and `mine prompt list`

The CLI also supports stable `--output json` and `--output preview-json` envelopes on the commands that advertise machine-readable output.
Use `cogcoin mine prompt <domain>` to set or clear a per-domain mining prompt override for one anchored root domain, and `cogcoin mine prompt list` to inspect the current per-domain prompt state alongside the global fallback prompt.
Interactive text invocations periodically check the npm registry for newer `@cogcoin/client` releases and print `npm install -g @cogcoin/client` when a newer version is available.
Set `COGCOIN_DISABLE_UPDATE_CHECK=1` to disable the CLI update notice entirely.
Ordinary `sync`, `follow`, and wallet-aware read/status flows detach from the managed Bitcoin and indexer services on exit instead of stopping them.
Use the explicit `bitcoin ...` and `indexer ...` commands when you want direct service inspection or start/stop control.
For provider-backed local wallets, normal reads, mutations, and mining setup flows load local wallet state on demand whenever the local secret provider is available.
When no wallet exists yet, `cogcoin init` interactively lets you either create a new wallet or restore an existing one from a 24-word English BIP39 mnemonic, then continues into sync.
To replace an existing wallet with a different mnemonic, run `cogcoin reset`, choose `clear wallet entropy`, and then rerun `cogcoin init`.

## SQLite Store

The built-in SQLite adapter persists opaque indexer bytes rather than protocol tables:

- serialized `IndexerState`
- serialized `BlockRecord`
- current tip metadata
- periodic checkpoints

This keeps correctness tied to `@cogcoin/indexer` rather than duplicating protocol state in SQL.

## Managed `bitcoind`

The built-in managed-node integration:

- resolves Bitcoin Core binaries through `@cogcoin/bitcoin`
- uses RPC for durable reads and ZMQ `hashblock` notifications for tip following
- launches a local full node with cookie auth
- defaults to an assumeutxo-first mainnet bootstrap using `https://snapshots.cogcoin.org/utxo-910000.dat`
- opportunistically loads the public getblock range family from `https://snapshots.cogcoin.org/getblock-manifest.json` plus immutable `getblock-<first>-<last>.dat` bands to accelerate post-`910000` Bitcoin Core catch-up
- composes the existing SQLite-backed client rather than replacing it

If `dataDir` is omitted, the managed node defaults to:

- macOS: `~/Library/Application Support/Cogcoin/bitcoin`
- Linux: `~/.cogcoin/bitcoin`
- Windows: `%APPDATA%\\Cogcoin\\bitcoin`

On a fresh mainnet managed sync, `syncToTip()` or `startFollowingTip()`:

1. downloads the pinned Cogcoin UTXO snapshot with resume support
2. validates its known size and SHA-256
3. loads it with Bitcoin Core assumeutxo
4. opportunistically checks for the next published 500-block getblock band at each post-snapshot boundary
5. downloads, validates, and loads that range into managed Bitcoin Core when available
6. syncs Cogcoin through that range, deletes the consumed local band cache, and repeats for the next boundary
7. falls back to ordinary Bitcoin sync and Cogcoin replay once no further published range exists

The public getblock range provenance is tracked in the companion scraper repository:

- [`github.com/cogcoin/bitcoin-scrape`](https://github.com/cogcoin/bitcoin-scrape)

That repo documents how `getblock-manifest.json` and immutable files such as `getblock-910001-910500.dat` and `getblock-910501-911000.dat` are assembled from `bitcoin-cli getblockhash` plus `bitcoin-cli getblock <hash> 0`, including the blk-style file layout, range manifest format, durability guarantees, and publish order.

The managed `bitcoind` client also exposes:

- `onProgress(event)` for structured bootstrap/sync progress updates
- `progressOutput: "auto" | "tty" | "none"` for the built-in scroll-train terminal progress UI

At the CLI layer, managed services are persistent until explicitly stopped.
`cogcoin bitcoin start` starts managed `bitcoind`, `cogcoin bitcoin stop` stops managed `bitcoind` and the paired indexer, `cogcoin indexer start` starts the managed indexer and auto-starts `bitcoind` first when needed, and `cogcoin indexer stop` stops only the indexer.

The default TTY progress renderer ships with the package and uses the bundled scroll, train, and quote assets from `dist/art/*` and `dist/writing_quotes.json`.

## Published Contents

- `dist/index.js`: public package entrypoint
- `dist/index.d.ts`: bundled type declarations
- `dist/cli.js`: installed `cogcoin` command
- `dist/bitcoind/index.js`: managed `bitcoind` subpath
- `dist/bitcoind/index.d.ts`: managed `bitcoind` declarations
- `dist/sqlite/index.js`: SQLite adapter subpath
- `dist/sqlite/index.d.ts`: SQLite adapter declarations
- `dist/writing_quotes.json`: bundled progress UI quote dataset
- `dist/art/*`: bundled terminal progress artwork
- `dist/*`: compiled ESM implementation
- `README.md`: package guide
- `LICENSE`: MIT license text
