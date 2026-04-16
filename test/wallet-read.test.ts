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
} from "../src/wallet/state/provider.js";
import { saveWalletState } from "../src/wallet/state/storage.js";
import { createWalletReadContext, createWalletState } from "./current-model-helpers.js";

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

test("wallet read status explains unsupported legacy Windows DPAPI secrets", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-read-win32-legacy-"));
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
  const legacyProvider = createDefaultWalletSecretProviderForTesting({
    platform: "win32",
    stateRoot: paths.stateRoot,
  });
  const legacySecretPath = join(
    paths.stateRoot,
    "secrets",
    `${secretReference.keyId.replace(/[^a-zA-Z0-9._-]+/g, "-")}.dpapi`,
  );

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
  await mkdir(join(paths.stateRoot, "secrets"), { recursive: true });
  await writeFile(legacySecretPath, "Zm9v\n");

  const status = await inspectWalletLocalState({
    paths,
    secretProvider: legacyProvider,
  });

  assert.equal(status.availability, "locked");
  assert.match(status.message ?? "", /legacy Windows `?\.dpapi`?/i);
  assert.match(status.message ?? "", /recover|reimport/i);
});
