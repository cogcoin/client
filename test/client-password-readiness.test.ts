import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import { resolveClientPasswordContext, resolveLocalSecretFilePath } from "../src/wallet/state/client-password/context.js";
import { createClientPasswordState, createWrappedSecretEnvelope } from "../src/wallet/state/client-password/crypto.js";
import { writeClientPasswordState, writeWrappedSecretEnvelope } from "../src/wallet/state/client-password/files.js";
import { inspectClientPasswordReadinessResolved } from "../src/wallet/state/client-password/readiness.js";

test("client-password readiness returns setup-required when nothing is configured", async (t) => {
  const stateRoot = await createTrackedTempDirectory(t, "cogcoin-client-password-readiness-empty");
  const context = resolveClientPasswordContext({
    platform: "linux",
    stateRoot,
    runtimeRoot: join(stateRoot, "runtime"),
    directoryPath: join(stateRoot, "secrets"),
    runtimeErrorCode: "wallet_secret_provider_linux_runtime_error",
  });

  assert.equal(await inspectClientPasswordReadinessResolved(context), "setup-required");
});

test("client-password readiness treats referenced raw secrets under legacy seed roots as migration-required", async (t) => {
  const stateRoot = await createTrackedTempDirectory(t, "cogcoin-client-password-readiness-seeds");
  const directoryPath = join(stateRoot, "secrets");
  const legacyRoot = join(stateRoot, "seeds", "imported-legacy");
  const keyId = "wallet-state:legacy-root";
  const context = resolveClientPasswordContext({
    platform: "linux",
    stateRoot,
    runtimeRoot: join(stateRoot, "runtime"),
    directoryPath,
    runtimeErrorCode: "wallet_secret_provider_linux_runtime_error",
  });

  await mkdir(directoryPath, { recursive: true });
  await mkdir(legacyRoot, { recursive: true });
  await writeFile(
    join(legacyRoot, "wallet-state.enc"),
    `${JSON.stringify({
      secretProvider: {
        keyId,
      },
    })}\n`,
  );
  await writeFile(
    resolveLocalSecretFilePath(directoryPath, keyId),
    `${Buffer.alloc(32, 4).toString("base64")}\n`,
  );

  assert.equal(await inspectClientPasswordReadinessResolved(context), "migration-required");
});

test("client-password readiness stays ready with wrapped secrets and reports keychain-backed migration on darwin", async (t) => {
  const stateRoot = await createTrackedTempDirectory(t, "cogcoin-client-password-readiness-ready");
  const directoryPath = join(stateRoot, "secrets");
  const keyId = "wallet-state:wallet-root";

  await mkdir(directoryPath, { recursive: true });
  await writeFile(
    join(stateRoot, "wallet-state.enc"),
    `${JSON.stringify({
      secretProvider: {
        keyId,
      },
    })}\n`,
  );

  const created = await createClientPasswordState({
    passwordBytes: Buffer.from("client-password", "utf8"),
    passwordHint: "hint",
  });
  try {
    await writeClientPasswordState(join(directoryPath, "client-password.json"), created.state);
    await writeWrappedSecretEnvelope(
      resolveLocalSecretFilePath(directoryPath, keyId),
      createWrappedSecretEnvelope(Buffer.alloc(32, 8), created.derivedKey),
    );
  } finally {
    created.derivedKey.fill(0);
  }

  const readyContext = resolveClientPasswordContext({
    platform: "linux",
    stateRoot,
    runtimeRoot: join(stateRoot, "runtime"),
    directoryPath,
    runtimeErrorCode: "wallet_secret_provider_linux_runtime_error",
  });
  assert.equal(await inspectClientPasswordReadinessResolved(readyContext), "ready");

  const darwinRoot = await createTrackedTempDirectory(t, "cogcoin-client-password-readiness-keychain");
  const keychainContext = resolveClientPasswordContext({
    platform: "darwin",
    stateRoot: darwinRoot,
    runtimeRoot: join(darwinRoot, "runtime"),
    directoryPath: join(darwinRoot, "secrets"),
    runtimeErrorCode: "wallet_secret_provider_macos_runtime_error",
    legacyMacKeychainReader: {
      async loadSecret(requestedKeyId: string): Promise<Uint8Array> {
        if (requestedKeyId !== keyId) {
          throw new Error("unexpected_key");
        }
        return Buffer.alloc(32, 1);
      },
    },
  });
  await mkdir(keychainContext.directoryPath, { recursive: true });
  await writeFile(
    join(keychainContext.stateRoot, "wallet-state.enc"),
    `${JSON.stringify({
      secretProvider: {
        keyId,
      },
    })}\n`,
  );

  assert.equal(await inspectClientPasswordReadinessResolved(keychainContext), "migration-required");
});
