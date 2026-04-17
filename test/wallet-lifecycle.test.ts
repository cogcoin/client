import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inspectWalletLocalState } from "../src/wallet/read/index.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  createDefaultWalletSecretProviderForTesting,
  createWalletSecretReference,
  lockClientPassword,
} from "../src/wallet/state/provider.js";
import { saveWalletState } from "../src/wallet/state/storage.js";
import { createWalletState } from "./current-model-helpers.js";
import { configureTestClientPassword } from "./client-password-test-helpers.js";

test("provider-backed Linux local-file wallets load after client password setup", async (t) => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "cogcoin-wallet-lifecycle-linux-"));
  const paths = resolveWalletRuntimePathsForTesting({ homeDirectory, platform: "linux" });
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot: paths.stateRoot,
  });
  const secretReference = createWalletSecretReference("wallet-root");

  await configureTestClientPassword(provider);
  t.after(async () => {
    await lockClientPassword(provider);
  });
  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 47));
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

  const status = await inspectWalletLocalState({
    paths,
    secretProvider: provider,
  });

  assert.equal(status.availability, "ready");
  assert.equal(status.state?.walletRootId, "wallet-root");
  assert.equal(status.source, "primary");
  assert.equal(status.message, null);
});
