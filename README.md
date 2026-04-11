# `@cogcoin/client`

`@cogcoin/client@0.5.1` is the store-backed Cogcoin client package for applications that want a local wallet, durable SQLite-backed state, and a managed Bitcoin Core integration around `@cogcoin/indexer`. It publishes the reusable client APIs, the SQLite adapter, the managed `bitcoind` integration, and the first-party `cogcoin` CLI in one package.

Use Node 24.7.0 or newer.

## Links

- Website: [cogcoin.org](https://cogcoin.org)
- Whitepaper: [cogcoin.org/whitepaper.md](https://cogcoin.org/whitepaper.md)
- Source: [github.com/cogcoin/client](https://github.com/cogcoin/client)
- Bitcoin package: [npmjs.com/package/@cogcoin/bitcoin](https://www.npmjs.com/package/@cogcoin/bitcoin)
- Genesis package: [npmjs.com/package/@cogcoin/genesis](https://www.npmjs.com/package/@cogcoin/genesis)
- Indexer package: [npmjs.com/package/@cogcoin/indexer](https://www.npmjs.com/package/@cogcoin/indexer)
- Scoring package: [npmjs.com/package/@cogcoin/scoring](https://www.npmjs.com/package/@cogcoin/scoring)

## Quick Start

Install the package:

```bash
npm install @cogcoin/client
```

Then, from your project root, run:

```bash
node node_modules/@cogcoin/genesis/verify.mjs
npx cogcoin init
npx cogcoin sync
```

Verify the installed genesis artifacts before using the client in a production implementation.
The installed package provides the `cogcoin` command for local wallet setup, sync, reads, writes, and mining workflows.

## Dependency Surface

The published package depends on:

- `@cogcoin/bitcoin@30.2.0`
- `@cogcoin/genesis@1.0.0`
- `@cogcoin/indexer@1.0.0`
- `@cogcoin/scoring@1.0.0`
- `@scure/base@^2.0.0`
- `@scure/bip32@^2.0.1`
- `@scure/bip39@^2.0.1`
- `better-sqlite3@12.8.0`
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

- wallet lifecycle commands such as `init`, `unlock`, `lock`, `repair`, `export`, and `import`
- sync and service commands such as `status`, `sync`, and `follow`
- domain and field commands such as `register`, `anchor`, `show`, `domains`, `fields`, `buy`, `sell`, and `transfer`
- COG and reputation commands such as `send`, `cog lock`, `claim`, `reclaim`, `rep give`, and `rep revoke`
- mining and hook commands such as `mine`, `mine start`, `mine stop`, `mine status`, `mine log`, `mine setup`, and `hooks status`

The CLI also supports stable `--output json` and `--output preview-json` envelopes on the commands that advertise machine-readable output.

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
- composes the existing SQLite-backed client rather than replacing it

If `dataDir` is omitted, the managed node defaults to:

- macOS: `~/Library/Application Support/Cogcoin/bitcoin`
- Linux: `~/.cogcoin/bitcoin`
- Windows: `%APPDATA%\\Cogcoin\\bitcoin`

On a fresh mainnet managed sync, `syncToTip()` or `startFollowingTip()`:

1. downloads the pinned Cogcoin UTXO snapshot with resume support
2. validates its known size and SHA-256
3. loads it with Bitcoin Core assumeutxo
4. continues Bitcoin sync and Cogcoin replay from the managed node until the live tip is caught up

The managed `bitcoind` client also exposes:

- `onProgress(event)` for structured bootstrap/sync progress updates
- `progressOutput: "auto" | "tty" | "none"` for the built-in scroll-train terminal progress UI

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
