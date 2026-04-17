import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDefaultWalletSecretProviderForTesting,
  createWalletSecretReference,
} from "../src/wallet/state/provider.js";
import { configureTestClientPassword } from "./client-password-test-helpers.js";

async function createTempStateRoot(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

function sanitizeSecretKeyIdForTest(keyId: string): string {
  return keyId.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

test("Linux default secret provider stores, loads, and deletes local secret files", async () => {
  const stateRoot = await createTempStateRoot("cogcoin-wallet-provider-linux-local-file-");
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot,
  });
  const keyId = createWalletSecretReference("wallet-root-test").keyId;
  const secret = Buffer.alloc(32, 7);
  const secretPath = join(stateRoot, "secrets", `${sanitizeSecretKeyIdForTest(keyId)}.secret`);

  assert.equal(provider.kind, "linux-local-file");

  await configureTestClientPassword(provider);
  await provider.storeSecret(keyId, secret);

  const storedLinux = JSON.parse(await readFile(secretPath, "utf8")) as { format: string; wrappedBy: string };
  assert.equal(storedLinux.format, "cogcoin-local-wallet-secret");
  assert.equal(storedLinux.wrappedBy, "client-password");
  assert.deepEqual(await provider.loadSecret(keyId), new Uint8Array(secret));

  await provider.deleteSecret(keyId);
  await assert.rejects(() => provider.loadSecret(keyId), /wallet_secret_missing_wallet-state:wallet-root-test/);
});

test("Linux default secret provider reports missing secrets without probing external secret stores", async () => {
  const stateRoot = await createTempStateRoot("cogcoin-wallet-provider-linux-missing-secret-");
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot,
  });
  const keyId = createWalletSecretReference("wallet-root-test").keyId;
  await configureTestClientPassword(provider);
  await assert.rejects(() => provider.loadSecret(keyId), /wallet_secret_missing_wallet-state:wallet-root-test/);
});

test("Linux default secret provider surfaces local file runtime failures", async () => {
  const stateRoot = await createTempStateRoot("cogcoin-wallet-provider-linux-runtime-error-");
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot,
  });
  const keyId = createWalletSecretReference("wallet-root-test").keyId;
  const secretPath = join(stateRoot, "secrets", `${sanitizeSecretKeyIdForTest(keyId)}.secret`);

  await mkdir(secretPath, { recursive: true });
  await assert.rejects(
    () => provider.loadSecret(keyId),
    /wallet_secret_provider_linux_runtime_error/,
  );
});

test("Windows default secret provider stores, loads, and deletes local secret files", async () => {
  const stateRoot = await createTempStateRoot("cogcoin-wallet-provider-win32-local-file-");
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "win32",
    stateRoot,
  });
  const keyId = createWalletSecretReference("wallet-root-test").keyId;
  const secret = Buffer.alloc(32, 23);
  const secretPath = join(stateRoot, "secrets", `${sanitizeSecretKeyIdForTest(keyId)}.secret`);

  await configureTestClientPassword(provider);
  await provider.storeSecret(keyId, secret);

  const storedWindows = JSON.parse(await readFile(secretPath, "utf8")) as { format: string; wrappedBy: string };
  assert.equal(storedWindows.format, "cogcoin-local-wallet-secret");
  assert.equal(storedWindows.wrappedBy, "client-password");
  assert.deepEqual(await provider.loadSecret(keyId), new Uint8Array(secret));

  await provider.deleteSecret(keyId);
  await assert.rejects(() => provider.loadSecret(keyId), /wallet_secret_missing_wallet-state:wallet-root-test/);
});

test("Windows default secret provider reports missing secrets generically", async () => {
  const stateRoot = await createTempStateRoot("cogcoin-wallet-provider-win32-missing-secret-");
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "win32",
    stateRoot,
  });
  const keyId = createWalletSecretReference("wallet-root-test").keyId;
  await configureTestClientPassword(provider);

  await assert.rejects(
    () => provider.loadSecret(keyId),
    /wallet_secret_missing_wallet-state:wallet-root-test/,
  );
});
