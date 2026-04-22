import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { resolveManagedBitcoindRuntimeConfig } from "../src/bitcoind/managed-bitcoind-service-config.js";
import {
  createManagedWalletReplica,
  getManagedBitcoindWalletReplicaName,
  loadManagedWalletReplicaIfPresent,
} from "../src/bitcoind/managed-bitcoind-service-replica.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";

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
