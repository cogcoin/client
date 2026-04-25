import { readPackageVersionFromDisk } from "../package-version.js";
import { loadBundledGenesisParameters } from "@cogcoin/indexer";
import { resolveManagedServicePaths, UNINITIALIZED_WALLET_ROOT_ID } from "./service-paths.js";
import { createIndexerDaemonRuntime } from "./indexer-daemon/runtime.js";

function parseArg(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));

  if (!value) {
    throw new Error(`indexer_daemon_missing_arg_${name}`);
  }

  return value.slice(prefix.length);
}

async function main(): Promise<void> {
  const dataDir = parseArg("data-dir");
  const databasePath = parseArg("database-path");
  const walletRootId = parseArg("wallet-root-id") || UNINITIALIZED_WALLET_ROOT_ID;
  const paths = resolveManagedServicePaths(dataDir, walletRootId);
  const runtime = createIndexerDaemonRuntime({
    dataDir,
    databasePath,
    walletRootId,
    paths,
    binaryVersion: await readPackageVersionFromDisk().catch(() => "0.0.0"),
    genesisParameters: await loadBundledGenesisParameters(),
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    await runtime.shutdown().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });

  await runtime.start();
}

await main();
