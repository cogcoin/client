import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, constants, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import test from "node:test";

import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import { createScriptedPrompter } from "./client-password-test-helpers.js";
import {
  ensureClientPasswordConfigured,
  loadClientProtectedSecret,
  readClientPasswordSessionStatus,
} from "../src/wallet/state/client-password.js";
import { resolveClientPasswordContext, resolveLocalSecretFilePath } from "../src/wallet/state/client-password/context.js";
import {
  createClientPasswordState,
  createWrappedSecretEnvelope,
} from "../src/wallet/state/client-password/crypto.js";
import {
  writeClientPasswordState,
  writeWrappedSecretEnvelope,
} from "../src/wallet/state/client-password/files.js";
import {
  cleanupLegacyClientPasswordArtifactsResolved,
  extractLegacyClientPasswordAgentProcessIdsForTesting,
  resolveLegacyClientPasswordAgentEndpointForTesting,
} from "../src/wallet/state/client-password/legacy-cleanup.js";

function createResolvedContext(
  stateRoot: string,
) {
  return resolveClientPasswordContext({
    platform: "linux",
    stateRoot,
    runtimeRoot: join(stateRoot, "runtime"),
    directoryPath: join(stateRoot, "secrets"),
    runtimeErrorCode: "wallet_secret_provider_linux_runtime_error",
  });
}

async function waitForPathMissing(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;

  while (Date.now() < deadline) {
    try {
      await access(path, constants.F_OK);
    } catch {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  await access(path, constants.F_OK);
}

async function waitForChildExit(child: ReturnType<typeof spawn>): Promise<void> {
  const pid = child.pid;
  const deadline = Date.now() + 6_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    if (pid != null) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") {
          return;
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  if (child.exitCode !== null) {
    return;
  }

  throw new Error("legacy_agent_process_did_not_exit");
}

async function closeServer(server: net.Server, endpoint: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error != null) {
        reject(error);
        return;
      }

      resolve();
    });
  }).catch(() => undefined);

  await rm(endpoint, { force: true }).catch(() => undefined);
}

async function createStaleSocketOwner(endpoint: string) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import net from 'node:net'; const server = net.createServer(); server.listen(process.argv[1], () => { console.log('ready'); }); setInterval(() => {}, 1000);",
      endpoint,
    ],
    {
      stdio: ["ignore", "pipe", "ignore"],
    },
  );

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("stale_socket_owner_did_not_start"));
    }, 5_000);
    timeout.unref();

    child.stdout?.on("data", (chunk) => {
      if (chunk.toString("utf8").includes("ready")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`stale_socket_owner_exited_early:${code ?? "null"}:${signal ?? "null"}`));
    });
  });

  return child;
}

async function createLegacyAgentServer(options: {
  endpoint: string;
  mode: "legacy" | "invalid";
}) {
  let statusCount = 0;
  let lockCount = 0;
  const server = net.createServer((socket) => {
    let received = "";

    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      const newlineIndex = received.indexOf("\n");

      if (newlineIndex === -1) {
        return;
      }

      if (options.mode === "invalid") {
        socket.end("not-json\n");
        return;
      }

      const request = JSON.parse(received.slice(0, newlineIndex)) as { command?: string };

      if (request.command === "status") {
        statusCount += 1;
        socket.end(`${JSON.stringify({
          ok: true,
          unlockUntilUnixMs: Date.now() + 60_000,
        })}\n`);
        return;
      }

      if (request.command === "lock") {
        lockCount += 1;
        socket.end(`${JSON.stringify({
          ok: true,
          unlockUntilUnixMs: null,
        })}\n`);
        setImmediate(() => {
          void closeServer(server, options.endpoint);
        });
        return;
      }

      socket.end(`${JSON.stringify({ ok: false, error: "unexpected_command" })}\n`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    server,
    get statusCount() {
      return statusCount;
    },
    get lockCount() {
      return lockCount;
    },
  };
}

test("legacy cleanup locks a live legacy agent and removes the leftover unix socket", async (t) => {
  const context = createResolvedContext(
    await createTrackedTempDirectory(t, "cogcoin-client-password-legacy-agent"),
  );
  const endpoint = resolveLegacyClientPasswordAgentEndpointForTesting(context.stateRoot);

  if (endpoint.startsWith("\\\\.\\pipe\\")) {
    t.skip("unix socket end-to-end cleanup is covered on Unix hosts");
    return;
  }

  const legacyAgent = await createLegacyAgentServer({
    endpoint,
    mode: "legacy",
  });
  t.after(async () => {
    await closeServer(legacyAgent.server, endpoint);
  });

  await cleanupLegacyClientPasswordArtifactsResolved(context);
  await waitForPathMissing(endpoint);

  assert.equal(legacyAgent.statusCount, 1);
  assert.equal(legacyAgent.lockCount, 1);
});

test("legacy cleanup removes stale unix socket files without a live listener", async (t) => {
  const context = createResolvedContext(
    await createTrackedTempDirectory(t, "cogcoin-client-password-stale-socket-cleanup"),
  );
  const endpoint = resolveLegacyClientPasswordAgentEndpointForTesting(context.stateRoot);

  if (endpoint.startsWith("\\\\.\\pipe\\")) {
    t.skip("unix socket cleanup is covered on Unix hosts");
    return;
  }

  const socketOwner = await createStaleSocketOwner(endpoint);
  t.after(async () => {
    if (socketOwner.pid != null) {
      try {
        process.kill(socketOwner.pid, "SIGKILL");
      } catch {}
    }
    await rm(endpoint, { force: true }).catch(() => undefined);
  });

  process.kill(socketOwner.pid!, "SIGKILL");
  await waitForChildExit(socketOwner);
  await access(endpoint, constants.F_OK);

  await cleanupLegacyClientPasswordArtifactsResolved(context);
  await assert.rejects(() => access(endpoint, constants.F_OK), /ENOENT/);
});

test("legacy cleanup leaves invalid-protocol responders alone", async (t) => {
  const context = createResolvedContext(
    await createTrackedTempDirectory(t, "cogcoin-client-password-invalid-protocol"),
  );
  const endpoint = resolveLegacyClientPasswordAgentEndpointForTesting(context.stateRoot);

  if (endpoint.startsWith("\\\\.\\pipe\\")) {
    t.skip("unix socket cleanup is covered on Unix hosts");
    return;
  }

  const responder = await createLegacyAgentServer({
    endpoint,
    mode: "invalid",
  });
  t.after(async () => {
    await closeServer(responder.server, endpoint);
  });

  await cleanupLegacyClientPasswordArtifactsResolved(context);
  await access(endpoint, constants.F_OK);

  assert.equal(responder.statusCount, 0);
  assert.equal(responder.lockCount, 0);
});

test("legacy cleanup terminates scanned legacy agent processes with the exact endpoint argument", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows process-scan coverage uses mocked parser output");
    return;
  }

  const context = createResolvedContext(
    await createTrackedTempDirectory(t, "cogcoin-client-password-process-scan"),
  );
  const endpoint = resolveLegacyClientPasswordAgentEndpointForTesting(context.stateRoot);
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000);", "client-password-agent.js", endpoint],
    {
      stdio: "ignore",
    },
  );

  t.after(async () => {
    if (child.pid != null) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {}
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  await cleanupLegacyClientPasswordArtifactsResolved(context);
  await waitForChildExit(child);
});

test("legacy cleanup ignores nonmatching processes", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows process-scan coverage uses mocked parser output");
    return;
  }

  const context = createResolvedContext(
    await createTrackedTempDirectory(t, "cogcoin-client-password-process-ignore"),
  );
  const endpoint = resolveLegacyClientPasswordAgentEndpointForTesting(context.stateRoot);
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000);", "client-password-agent.js", `${endpoint}-other`],
    {
      stdio: "ignore",
    },
  );

  t.after(async () => {
    if (child.pid != null) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {}
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  await cleanupLegacyClientPasswordArtifactsResolved(context);

  assert.equal(child.pid == null, false);
  assert.equal(process.kill(child.pid!, 0), true);
});

test("legacy cleanup prunes only empty legacy .client-runtime directories", async (t) => {
  const emptyContext = createResolvedContext(
    await createTrackedTempDirectory(t, "cogcoin-client-password-empty-runtime-root"),
  );
  const emptyRuntimeRoot = join(emptyContext.stateRoot, ".client-runtime");
  await mkdir(emptyRuntimeRoot, { recursive: true });

  await cleanupLegacyClientPasswordArtifactsResolved(emptyContext);
  await assert.rejects(() => access(emptyRuntimeRoot, constants.F_OK), /ENOENT/);

  const nonEmptyContext = createResolvedContext(
    await createTrackedTempDirectory(t, "cogcoin-client-password-nonempty-runtime-root"),
  );
  const nonEmptyRuntimeRoot = join(nonEmptyContext.stateRoot, ".client-runtime");
  await mkdir(nonEmptyRuntimeRoot, { recursive: true });
  await mkdir(join(nonEmptyRuntimeRoot, "child"), { recursive: true });

  await cleanupLegacyClientPasswordArtifactsResolved(nonEmptyContext);
  await access(nonEmptyRuntimeRoot, constants.F_OK);
});

test("legacy cleanup coalesces only concurrent calls for one stateRoot", async () => {
  const context = createResolvedContext("/tmp/cogcoin-client-password-concurrent");
  let calls = 0;
  let releaseCleanup!: () => void;
  const cleanupGate = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });

  const first = cleanupLegacyClientPasswordArtifactsResolved(context, {
    async runCleanupPass() {
      calls += 1;
      await cleanupGate;
    },
  });
  const second = cleanupLegacyClientPasswordArtifactsResolved(context, {
    async runCleanupPass() {
      calls += 1;
      await cleanupGate;
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(calls, 1);

  releaseCleanup();
  await Promise.all([first, second]);

  await cleanupLegacyClientPasswordArtifactsResolved(context, {
    async runCleanupPass() {
      calls += 1;
    },
  });
  assert.equal(calls, 2);
});

test("legacy cleanup parses matching Windows process-scan output", () => {
  const endpoint = "\\\\.\\pipe\\cogcoin-client-password-abc123";

  assert.deepEqual(
    extractLegacyClientPasswordAgentProcessIdsForTesting({
      endpoint,
      hostPlatform: "win32",
      stdout: JSON.stringify([
        {
          ProcessId: 101,
          CommandLine: `node C:\\tmp\\client-password-agent.js ${endpoint}`,
        },
        {
          ProcessId: 102,
          CommandLine: `node C:\\tmp\\client-password-agent.js ${endpoint}-other`,
        },
        {
          ProcessId: 103,
          CommandLine: "node C:\\tmp\\something-else.js",
        },
      ]),
    }),
    [101],
  );
});

test("public readClientPasswordSessionStatus cleans up a legacy agent and stays process-local", async (t) => {
  const stateRoot = await createTrackedTempDirectory(t, "cogcoin-client-password-public-status-cleanup");
  const context = createResolvedContext(stateRoot);
  const endpoint = resolveLegacyClientPasswordAgentEndpointForTesting(context.stateRoot);

  if (endpoint.startsWith("\\\\.\\pipe\\")) {
    t.skip("unix socket end-to-end cleanup is covered on Unix hosts");
    return;
  }

  const legacyAgent = await createLegacyAgentServer({
    endpoint,
    mode: "legacy",
  });
  t.after(async () => {
    await closeServer(legacyAgent.server, endpoint);
  });

  const status = await readClientPasswordSessionStatus({
    platform: "linux",
    stateRoot,
    runtimeRoot: context.runtimeRoot,
    directoryPath: context.directoryPath,
    runtimeErrorCode: context.runtimeErrorCode,
  });

  assert.deepEqual(status, {
    unlocked: false,
    unlockUntilUnixMs: null,
  });
  assert.equal(legacyAgent.statusCount, 1);
  assert.equal(legacyAgent.lockCount, 1);
  await waitForPathMissing(endpoint);
});

test("public loadClientProtectedSecret cleans up a legacy agent before reporting the current process as locked", async (t) => {
  const stateRoot = await createTrackedTempDirectory(t, "cogcoin-client-password-public-load-cleanup");
  const context = createResolvedContext(stateRoot);
  const endpoint = resolveLegacyClientPasswordAgentEndpointForTesting(context.stateRoot);
  const keyId = "wallet-state:wallet-root";
  const created = await createClientPasswordState({
    passwordBytes: Buffer.from("client-password", "utf8"),
    passwordHint: "hint",
  });

  if (endpoint.startsWith("\\\\.\\pipe\\")) {
    t.skip("unix socket end-to-end cleanup is covered on Unix hosts");
    created.derivedKey.fill(0);
    return;
  }

  await mkdir(context.directoryPath, { recursive: true });
  try {
    await writeClientPasswordState(context.passwordStatePath, created.state);
    await writeWrappedSecretEnvelope(
      resolveLocalSecretFilePath(context.directoryPath, keyId),
      createWrappedSecretEnvelope(Buffer.alloc(32, 9), created.derivedKey),
    );
  } finally {
    created.derivedKey.fill(0);
  }

  const legacyAgent = await createLegacyAgentServer({
    endpoint,
    mode: "legacy",
  });
  t.after(async () => {
    await closeServer(legacyAgent.server, endpoint);
  });

  await assert.rejects(
    () => loadClientProtectedSecret({
      platform: "linux",
      stateRoot,
      runtimeRoot: context.runtimeRoot,
      directoryPath: context.directoryPath,
      runtimeErrorCode: context.runtimeErrorCode,
      keyId,
    }),
    /wallet_client_password_locked/,
  );

  assert.equal(legacyAgent.statusCount, 1);
  assert.equal(legacyAgent.lockCount, 1);
  await waitForPathMissing(endpoint);
});

test("public ensureClientPasswordConfigured cleans up a legacy agent before reporting already-configured state", async (t) => {
  const stateRoot = await createTrackedTempDirectory(t, "cogcoin-client-password-public-setup-cleanup");
  const context = createResolvedContext(stateRoot);
  const endpoint = resolveLegacyClientPasswordAgentEndpointForTesting(context.stateRoot);
  const created = await createClientPasswordState({
    passwordBytes: Buffer.from("client-password", "utf8"),
    passwordHint: "hint",
  });

  if (endpoint.startsWith("\\\\.\\pipe\\")) {
    t.skip("unix socket end-to-end cleanup is covered on Unix hosts");
    created.derivedKey.fill(0);
    return;
  }

  await mkdir(context.directoryPath, { recursive: true });
  try {
    await writeClientPasswordState(context.passwordStatePath, created.state);
  } finally {
    created.derivedKey.fill(0);
  }

  const legacyAgent = await createLegacyAgentServer({
    endpoint,
    mode: "legacy",
  });
  t.after(async () => {
    await closeServer(legacyAgent.server, endpoint);
  });

  const result = await ensureClientPasswordConfigured({
    platform: "linux",
    stateRoot,
    runtimeRoot: context.runtimeRoot,
    directoryPath: context.directoryPath,
    runtimeErrorCode: context.runtimeErrorCode,
    prompt: createScriptedPrompter(["unused"]),
  });

  assert.deepEqual(result, {
    action: "already-configured",
    session: {
      unlocked: false,
      unlockUntilUnixMs: null,
    },
  });
  assert.equal(legacyAgent.statusCount, 1);
  assert.equal(legacyAgent.lockCount, 1);
  await waitForPathMissing(endpoint);
});
