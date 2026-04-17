import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  createDefaultWalletSecretProviderForTesting,
  createWalletSecretReference,
  lockClientPassword,
  readClientPasswordStatus,
  unlockClientPassword,
} from "../src/wallet/state/provider.js";
import { configureTestClientPassword, createScriptedPrompter } from "./client-password-test-helpers.js";

const execFileAsync = promisify(execFile);

async function createTempStateRoot(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

function sanitizeSecretKeyIdForTest(keyId: string): string {
  return keyId.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

test("Linux default secret provider stores, loads, and deletes local secret files", async (t) => {
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
  t.after(async () => {
    await lockClientPassword(provider);
  });
  await provider.storeSecret(keyId, secret);

  const storedLinux = JSON.parse(await readFile(secretPath, "utf8")) as { format: string; wrappedBy: string };
  assert.equal(storedLinux.format, "cogcoin-local-wallet-secret");
  assert.equal(storedLinux.wrappedBy, "client-password");
  assert.deepEqual(await provider.loadSecret(keyId), new Uint8Array(secret));

  await provider.deleteSecret(keyId);
  await assert.rejects(() => provider.loadSecret(keyId), /wallet_secret_missing_wallet-state:wallet-root-test/);
});

test("Linux default secret provider reports missing secrets without probing external secret stores", async (t) => {
  const stateRoot = await createTempStateRoot("cogcoin-wallet-provider-linux-missing-secret-");
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot,
  });
  const keyId = createWalletSecretReference("wallet-root-test").keyId;
  await configureTestClientPassword(provider);
  t.after(async () => {
    await lockClientPassword(provider);
  });
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

test("Windows default secret provider stores, loads, and deletes local secret files", async (t) => {
  const stateRoot = await createTempStateRoot("cogcoin-wallet-provider-win32-local-file-");
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "win32",
    stateRoot,
  });
  const keyId = createWalletSecretReference("wallet-root-test").keyId;
  const secret = Buffer.alloc(32, 23);
  const secretPath = join(stateRoot, "secrets", `${sanitizeSecretKeyIdForTest(keyId)}.secret`);

  await configureTestClientPassword(provider);
  t.after(async () => {
    await lockClientPassword(provider);
  });
  await provider.storeSecret(keyId, secret);

  const storedWindows = JSON.parse(await readFile(secretPath, "utf8")) as { format: string; wrappedBy: string };
  assert.equal(storedWindows.format, "cogcoin-local-wallet-secret");
  assert.equal(storedWindows.wrappedBy, "client-password");
  assert.deepEqual(await provider.loadSecret(keyId), new Uint8Array(secret));

  await provider.deleteSecret(keyId);
  await assert.rejects(() => provider.loadSecret(keyId), /wallet_secret_missing_wallet-state:wallet-root-test/);
});

test("Windows default secret provider reports missing secrets generically", async (t) => {
  const stateRoot = await createTempStateRoot("cogcoin-wallet-provider-win32-missing-secret-");
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "win32",
    stateRoot,
  });
  const keyId = createWalletSecretReference("wallet-root-test").keyId;
  await configureTestClientPassword(provider);
  t.after(async () => {
    await lockClientPassword(provider);
  });

  await assert.rejects(
    () => provider.loadSecret(keyId),
    /wallet_secret_missing_wallet-state:wallet-root-test/,
  );
});

test("client password setup opens a 24-hour session", async (t) => {
  const stateRoot = await createTempStateRoot("cogcoin-wallet-provider-linux-setup-session-");
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot,
  });

  await configureTestClientPassword(provider);
  t.after(async () => {
    await lockClientPassword(provider);
  });

  const status = await readClientPasswordStatus(provider);

  assert.equal(status.unlocked, true);
  assert.ok((status.unlockUntilUnixMs ?? 0) - Date.now() > 80_000_000);
});

test("client unlock refreshes an active session without re-entering the password", async (t) => {
  const stateRoot = await createTempStateRoot("cogcoin-wallet-provider-linux-refresh-session-");
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot,
  });

  await configureTestClientPassword(provider);
  t.after(async () => {
    await lockClientPassword(provider);
  });

  const status = await unlockClientPassword(provider, {
    isInteractive: true,
    writeLine() {},
    async prompt() {
      return "";
    },
    async promptHidden() {
      throw new Error("password should not be requested while already unlocked");
    },
  });

  assert.equal(status.unlocked, true);
  assert.ok((status.unlockUntilUnixMs ?? 0) - Date.now() > 80_000_000);
});

test("client unlock still prompts for password when the session is locked", async (t) => {
  const stateRoot = await createTempStateRoot("cogcoin-wallet-provider-linux-locked-session-");
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot,
  });

  await configureTestClientPassword(provider);
  t.after(async () => {
    await lockClientPassword(provider);
  });
  await lockClientPassword(provider);

  const status = await unlockClientPassword(
    provider,
    createScriptedPrompter(["test-client-password", "120"]),
  );

  assert.equal(status.unlocked, true);
  assert.ok((status.unlockUntilUnixMs ?? 0) - Date.now() < 200_000);
  assert.ok((status.unlockUntilUnixMs ?? 0) - Date.now() > 90_000);
});

test("client password migration exits cleanly after starting the unlock session", { timeout: 15_000 }, async () => {
  const stateRoot = await createTempStateRoot("cogcoin-wallet-provider-linux-migration-exit-");
  const keyId = createWalletSecretReference("wallet-root-test").keyId;
  const secretPath = join(stateRoot, "secrets", `${sanitizeSecretKeyIdForTest(keyId)}.secret`);
  const providerModuleUrl = pathToFileURL(
    join(process.cwd(), ".test-dist", "src", "wallet", "state", "provider.js"),
  ).href;
  const childScript = `
    import {
      createDefaultWalletSecretProviderForTesting,
      ensureClientPasswordConfigured,
    } from ${JSON.stringify(providerModuleUrl)};

    const provider = createDefaultWalletSecretProviderForTesting({
      platform: "linux",
      stateRoot: process.argv[1],
    });

    const action = await ensureClientPasswordConfigured(provider, {
      isInteractive: true,
      writeLine() {},
      async prompt(message) {
        if (message.startsWith("Password hint: ")) {
          return "migration hint";
        }

        throw new Error(\`unexpected prompt: \${message}\`);
      },
      async promptHidden() {
        return "migration-password";
      },
    });

    if (action !== "migrated") {
      throw new Error(\`unexpected action: \${action}\`);
    }

    console.log("done");
  `;

  await mkdir(join(stateRoot, "secrets"), { recursive: true });
  await writeFile(secretPath, `${Buffer.alloc(32, 9).toString("base64")}\n`);
  await writeFile(
    join(stateRoot, "wallet-state.enc"),
    `${JSON.stringify({
      secretProvider: {
        keyId,
      },
    })}\n`,
  );

  const result = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", childScript, stateRoot],
    {
      timeout: 10_000,
    },
  );

  assert.match(result.stdout, /done/);

  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot,
  });
  await lockClientPassword(provider);

  const stored = JSON.parse(await readFile(secretPath, "utf8")) as { wrappedBy: string };
  assert.equal(stored.wrappedBy, "client-password");
});
