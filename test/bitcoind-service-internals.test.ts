import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { resolveManagedServicePaths } from "../src/bitcoind/service-paths.js";
import {
  createManagedBitcoindRuntimeConfigFilePayload,
  createManagedBitcoindRuntimeConfigFilePayloadFromStatus,
  resolveManagedBitcoindRuntimeConfig,
  writeManagedBitcoindRuntimeConfigFile,
  writeManagedBitcoindRuntimeConfigFileFromStatus,
} from "../src/bitcoind/managed-bitcoind-service-config.js";
import { readJsonFileIfPresent } from "../src/bitcoind/managed-runtime/status.js";
import {
  createManagedWalletReplica,
  getManagedBitcoindWalletReplicaName,
  loadManagedWalletReplicaIfPresent,
} from "../src/bitcoind/managed-bitcoind-service-replica.js";
import { writeManagedBitcoindStatus } from "../src/bitcoind/managed-bitcoind-service-status.js";
import type { ManagedBitcoindServiceStatus } from "../src/bitcoind/types.js";
import { writeJsonFileAtomic } from "../src/wallet/fs/atomic.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";

function createManagedBitcoindServiceStatus(
  root: string,
  overrides: Partial<ManagedBitcoindServiceStatus> = {},
): ManagedBitcoindServiceStatus {
  return {
    serviceApiVersion: "cogcoin/bitcoind-service/v1",
    binaryVersion: "30.2.0",
    buildId: null,
    serviceInstanceId: "service-instance",
    state: "ready",
    processId: 1234,
    walletRootId: "wallet-root-test",
    chain: "main",
    dataDir: root,
    runtimeRoot: join(root, "runtime", "managed"),
    startHeight: 0,
    rpc: {
      url: "http://127.0.0.1:18443",
      cookieFile: join(root, ".cookie"),
      port: 18443,
    },
    zmq: {
      endpoint: "tcp://127.0.0.1:28332",
      topic: "hashblock",
      port: 28332,
      pollIntervalMs: 2_000,
    },
    p2pPort: 18444,
    getblockArchiveEndHeight: null,
    getblockArchiveSha256: null,
    walletReplica: null,
    startedAtUnixMs: 1_700_000_000_000,
    heartbeatAtUnixMs: 1_700_000_000_100,
    updatedAtUnixMs: 1_700_000_000_100,
    lastError: null,
    ...overrides,
  };
}

test("resolveManagedBitcoindRuntimeConfig reuses ports from prior managed status", async (t) => {
  const root = await createTrackedTempDirectory(t, "cogcoin-managed-bitcoind-config");
  const statusPath = join(root, "bitcoind-status.json");
  const configPath = join(root, "bitcoind-runtime-config.json");

  await writeFile(statusPath, `${JSON.stringify({
    rpc: {
      url: "http://127.0.0.1:18443",
      cookieFile: join(root, ".cookie"),
      port: 18443,
    },
    zmq: {
      endpoint: "tcp://127.0.0.1:28332",
      topic: "hashblock",
      port: 28332,
      pollIntervalMs: 2_000,
    },
    p2pPort: 18444,
  }, null, 2)}\n`, "utf8");
  await writeFile(configPath, `${JSON.stringify({
    rpc: {
      url: "http://127.0.0.1:9999",
      cookieFile: join(root, ".cookie"),
      port: 9999,
    },
    zmqPort: 9998,
    p2pPort: 9997,
  }, null, 2)}\n`, "utf8");

  const runtimeConfig = await resolveManagedBitcoindRuntimeConfig(statusPath, configPath, {
    dataDir: root,
    chain: "main",
    startHeight: 0,
  });

  assert.equal(runtimeConfig.rpc.port, 18443);
  assert.equal(runtimeConfig.zmqPort, 28332);
  assert.equal(runtimeConfig.p2pPort, 18444);
  assert.equal(runtimeConfig.rpc.cookieFile, join(root, ".cookie"));
});

test("writeManagedBitcoindRuntimeConfigFile persists the expected payload and skips identical rewrites", async (t) => {
  const root = await createTrackedTempDirectory(t, "cogcoin-managed-bitcoind-runtime-config");
  const configPath = join(root, "bitcoind-config.json");
  const runtimeConfig = {
    chain: "main" as const,
    rpc: {
      url: "http://127.0.0.1:18443",
      cookieFile: join(root, ".cookie"),
      port: 18443,
    },
    zmqPort: 28332,
    p2pPort: 18444,
    dbcacheMiB: 1024,
    getblockArchiveEndHeight: 123,
    getblockArchiveSha256: "aa".repeat(32),
  };
  let writes = 0;

  await writeManagedBitcoindRuntimeConfigFile(configPath, runtimeConfig, {
    readJsonFileIfPresent,
    writeJsonFileAtomic: async (filePath, value, options) => {
      writes += 1;
      await writeJsonFileAtomic(filePath, value, options);
    },
  });
  await writeManagedBitcoindRuntimeConfigFile(configPath, runtimeConfig, {
    readJsonFileIfPresent,
    writeJsonFileAtomic: async (filePath, value, options) => {
      writes += 1;
      await writeJsonFileAtomic(filePath, value, options);
    },
  });

  assert.equal(writes, 1);
  assert.deepEqual(
    JSON.parse(await readFile(configPath, "utf8")),
    createManagedBitcoindRuntimeConfigFilePayload(runtimeConfig),
  );
});

test("writeManagedBitcoindRuntimeConfigFile rewrites when the runtime config changes", async (t) => {
  const root = await createTrackedTempDirectory(t, "cogcoin-managed-bitcoind-runtime-config-rewrite");
  const configPath = join(root, "bitcoind-config.json");
  const firstConfig = {
    chain: "main" as const,
    rpc: {
      url: "http://127.0.0.1:18443",
      cookieFile: join(root, ".cookie"),
      port: 18443,
    },
    zmqPort: 28332,
    p2pPort: 18444,
    dbcacheMiB: 1024,
    getblockArchiveEndHeight: null,
    getblockArchiveSha256: null,
  };
  const secondConfig = {
    ...firstConfig,
    rpc: {
      ...firstConfig.rpc,
      port: 18445,
      url: "http://127.0.0.1:18445",
    },
  };
  let writes = 0;

  const dependencies = {
    readJsonFileIfPresent,
    writeJsonFileAtomic: async (filePath: string, value: unknown, options?: { mode?: number; encoding?: BufferEncoding }) => {
      writes += 1;
      await writeJsonFileAtomic(filePath, value, options);
    },
  };

  await writeManagedBitcoindRuntimeConfigFile(configPath, firstConfig, dependencies);
  await writeManagedBitcoindRuntimeConfigFile(configPath, secondConfig, dependencies);

  assert.equal(writes, 2);
  assert.deepEqual(
    JSON.parse(await readFile(configPath, "utf8")),
    createManagedBitcoindRuntimeConfigFilePayload(secondConfig),
  );
});

test("writeManagedBitcoindRuntimeConfigFileFromStatus persists the expected payload and skips identical rewrites", async (t) => {
  const root = await createTrackedTempDirectory(t, "cogcoin-managed-bitcoind-status-runtime-config");
  const configPath = join(root, "bitcoind-config.json");
  const status = createManagedBitcoindServiceStatus(root, {
    chain: "regtest",
    rpc: {
      url: "http://127.0.0.1:18443",
      cookieFile: join(root, "regtest", ".cookie"),
      port: 18443,
    },
    zmq: {
      endpoint: "tcp://127.0.0.1:28332",
      topic: "hashblock",
      port: 28332,
      pollIntervalMs: 2_000,
    },
    p2pPort: 18444,
    getblockArchiveEndHeight: 456,
    getblockArchiveSha256: "bb".repeat(32),
  });
  let writes = 0;

  const dependencies = {
    readJsonFileIfPresent,
    writeJsonFileAtomic: async (filePath: string, value: unknown, options?: { mode?: number; encoding?: BufferEncoding }) => {
      writes += 1;
      await writeJsonFileAtomic(filePath, value, options);
    },
  };

  await writeManagedBitcoindRuntimeConfigFileFromStatus(configPath, status, dependencies);
  await writeManagedBitcoindRuntimeConfigFileFromStatus(configPath, status, dependencies);

  assert.equal(writes, 1);
  assert.deepEqual(
    JSON.parse(await readFile(configPath, "utf8")),
    createManagedBitcoindRuntimeConfigFilePayloadFromStatus(status),
  );
});

test("writeManagedBitcoindStatus does not rewrite bitcoind runtime config", async (t) => {
  const root = await createTrackedTempDirectory(t, "cogcoin-managed-bitcoind-status-config");
  const walletRootId = "wallet-root-test";
  const paths = resolveManagedServicePaths(root, walletRootId);
  const existingConfig = {
    chain: "main",
    rpc: {
      url: "http://127.0.0.1:9999",
      cookieFile: join(root, ".cookie"),
      port: 9999,
    },
    zmqPort: 9998,
    p2pPort: 9997,
    getblockArchiveEndHeight: null,
    getblockArchiveSha256: null,
  };

  await mkdir(paths.walletRuntimeRoot, { recursive: true });
  await writeFile(paths.bitcoindRuntimeConfigPath, `${JSON.stringify(existingConfig, null, 2)}\n`, "utf8");
  await writeManagedBitcoindStatus(paths, createManagedBitcoindServiceStatus(root, {
    walletRootId,
  }));

  assert.deepEqual(
    JSON.parse(await readFile(paths.bitcoindRuntimeConfigPath, "utf8")),
    existingConfig,
  );
});

test("loadManagedWalletReplicaIfPresent reports missing when the managed wallet replica is absent", async (t) => {
  const root = await createTrackedTempDirectory(t, "cogcoin-managed-wallet-replica-missing");
  const status = await loadManagedWalletReplicaIfPresent({
    listWallets: async () => [],
    loadWallet: async () => {
      throw new Error("bitcoind_rpc_loadwallet_-18_wallet_not_found");
    },
    createWallet: async () => {
      throw new Error("should_not_create_wallet");
    },
    getWalletInfo: async () => {
      throw new Error("should_not_get_wallet_info");
    },
    walletLock: async () => null,
  }, "wallet-root", root);

  assert.equal(status.walletName, getManagedBitcoindWalletReplicaName("wallet-root"));
  assert.equal(status.proofStatus, "missing");
  assert.match(status.message ?? "", /replica is missing/i);
});

test("loadManagedWalletReplicaIfPresent reports on-disk but unloaded replicas distinctly", async (t) => {
  const root = await createTrackedTempDirectory(t, "cogcoin-managed-wallet-replica-on-disk");
  await mkdir(join(root, "wallets", getManagedBitcoindWalletReplicaName("wallet-root")), { recursive: true });

  const status = await loadManagedWalletReplicaIfPresent({
    listWallets: async () => [],
    loadWallet: async () => {
      throw new Error("bitcoind_rpc_loadwallet_-18_wallet_not_found");
    },
    createWallet: async () => {
      throw new Error("should_not_create_wallet");
    },
    getWalletInfo: async () => {
      throw new Error("should_not_get_wallet_info");
    },
    walletLock: async () => null,
  }, "wallet-root", root);

  assert.equal(status.proofStatus, "missing");
  assert.match(status.message ?? "", /exists on disk but is not loaded/i);
});

test("loadManagedWalletReplicaIfPresent reports descriptor-wallet mismatches", async () => {
  const walletName = getManagedBitcoindWalletReplicaName("wallet-root");
  const status = await loadManagedWalletReplicaIfPresent({
    listWallets: async () => [walletName],
    loadWallet: async () => ({ name: walletName, warning: "" }),
    createWallet: async () => {
      throw new Error("should_not_create_wallet");
    },
    getWalletInfo: async () => ({
      descriptors: false,
      private_keys_enabled: true,
    }),
    walletLock: async () => null,
  }, "wallet-root", "/unused");

  assert.equal(status.proofStatus, "mismatch");
  assert.match(status.message ?? "", /encrypted descriptor wallet/i);
});

test("createManagedWalletReplica creates and locks a missing managed wallet replica", async () => {
  const walletName = getManagedBitcoindWalletReplicaName("wallet-root");
  const created: Array<{ walletName: string; passphrase: string }> = [];
  let walletLockCalls = 0;

  const status = await createManagedWalletReplica({
    listWallets: async () => [],
    loadWallet: async () => {
      throw new Error("bitcoind_rpc_loadwallet_-18_wallet_not_found");
    },
    createWallet: async (nextWalletName, options) => {
      created.push({
        walletName: nextWalletName,
        passphrase: options.passphrase,
      });
    },
    getWalletInfo: async () => ({
      descriptors: true,
      private_keys_enabled: true,
    }),
    walletLock: async () => {
      walletLockCalls += 1;
      return null;
    },
  }, "wallet-root", {
    managedWalletPassphrase: "managed-passphrase",
  });

  assert.equal(status.walletName, walletName);
  assert.equal(status.created, true);
  assert.equal(status.proofStatus, "not-proven");
  assert.deepEqual(created, [{
    walletName,
    passphrase: "managed-passphrase",
  }]);
  assert.equal(walletLockCalls, 1);
});
