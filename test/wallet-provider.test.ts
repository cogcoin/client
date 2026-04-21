import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  changeClientPassword,
  createDefaultWalletSecretProviderForTesting,
  createWalletSecretReference,
  lockClientPassword,
  readClientPasswordStatus,
  unlockClientPassword,
} from "../src/wallet/state/provider.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import {
  configureTestClientPassword,
  createScriptedPrompter,
} from "./client-password-test-helpers.js";

const execFileAsync = promisify(execFile);

async function createTempStateRoot(t: TestContext, prefix: string): Promise<string> {
  return await createTrackedTempDirectory(t, prefix);
}

function sanitizeSecretKeyIdForTest(keyId: string): string {
  return keyId.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function createPromptRecorder(options: {
  hiddenResponses: string[];
  promptResponses?: string[];
}) {
  const writes: string[] = [];
  let hiddenIndex = 0;
  let promptIndex = 0;

  return {
    writes,
    prompter: {
      isInteractive: true,
      writeLine(message: string) {
        writes.push(message);
      },
      async prompt(): Promise<string> {
        return options.promptResponses?.[promptIndex++] ?? "";
      },
      async promptHidden(): Promise<string> {
        return options.hiddenResponses[hiddenIndex++] ?? "";
      },
    },
  };
}

function clientPasswordStatePathForTest(stateRoot: string): string {
  return join(stateRoot, "secrets", "client-password.json");
}

function clientPasswordRotationJournalPathForTest(stateRoot: string): string {
  return join(stateRoot, "secrets", "client-password-rotation.json");
}

async function writeReferencedSecretForTest(stateRoot: string, keyId: string): Promise<void> {
  await writeFile(
    join(stateRoot, "wallet-state.enc"),
    `${JSON.stringify({
      secretProvider: {
        keyId,
      },
    })}\n`,
  );
}

test("Linux default secret provider stores, loads, and deletes local secret files", async (t) => {
  const stateRoot = await createTempStateRoot(t, "cogcoin-wallet-provider-linux-local-file");
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
  await writeReferencedSecretForTest(stateRoot, keyId);

  const storedLinux = JSON.parse(await readFile(secretPath, "utf8")) as { format: string; wrappedBy: string };
  assert.equal(storedLinux.format, "cogcoin-local-wallet-secret");
  assert.equal(storedLinux.wrappedBy, "client-password");
  assert.deepEqual(await provider.loadSecret(keyId), new Uint8Array(secret));

  await provider.deleteSecret(keyId);
  await assert.rejects(() => provider.loadSecret(keyId), /wallet_secret_missing_wallet-state:wallet-root-test/);
});

test("Linux default secret provider reports missing secrets without probing external secret stores", async (t) => {
  const stateRoot = await createTempStateRoot(t, "cogcoin-wallet-provider-linux-missing-secret");
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

test("Linux default secret provider surfaces local file runtime failures", async (t) => {
  const stateRoot = await createTempStateRoot(t, "cogcoin-wallet-provider-linux-runtime-error");
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
  const stateRoot = await createTempStateRoot(t, "cogcoin-wallet-provider-win32-local-file");
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
  await writeReferencedSecretForTest(stateRoot, keyId);

  const storedWindows = JSON.parse(await readFile(secretPath, "utf8")) as { format: string; wrappedBy: string };
  assert.equal(storedWindows.format, "cogcoin-local-wallet-secret");
  assert.equal(storedWindows.wrappedBy, "client-password");
  assert.deepEqual(await provider.loadSecret(keyId), new Uint8Array(secret));

  await provider.deleteSecret(keyId);
  await assert.rejects(() => provider.loadSecret(keyId), /wallet_secret_missing_wallet-state:wallet-root-test/);
});

test("client password sessions do not carry into a fresh provider process", async (t) => {
  const stateRoot = await createTempStateRoot(t, "cogcoin-wallet-provider-process-local-session");
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot,
  });

  await configureTestClientPassword(provider);
  t.after(async () => {
    await lockClientPassword(provider);
  });

  const providerModuleUrl = pathToFileURL(
    join(process.cwd(), ".test-dist", "src", "wallet", "state", "provider.js"),
  ).href;
  const childScript = `
    import {
      createDefaultWalletSecretProviderForTesting,
      readClientPasswordStatus,
    } from ${JSON.stringify(providerModuleUrl)};

    const provider = createDefaultWalletSecretProviderForTesting({
      platform: "linux",
      stateRoot: process.argv[1],
    });

    console.log(JSON.stringify(await readClientPasswordStatus(provider)));
  `;
  const result = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", childScript, stateRoot],
    { cwd: process.cwd() },
  );

  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    unlocked: false,
    unlockUntilUnixMs: null,
  });
});

test("Windows default secret provider reports missing secrets generically", async (t) => {
  const stateRoot = await createTempStateRoot(t, "cogcoin-wallet-provider-win32-missing-secret");
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
  const stateRoot = await createTempStateRoot(t, "cogcoin-wallet-provider-linux-setup-session");
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
  const stateRoot = await createTempStateRoot(t, "cogcoin-wallet-provider-linux-refresh-session");
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
  const stateRoot = await createTempStateRoot(t, "cogcoin-wallet-provider-linux-locked-session");
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

test("client change-password requires the current password even while unlocked and replaces the stored hint", async (t) => {
  const stateRoot = await createTempStateRoot(t, "cogcoin-wallet-provider-linux-change-password");
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot,
  });
  const keyId = createWalletSecretReference("wallet-root-test").keyId;
  const secret = Buffer.alloc(32, 61);
  const passwordStatePath = clientPasswordStatePathForTest(stateRoot);

  await configureTestClientPassword(provider, {
    password: "old-password",
    hint: "old hint",
  });
  t.after(async () => {
    await lockClientPassword(provider);
  });
  await provider.storeSecret(keyId, secret);
  await writeReferencedSecretForTest(stateRoot, keyId);

  const before = await readClientPasswordStatus(provider);
  const changePrompt = createPromptRecorder({
    hiddenResponses: [
      "wrong-password-1",
      "wrong-password-2",
      "wrong-password-3",
      "old-password",
      "new-password",
      "new-password",
    ],
    promptResponses: ["new hint"],
  });
  const changedStatus = await changeClientPassword(provider, changePrompt.prompter);

  assert.equal(changedStatus.unlocked, true);
  assert.ok(Math.abs((changedStatus.unlockUntilUnixMs ?? 0) - (before.unlockUntilUnixMs ?? 0)) < 2_000);
  assert.equal(
    changePrompt.writes.filter((message) => message === "Incorrect client password.").length,
    3,
  );
  assert.match(changePrompt.writes.join("\n"), /Hint: old hint/);

  const passwordState = JSON.parse(await readFile(passwordStatePath, "utf8")) as { passwordHint: string };
  assert.equal(passwordState.passwordHint, "new hint");

  await lockClientPassword(provider);
  const unlockPrompt = createPromptRecorder({
    hiddenResponses: ["old-password", "new-password"],
    promptResponses: ["120"],
  });
  const unlockedStatus = await unlockClientPassword(provider, unlockPrompt.prompter);

  assert.equal(unlockedStatus.unlocked, true);
  assert.equal(
    unlockPrompt.writes.filter((message) => message === "Incorrect client password.").length,
    1,
  );
  assert.deepEqual(
    await provider.loadSecret(keyId),
    new Uint8Array(secret),
  );
});

test("client change-password leaves a fresh 24-hour session when it starts locked", async (t) => {
  const stateRoot = await createTempStateRoot(t, "cogcoin-wallet-provider-linux-change-password-locked");
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot,
  });

  await configureTestClientPassword(provider, {
    password: "old-password",
    hint: "old hint",
  });
  t.after(async () => {
    await lockClientPassword(provider);
  });
  await lockClientPassword(provider);

  const status = await changeClientPassword(
    provider,
    createScriptedPrompter(["old-password", "new-password", "new-password", "new hint"]),
  );

  assert.equal(status.unlocked, true);
  assert.ok((status.unlockUntilUnixMs ?? 0) - Date.now() > 80_000_000);
});

test("client change-password requires an interactive terminal", async (t) => {
  const stateRoot = await createTempStateRoot(t, "cogcoin-wallet-provider-linux-change-password-no-tty");
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot,
  });

  await configureTestClientPassword(provider, {
    password: "old-password",
    hint: "old hint",
  });

  await assert.rejects(
    () => changeClientPassword(provider, {
      isInteractive: false,
      writeLine() {},
      async prompt() {
        return "";
      },
      async promptHidden() {
        return "";
      },
    }),
    /wallet_client_password_change_requires_tty/,
  );

  await lockClientPassword(provider);
});

test("client password rotation journal finalizes cleanly on the next password-aware operation", async (t) => {
  const stateRoot = await createTempStateRoot(t, "cogcoin-wallet-provider-linux-change-password-journal");
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot,
  });
  const keyId = createWalletSecretReference("wallet-root-test").keyId;
  const secret = Buffer.alloc(32, 71);
  const secretPath = join(stateRoot, "secrets", `${sanitizeSecretKeyIdForTest(keyId)}.secret`);
  const passwordStatePath = clientPasswordStatePathForTest(stateRoot);
  const journalPath = clientPasswordRotationJournalPathForTest(stateRoot);

  await configureTestClientPassword(provider, {
    password: "old-password",
    hint: "old hint",
  });
  t.after(async () => {
    await lockClientPassword(provider);
  });
  await provider.storeSecret(keyId, secret);
  await writeReferencedSecretForTest(stateRoot, keyId);

  const oldStateText = await readFile(passwordStatePath, "utf8");
  const oldSecretText = await readFile(secretPath, "utf8");
  await changeClientPassword(
    provider,
    createScriptedPrompter(["old-password", "new-password", "new-password", "new hint"]),
  );
  const nextState = JSON.parse(await readFile(passwordStatePath, "utf8")) as Record<string, unknown>;
  const nextSecretEnvelope = JSON.parse(await readFile(secretPath, "utf8")) as Record<string, unknown>;
  await lockClientPassword(provider);

  await writeFile(passwordStatePath, oldStateText);
  await writeFile(secretPath, oldSecretText);
  await writeFile(
    journalPath,
    `${JSON.stringify({
      format: "cogcoin-client-password-rotation",
      version: 1,
      nextState,
      secrets: [
        {
          keyId,
          envelope: nextSecretEnvelope,
        },
      ],
    }, null, 2)}\n`,
  );

  const interactiveProvider = provider.withPrompter?.(createScriptedPrompter(["new-password", "120"])) ?? provider;
  assert.deepEqual(await interactiveProvider.loadSecret(keyId), new Uint8Array(secret));
  await assert.rejects(() => readFile(journalPath, "utf8"), /ENOENT/);
});

test("client password rotation journal repairs a partial committed state", async (t) => {
  const stateRoot = await createTempStateRoot(t, "cogcoin-wallet-provider-linux-change-password-partial-journal");
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot,
  });
  const keyId = createWalletSecretReference("wallet-root-test").keyId;
  const secret = Buffer.alloc(32, 83);
  const secretPath = join(stateRoot, "secrets", `${sanitizeSecretKeyIdForTest(keyId)}.secret`);
  const passwordStatePath = clientPasswordStatePathForTest(stateRoot);
  const journalPath = clientPasswordRotationJournalPathForTest(stateRoot);

  await configureTestClientPassword(provider, {
    password: "old-password",
    hint: "old hint",
  });
  t.after(async () => {
    await lockClientPassword(provider);
  });
  await provider.storeSecret(keyId, secret);
  await writeReferencedSecretForTest(stateRoot, keyId);

  const oldSecretText = await readFile(secretPath, "utf8");
  await changeClientPassword(
    provider,
    createScriptedPrompter(["old-password", "new-password", "new-password", "new hint"]),
  );
  const nextState = JSON.parse(await readFile(passwordStatePath, "utf8")) as Record<string, unknown>;
  const nextSecretEnvelope = JSON.parse(await readFile(secretPath, "utf8")) as Record<string, unknown>;
  await lockClientPassword(provider);

  await writeFile(passwordStatePath, `${JSON.stringify(nextState, null, 2)}\n`);
  await writeFile(secretPath, oldSecretText);
  await writeFile(
    journalPath,
    `${JSON.stringify({
      format: "cogcoin-client-password-rotation",
      version: 1,
      nextState,
      secrets: [
        {
          keyId,
          envelope: nextSecretEnvelope,
        },
      ],
    }, null, 2)}\n`,
  );

  const interactiveProvider = provider.withPrompter?.(createScriptedPrompter(["new-password", "120"])) ?? provider;
  assert.deepEqual(await interactiveProvider.loadSecret(keyId), new Uint8Array(secret));
  await assert.rejects(() => readFile(journalPath, "utf8"), /ENOENT/);
});

test("client password migration exits cleanly after starting the unlock session", { timeout: 15_000 }, async (t) => {
  const stateRoot = await createTempStateRoot(t, "cogcoin-wallet-provider-linux-migration-exit");
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
