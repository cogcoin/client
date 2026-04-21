import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import { resolveClientPasswordContext, resolveLocalSecretFilePath } from "../src/wallet/state/client-password/context.js";
import { createClientPasswordState, createWrappedSecretEnvelope } from "../src/wallet/state/client-password/crypto.js";
import {
  loadClientPasswordStateOrNull,
  readLocalSecretFile,
  writeClientPasswordRotationJournal,
} from "../src/wallet/state/client-password/files.js";
import { finalizePendingClientPasswordRotationIfNeeded } from "../src/wallet/state/client-password/rotation.js";

test("client-password rotation finalizer applies pending journals and clears the journal file", async (t) => {
  const stateRoot = await createTrackedTempDirectory(t, "cogcoin-client-password-rotation");
  const context = resolveClientPasswordContext({
    platform: "linux",
    stateRoot,
    runtimeRoot: join(stateRoot, "runtime"),
    directoryPath: join(stateRoot, "secrets"),
    runtimeErrorCode: "wallet_secret_provider_linux_runtime_error",
  });
  const keyId = "wallet-state:wallet-root";
  const next = await createClientPasswordState({
    passwordBytes: Buffer.from("next-password", "utf8"),
    passwordHint: "next hint",
  });

  await mkdir(context.directoryPath, { recursive: true });
  try {
    await writeClientPasswordRotationJournal(context.rotationJournalPath, {
      format: "cogcoin-client-password-rotation",
      version: 1,
      nextState: next.state,
      secrets: [
        {
          keyId,
          envelope: createWrappedSecretEnvelope(Buffer.alloc(32, 31), next.derivedKey),
        },
      ],
    });
  } finally {
    next.derivedKey.fill(0);
  }

  await finalizePendingClientPasswordRotationIfNeeded(context);

  assert.deepEqual(
    await loadClientPasswordStateOrNull(context.passwordStatePath),
    next.state,
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
  await assert.rejects(() => readFile(context.rotationJournalPath, "utf8"), /ENOENT/);
});
