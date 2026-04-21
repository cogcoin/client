import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildAddressJson, buildIdsJson, buildStatusJson } from "../src/cli/read-json.js";
import { formatWalletOverviewReport } from "../src/cli/wallet-format.js";
import { deriveNodeHealthForTesting } from "../src/wallet/read/context.js";
import { normalizeListPage } from "../src/cli/output.js";
import { inspectWalletLocalState } from "../src/wallet/read/index.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  createDefaultWalletSecretProviderForTesting,
  createMemoryWalletSecretProviderForTesting,
  createWalletSecretReference,
  lockClientPassword,
} from "../src/wallet/state/provider.js";
import { saveWalletState } from "../src/wallet/state/storage.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import { createWalletReadContext, createWalletState } from "./current-model-helpers.js";
import { configureTestClientPassword } from "./client-password-test-helpers.js";

test("address JSON reports the single wallet address", () => {
  const context = createWalletReadContext();
  const result = buildAddressJson(context);

  assert.equal(result.data.address, "bc1qfunding");
  assert.equal(result.data.scriptPubKeyHex, "0014" + "11".repeat(20));
});

test("ids JSON exposes a single wallet-address entry", () => {
  const context = createWalletReadContext();
  const { page } = normalizeListPage([1], { limit: null, all: true, defaultLimit: 50 });
  const result = buildIdsJson(context, page);

  assert.equal(result.data.addresses?.length, 1);
  assert.equal(result.data.addresses?.[0]?.address, "bc1qfunding");
  assert.deepEqual(result.data.addresses?.[0]?.localDomains, []);
});

test("deriveNodeHealth tolerates a short header lead without degrading publishability", () => {
  const readyStatus = {
    ready: true,
    chain: "mainnet",
    pid: 1234,
    walletRootId: "wallet-root",
    nodeBestHeight: 100,
    nodeBestHashHex: "11".repeat(32),
    nodeHeaderHeight: 100,
    serviceUpdatedAtUnixMs: 1,
    serviceStatus: null,
    walletReplica: {
      proofStatus: "ready",
    },
  } as const;

  assert.deepEqual(
    deriveNodeHealthForTesting(readyStatus as any, "ready"),
    {
      health: "synced",
      message: null,
    },
  );
  assert.deepEqual(
    deriveNodeHealthForTesting({
      ...readyStatus,
      nodeHeaderHeight: 101,
    } as any, "ready"),
    {
      health: "synced",
      message: "Bitcoin headers can briefly lead validated blocks; a short 1-2 block lead is normal and is being tolerated.",
    },
  );
  assert.deepEqual(
    deriveNodeHealthForTesting({
      ...readyStatus,
      nodeHeaderHeight: 102,
    } as any, "ready"),
    {
      health: "synced",
      message: "Bitcoin headers can briefly lead validated blocks; a short 1-2 block lead is normal and is being tolerated.",
    },
  );
  assert.deepEqual(
    deriveNodeHealthForTesting({
      ...readyStatus,
      nodeHeaderHeight: 103,
    } as any, "ready"),
    {
      health: "catching-up",
      message: "Bitcoin Core is still catching up to headers.",
    },
  );
});

test("status output keeps a tolerated header lead synced while surfacing the explanatory note", () => {
  const context = createWalletReadContext({
    nodeHealth: "synced",
    nodeMessage: "Bitcoin headers can briefly lead validated blocks; a short 1-2 block lead is normal and is being tolerated.",
    nodeStatus: {
      chain: "mainnet",
      nodeBestHeight: 100,
      nodeBestHashHex: "11".repeat(32),
      nodeHeaderHeight: 102,
      walletReplica: {
        proofStatus: "ready",
      },
    },
  });
  const json = buildStatusJson(context);
  const report = formatWalletOverviewReport(context, "1.1.5");

  assert.deepEqual(json.warnings, []);
  assert.equal(json.data.btc.bestHeight, 100);
  assert.equal(json.data.btc.headerHeight, 102);
  assert.match(
    json.explanations.join("\n"),
    /Bitcoin headers can briefly lead validated blocks/i,
  );
  assert.match(report, /Bitcoin service: Synced/i);
  assert.match(report, /Bitcoin best height: 100/);
  assert.match(report, /Bitcoin headers: 102/);
  assert.match(
    report,
    /Bitcoin note: Bitcoin headers can briefly lead validated blocks; a short 1-2 block lead is normal and is being tolerated\./,
  );
});

test("wallet read status recommends init when client password setup is still missing", async (t) => {
  const tempRoot = await createTrackedTempDirectory(t, "cogcoin-wallet-read-win32-missing-secret");
  const paths = resolveWalletRuntimePathsForTesting({
    env: {
      ...process.env,
      XDG_RUNTIME_DIR: join(tempRoot, "runtime-home"),
      XDG_STATE_HOME: join(tempRoot, "state-home"),
    },
    homeDirectory: tempRoot,
  });
  const seedProvider = createMemoryWalletSecretProviderForTesting();
  const secretReference = createWalletSecretReference("wallet-root");
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "win32",
    stateRoot: paths.stateRoot,
  });

  await seedProvider.storeSecret(secretReference.keyId, Buffer.alloc(32, 31));
  await saveWalletState(
    {
      primaryPath: paths.walletStatePath,
      backupPath: paths.walletStateBackupPath,
    },
    createWalletState(),
    {
      provider: seedProvider,
      secretReference,
    },
  );

  const status = await inspectWalletLocalState({
    paths,
    secretProvider: provider,
  });

  assert.equal(status.availability, "local-state-corrupt");
  assert.equal(status.clientPasswordReadiness, "setup-required");
  assert.match(status.message ?? "", /client password/i);
  assert.match(status.message ?? "", /cogcoin init/i);
});

test("wallet read status treats unsupported legacy wallet-state envelopes as corrupt", async (t) => {
  const tempRoot = await createTrackedTempDirectory(t, "cogcoin-wallet-read-legacy-envelope");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory: tempRoot,
    platform: "linux",
  });
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot: paths.stateRoot,
  });
  const envelope = {
    format: "cogcoin-local-wallet-state",
    version: 1,
    cipher: "aes-256-gcm" as const,
    wrappedBy: "legacy-envelope",
    walletRootIdHint: "wallet-root-legacy",
    secretProvider: null,
    nonce: "AAAAAAAAAAAAAAAA",
    tag: "AAAAAAAAAAAAAAAAAAAAAA==",
    ciphertext: "AA==",
  };

  await mkdir(paths.walletStateDirectory, { recursive: true });
  await writeFile(paths.walletStatePath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");

  const status = await inspectWalletLocalState({
    paths,
    secretProvider: provider,
  });

  assert.equal(status.availability, "local-state-corrupt");
  assert.equal(status.walletRootId, "wallet-root-legacy");
  assert.match(status.message ?? "", /older Cogcoin wallet format/i);
  assert.doesNotMatch(status.message ?? "", /passphrase/i);
});

test("wallet read status reports missing Linux local-file secrets generically", async (t) => {
  const tempRoot = await createTrackedTempDirectory(t, "cogcoin-wallet-read-linux-missing-secret");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory: tempRoot,
    platform: "linux",
  });
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot: paths.stateRoot,
  });
  const secretReference = createWalletSecretReference("wallet-root");

  await configureTestClientPassword(provider);
  t.after(async () => {
    await lockClientPassword(provider);
  });
  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 41));
  await saveWalletState(
    {
      primaryPath: paths.walletStatePath,
      backupPath: paths.walletStateBackupPath,
    },
    createWalletState(),
    {
      provider,
      secretReference,
    },
  );
  await provider.deleteSecret(secretReference.keyId);

  const status = await inspectWalletLocalState({
    paths,
    secretProvider: provider,
  });

  assert.equal(status.availability, "local-state-corrupt");
  assert.equal(status.clientPasswordReadiness, "ready");
  assert.match(status.message ?? "", /local secret-provider material is unavailable/i);
});
