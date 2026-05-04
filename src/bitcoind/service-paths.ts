import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolveCogcoinPathsForTesting, resolveDefaultBitcoindDataDirForTesting } from "../app-paths.js";

export const UNINITIALIZED_WALLET_ROOT_ID = "wallet-root-uninitialized";

export interface ManagedServicePaths {
  dataRoot: string;
  runtimeRoot: string;
  walletRuntimeRoot: string;
  bitcoindLockPath: string;
  bitcoindStatusPath: string;
  bitcoindPidPath: string;
  bitcoindReadyPath: string;
  bitcoindRuntimeConfigPath: string;
  bitcoindWalletStatusPath: string;
  bitcoinConfPath: string;
  indexerRoot: string;
  indexerServiceRoot: string;
  indexerDaemonLockPath: string;
  indexerDaemonStatusPath: string;
  indexerDaemonSocketPath: string;
  indexerDaemonLogPath: string;
}

function createDataDirSuffix(dataDir: string): string {
  return createHash("sha256").update(dataDir).digest("hex").slice(0, 12);
}

function resolveIndexerDaemonSocketPath(serviceRootId: string): string {
  const socketId = createHash("sha256").update(serviceRootId).digest("hex").slice(0, 20);

  if (process.platform === "win32") {
    return `\\\\.\\pipe\\cogcoin-indexer-${socketId}`;
  }

  return join(tmpdir(), `cogcoin-indexer-${socketId}.sock`);
}

export function resolveManagedServicePaths(
  dataDir: string,
  walletRootId = UNINITIALIZED_WALLET_ROOT_ID,
): ManagedServicePaths {
  const defaultPaths = resolveCogcoinPathsForTesting();
  const defaultBitcoindDataDir = resolveDefaultBitcoindDataDirForTesting();
  const useDefaultRoots = dataDir === defaultBitcoindDataDir;
  const dataRoot = useDefaultRoots ? defaultPaths.dataRoot : dirname(dataDir);
  const runtimeRoot = useDefaultRoots ? defaultPaths.runtimeRoot : join(dataRoot, "runtime");
  const indexerRoot = useDefaultRoots ? defaultPaths.indexerRoot : join(dataRoot, "indexer");
  const serviceRootId = useDefaultRoots
    ? "managed"
    : `managed-${createDataDirSuffix(dataDir)}`;
  const walletRuntimeRoot = join(runtimeRoot, serviceRootId);
  const indexerServiceRoot = join(indexerRoot, serviceRootId);

  return {
    dataRoot,
    runtimeRoot,
    walletRuntimeRoot,
    bitcoindLockPath: join(walletRuntimeRoot, "bitcoind.lock"),
    bitcoindStatusPath: join(walletRuntimeRoot, "bitcoind-status.json"),
    bitcoindPidPath: join(walletRuntimeRoot, "bitcoind.pid"),
    bitcoindReadyPath: join(walletRuntimeRoot, "bitcoind.ready"),
    bitcoindRuntimeConfigPath: join(walletRuntimeRoot, "bitcoind-config.json"),
    bitcoindWalletStatusPath: join(walletRuntimeRoot, "bitcoind-wallet.json"),
    bitcoinConfPath: join(dataDir, "bitcoin.conf"),
    indexerRoot,
    indexerServiceRoot,
    indexerDaemonLockPath: join(walletRuntimeRoot, "indexer-daemon.lock"),
    indexerDaemonStatusPath: join(indexerServiceRoot, "status.json"),
    indexerDaemonSocketPath: resolveIndexerDaemonSocketPath(serviceRootId),
    indexerDaemonLogPath: join(indexerServiceRoot, "daemon.log"),
  };
}
