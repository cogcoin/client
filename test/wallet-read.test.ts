import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAddressJson, buildIdsJson } from "../src/cli/read-json.js";
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

test("wallet read status recommends init when client password setup is still missing", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-read-win32-missing-secret-"));
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

test("wallet read status treats unsupported legacy wallet-state envelopes as corrupt", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-read-legacy-envelope-"));
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
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-read-linux-missing-secret-"));
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
