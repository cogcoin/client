import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import { resolveClientPasswordContext, resolveLocalSecretFilePath } from "../src/wallet/state/client-password/context.js";
import { createClientPasswordState } from "../src/wallet/state/client-password/crypto.js";
import { readLocalSecretFile, writeClientPasswordState } from "../src/wallet/state/client-password/files.js";
import {
  deleteClientProtectedSecretResolved,
  loadClientProtectedSecretResolved,
  storeClientProtectedSecretResolved,
} from "../src/wallet/state/client-password/protected-secrets.js";
import {
  lockClientPasswordSessionResolved,
  startClientPasswordSessionResolved,
} from "../src/wallet/state/client-password/session.js";

test("client-password protected secrets round-trip through the shared secret owner", async (t) => {
  const stateRoot = await createTrackedTempDirectory(t, "cogcoin-client-password-protected");
  const context = resolveClientPasswordContext({
    platform: "linux",
    stateRoot,
    runtimeRoot: join(stateRoot, "runtime"),
    directoryPath: join(stateRoot, "secrets"),
    runtimeErrorCode: "wallet_secret_provider_linux_runtime_error",
  });
  const keyId = "wallet-state:wallet-root";
  const secret = Buffer.alloc(32, 17);
  const created = await createClientPasswordState({
    passwordBytes: Buffer.from("client-password", "utf8"),
    passwordHint: "hint",
  });

  await mkdir(context.directoryPath, { recursive: true });
  await writeClientPasswordState(context.passwordStatePath, created.state);
  t.after(async () => {
    await lockClientPasswordSessionResolved(context);
  });
  await startClientPasswordSessionResolved({
    ...context,
    derivedKey: created.derivedKey,
    unlockDurationSeconds: 120,
  });

  await storeClientProtectedSecretResolved({
    ...context,
    keyId,
    secret,
  });

  assert.deepEqual(
    await loadClientProtectedSecretResolved({
      ...context,
      keyId,
    }),
    new Uint8Array(secret),
  );
  const local = await readLocalSecretFile(resolveLocalSecretFilePath(context.directoryPath, keyId));
  assert.equal(local.state, "wrapped");
  assert.equal(local.envelope.format, "cogcoin-local-wallet-secret");
  assert.equal(local.envelope.version, 1);
  assert.equal(local.envelope.cipher, "aes-256-gcm");
  assert.equal(local.envelope.wrappedBy, "client-password");
  assert.ok(local.envelope.nonce.length > 0);
  assert.ok(local.envelope.tag.length > 0);
  assert.ok(local.envelope.ciphertext.length > 0);

  await deleteClientProtectedSecretResolved({
    ...context,
    keyId,
  });
  await assert.rejects(
    () => loadClientProtectedSecretResolved({ ...context, keyId }),
    /wallet_secret_missing_wallet-state:wallet-root/,
  );
});
