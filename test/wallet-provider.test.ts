import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDefaultWalletSecretProviderForTesting,
  createWalletSecretReference,
  type LinuxSecretToolRunner,
} from "../src/wallet/state/provider.js";

function parseSecretToolAttributes(args: readonly string[]): Map<string, string> {
  const attributes = new Map<string, string>();

  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];

    if (key !== undefined && value !== undefined) {
      attributes.set(key, value);
    }
  }

  return attributes;
}

function createInMemoryLinuxSecretToolRunner(): LinuxSecretToolRunner {
  const secrets = new Map<string, string>();

  return async (args, options = {}) => {
    const [command, ...rest] = args;

    if (command === "store") {
      assert.equal(rest[0], "--label");
      const attributes = parseSecretToolAttributes(rest.slice(2));
      const keyId = attributes.get("key-id");
      assert.equal(attributes.get("application"), "org.cogcoin.wallet");
      assert.equal(attributes.get("secret-kind"), "wallet-secret");
      assert.ok(keyId);
      secrets.set(keyId!, options.stdin ?? "");
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
      };
    }

    const attributes = parseSecretToolAttributes(rest);
    const keyId = attributes.get("key-id");
    assert.equal(attributes.get("application"), "org.cogcoin.wallet");
    assert.equal(attributes.get("secret-kind"), "wallet-secret");
    assert.ok(keyId);

    if (command === "lookup") {
      const stored = secrets.get(keyId!);
      return stored === undefined
        ? {
          stdout: "",
          stderr: "",
          exitCode: 1,
          signal: null,
        }
        : {
          stdout: stored,
          stderr: "",
          exitCode: 0,
          signal: null,
        };
    }

    if (command === "clear") {
      secrets.delete(keyId!);
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
      };
    }

    throw new Error(`unexpected_secret_tool_command_${command}`);
  };
}

async function createTempStateRoot(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

test("Linux default secret provider stores, loads, and deletes secrets through the secret-tool contract", async () => {
  const stateRoot = await createTempStateRoot("cogcoin-wallet-provider-secret-service-");
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot,
    linuxSecretToolRunner: createInMemoryLinuxSecretToolRunner(),
  });
  const keyId = createWalletSecretReference("wallet-root-test").keyId;
  const secret = Buffer.alloc(32, 7);

  await provider.storeSecret(keyId, secret);

  const loaded = await provider.loadSecret(keyId);
  assert.deepEqual(loaded, new Uint8Array(secret));

  await provider.deleteSecret(keyId);
  await assert.rejects(() => provider.loadSecret(keyId), /wallet_secret_missing_wallet-state:wallet-root-test/);
});

test("Linux default secret provider falls back to a local secret file when secret-tool is missing", async () => {
  const stateRoot = await createTempStateRoot("cogcoin-wallet-provider-missing-tool-");
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot,
    linuxSecretToolRunner: async () => {
      const error = new Error("spawn secret-tool ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
  });
  const keyId = createWalletSecretReference("wallet-root-test").keyId;
  const secret = Buffer.alloc(32, 9);

  await provider.storeSecret(keyId, secret);
  const loaded = await provider.loadSecret(keyId);

  assert.deepEqual(loaded, new Uint8Array(secret));
});

test("Linux default secret provider falls back to a local secret file when Secret Service is unavailable", async () => {
  const stateRoot = await createTempStateRoot("cogcoin-wallet-provider-unavailable-service-");
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot,
    linuxSecretToolRunner: async () => ({
      stdout: "",
      stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY",
      exitCode: 1,
      signal: null,
    }),
  });
  const keyId = createWalletSecretReference("wallet-root-test").keyId;
  const secret = Buffer.alloc(32, 5);

  await provider.storeSecret(keyId, secret);
  const loaded = await provider.loadSecret(keyId);

  assert.deepEqual(loaded, new Uint8Array(secret));
});

test("Linux default secret provider loads a local fallback secret when Secret Service has no matching item", async () => {
  const stateRoot = await createTempStateRoot("cogcoin-wallet-provider-missing-item-");
  const keyId = createWalletSecretReference("wallet-root-test").keyId;
  const secret = Buffer.alloc(32, 11);
  const fallbackProvider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot,
    linuxSecretToolRunner: async () => {
      const error = new Error("spawn secret-tool ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
  });
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot,
    linuxSecretToolRunner: createInMemoryLinuxSecretToolRunner(),
  });

  await fallbackProvider.storeSecret(keyId, secret);
  const loaded = await provider.loadSecret(keyId);

  assert.deepEqual(loaded, new Uint8Array(secret));
});

test("Linux default secret provider only falls back on generic runtime load failures when a local secret already exists", async () => {
  const stateRoot = await createTempStateRoot("cogcoin-wallet-provider-generic-runtime-");
  const keyId = createWalletSecretReference("wallet-root-test").keyId;
  const secret = Buffer.alloc(32, 13);
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot,
    linuxSecretToolRunner: async () => ({
      stdout: "",
      stderr: "unexpected libsecret failure",
      exitCode: 1,
      signal: null,
    }),
  });
  const fallbackProvider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot,
    linuxSecretToolRunner: async () => {
      const error = new Error("spawn secret-tool ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
  });

  await assert.rejects(
    () => provider.loadSecret(keyId),
    /wallet_secret_provider_linux_runtime_error/,
  );

  await fallbackProvider.storeSecret(keyId, secret);
  const loaded = await provider.loadSecret(keyId);

  assert.deepEqual(loaded, new Uint8Array(secret));
});

test("Linux default secret provider deletes both Secret Service and local fallback copies best-effort", async () => {
  const stateRoot = await createTempStateRoot("cogcoin-wallet-provider-delete-both-");
  const keyId = createWalletSecretReference("wallet-root-test").keyId;
  const fallbackSecret = Buffer.alloc(32, 17);
  const secretServiceSecret = Buffer.alloc(32, 19);
  const fallbackProvider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot,
    linuxSecretToolRunner: async () => {
      const error = new Error("spawn secret-tool ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
  });
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot,
    linuxSecretToolRunner: createInMemoryLinuxSecretToolRunner(),
  });

  await fallbackProvider.storeSecret(keyId, fallbackSecret);
  await provider.storeSecret(keyId, secretServiceSecret);
  assert.deepEqual(await provider.loadSecret(keyId), new Uint8Array(secretServiceSecret));

  await provider.deleteSecret(keyId);

  await assert.rejects(
    () => provider.loadSecret(keyId),
    /wallet_secret_missing_wallet-state:wallet-root-test/,
  );
});
