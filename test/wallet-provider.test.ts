import assert from "node:assert/strict";
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

test("Linux default secret provider stores, loads, and deletes secrets through the secret-tool contract", async () => {
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
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

test("Linux default secret provider surfaces a missing secret-tool binary clearly", async () => {
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    linuxSecretToolRunner: async () => {
      const error = new Error("spawn secret-tool ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
  });

  await assert.rejects(
    () => provider.storeSecret("wallet-state:wallet-root-test", Buffer.alloc(32, 9)),
    /wallet_secret_provider_linux_secret_tool_missing/,
  );
});

test("Linux default secret provider surfaces an unavailable Secret Service session clearly", async () => {
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    linuxSecretToolRunner: async () => ({
      stdout: "",
      stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY",
      exitCode: 1,
      signal: null,
    }),
  });

  await assert.rejects(
    () => provider.loadSecret("wallet-state:wallet-root-test"),
    /wallet_secret_provider_linux_secret_service_unavailable/,
  );
});

test("Linux default secret provider surfaces generic secret-tool runtime failures clearly", async () => {
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    linuxSecretToolRunner: async () => ({
      stdout: "",
      stderr: "unexpected libsecret failure",
      exitCode: 1,
      signal: null,
    }),
  });

  await assert.rejects(
    () => provider.storeSecret("wallet-state:wallet-root-test", Buffer.alloc(32, 5)),
    /wallet_secret_provider_linux_runtime_error/,
  );
});
