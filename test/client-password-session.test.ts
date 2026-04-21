import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import { resolveClientPasswordContext } from "../src/wallet/state/client-password/context.js";
import {
  lockClientPasswordSessionResolved,
  readClientPasswordSessionStatusResolved,
  startClientPasswordSessionWithExpiryResolved,
} from "../src/wallet/state/client-password/session.js";

const execFileAsync = promisify(execFile);

test("client-password session start/status/lock use the shared session owner", async (t) => {
  const stateRoot = await createTrackedTempDirectory(t, "cogcoin-client-password-session");
  const context = resolveClientPasswordContext({
    platform: "linux",
    stateRoot,
    runtimeRoot: join(stateRoot, "runtime"),
    directoryPath: join(stateRoot, "secrets"),
    runtimeErrorCode: "wallet_secret_provider_linux_runtime_error",
  });

  t.after(async () => {
    await lockClientPasswordSessionResolved(context);
  });

  const session = await startClientPasswordSessionWithExpiryResolved({
    ...context,
    derivedKey: Buffer.alloc(32, 7),
    unlockUntilUnixMs: Date.now() + 60_000,
  });

  assert.equal(session.unlocked, true);
  assert.ok((session.unlockUntilUnixMs ?? 0) > Date.now());
  assert.deepEqual(await readClientPasswordSessionStatusResolved(context), {
    unlocked: true,
    unlockUntilUnixMs: session.unlockUntilUnixMs,
  });
  assert.deepEqual(await lockClientPasswordSessionResolved(context), {
    unlocked: false,
    unlockUntilUnixMs: null,
  });
  assert.deepEqual(await readClientPasswordSessionStatusResolved(context), {
    unlocked: false,
    unlockUntilUnixMs: null,
  });
});

test("client-password session status does not carry into a fresh process", async (t) => {
  const stateRoot = await createTrackedTempDirectory(t, "cogcoin-client-password-process-local");
  const context = resolveClientPasswordContext({
    platform: "linux",
    stateRoot,
    runtimeRoot: join(stateRoot, "runtime"),
    directoryPath: join(stateRoot, "secrets"),
    runtimeErrorCode: "wallet_secret_provider_linux_runtime_error",
  });

  t.after(async () => {
    await lockClientPasswordSessionResolved(context);
  });

  await startClientPasswordSessionWithExpiryResolved({
    ...context,
    derivedKey: Buffer.alloc(32, 11),
    unlockUntilUnixMs: Date.now() + 60_000,
  });

  const clientPasswordModuleUrl = pathToFileURL(
    join(process.cwd(), ".test-dist", "src", "wallet", "state", "client-password.js"),
  ).href;
  const childScript = `
    import { readClientPasswordSessionStatus } from ${JSON.stringify(clientPasswordModuleUrl)};

    const status = await readClientPasswordSessionStatus({
      platform: "linux",
      stateRoot: process.argv[1],
      runtimeRoot: process.argv[2],
      directoryPath: process.argv[3],
      runtimeErrorCode: "wallet_secret_provider_linux_runtime_error",
    });

    console.log(JSON.stringify(status));
  `;
  const result = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", childScript, stateRoot, context.runtimeRoot, context.directoryPath],
    { cwd: process.cwd() },
  );

  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    unlocked: false,
    unlockUntilUnixMs: null,
  });
});
