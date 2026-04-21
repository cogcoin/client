import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readdir, rm, rmdir } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ClientPasswordResolvedContext } from "./types.js";

const execFileAsync = promisify(execFile);
const LEGACY_AGENT_MARKER = "client-password-agent.js";
const LEGACY_AGENT_TIMEOUT_MS = 500;
const LEGACY_AGENT_STOP_TIMEOUT_MS = 5_000;
const LEGACY_AGENT_STOP_POLL_MS = 100;
const LEGACY_SOCKET_REMOVAL_WAIT_MS = 500;
const LEGACY_SOCKET_REMOVAL_POLL_MS = 25;

type LegacyAgentRequest =
  | { command: "status" }
  | { command: "lock" };

type LegacyAgentResponse =
  | {
    ok: true;
    unlockUntilUnixMs?: number | null;
  }
  | {
    ok?: false;
    error?: string;
  };

type LegacyAgentRequestResult =
  | { kind: "ok"; response: unknown }
  | { kind: "missing" }
  | { kind: "stale" }
  | { kind: "invalid" };

export interface LegacyClientPasswordCleanupDependencies {
  runCleanupPass?(context: ClientPasswordResolvedContext): Promise<void>;
}

const inFlightCleanupByStateRoot = new Map<string, Promise<void>>();

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWindowsHostPlatform(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

function isLegacyStatusResponse(value: unknown): value is { ok: true; unlockUntilUnixMs?: number | null } {
  if (value === null || typeof value !== "object" || (value as { ok?: unknown }).ok !== true) {
    return false;
  }

  const unlockUntilUnixMs = (value as { unlockUntilUnixMs?: unknown }).unlockUntilUnixMs;
  return unlockUntilUnixMs === undefined
    || unlockUntilUnixMs === null
    || Number.isFinite(unlockUntilUnixMs);
}

function isLegacyLockResponse(value: unknown): value is { ok: true } {
  return value !== null
    && typeof value === "object"
    && (value as { ok?: unknown }).ok === true;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isExactCommandArgument(command: string, argument: string): boolean {
  return new RegExp(`(^|\\s|["'])${escapeRegex(argument)}(?=$|\\s|["'])`).test(command);
}

function isLegacyAgentCommand(command: string, endpoint: string): boolean {
  return command.includes(LEGACY_AGENT_MARKER)
    && isExactCommandArgument(command, endpoint);
}

async function sendLegacyAgentRequest(options: {
  endpoint: string;
  request: LegacyAgentRequest;
  hostPlatform: NodeJS.Platform;
  timeoutMs?: number;
}): Promise<LegacyAgentRequestResult> {
  return await new Promise<LegacyAgentRequestResult>((resolve) => {
    const socket = net.createConnection(options.endpoint);
    const timeoutMs = options.timeoutMs ?? LEGACY_AGENT_TIMEOUT_MS;
    let settled = false;
    let received = "";

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      socket.off("close", onClose);
    };

    const finish = (result: LegacyAgentRequestResult) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ kind: "invalid" });
    }, timeoutMs);
    timer.unref();

    const onConnect = () => {
      socket.write(`${JSON.stringify(options.request)}\n`);
    };

    const onData = (chunk: Buffer) => {
      received += chunk.toString("utf8");
      const newlineIndex = received.indexOf("\n");

      if (newlineIndex === -1) {
        return;
      }

      try {
        finish({
          kind: "ok",
          response: JSON.parse(received.slice(0, newlineIndex)) as LegacyAgentResponse,
        });
      } catch {
        finish({ kind: "invalid" });
      }
    };

    const onError = (error: Error) => {
      const code = error instanceof Error && "code" in error
        ? String((error as NodeJS.ErrnoException).code ?? "")
        : "";

      if (code === "ENOENT") {
        finish({ kind: "missing" });
        return;
      }

      if (
        !isWindowsHostPlatform(options.hostPlatform)
        && (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE")
      ) {
        finish({ kind: "stale" });
        return;
      }

      finish({ kind: "invalid" });
    };

    const onEnd = () => {
      if (received.length === 0) {
        finish({ kind: "invalid" });
      }
    };

    const onClose = () => {
      if (received.length === 0) {
        finish({ kind: "invalid" });
      }
    };

    socket.on("connect", onConnect);
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("end", onEnd);
    socket.on("close", onClose);
  });
}

async function waitForLegacySocketCleanup(endpoint: string): Promise<void> {
  const deadline = Date.now() + LEGACY_SOCKET_REMOVAL_WAIT_MS;

  while (Date.now() < deadline) {
    if (!await pathExists(endpoint)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, LEGACY_SOCKET_REMOVAL_POLL_MS));
  }

  const probe = await sendLegacyAgentRequest({
    endpoint,
    request: { command: "status" },
    hostPlatform: process.platform,
    timeoutMs: LEGACY_AGENT_TIMEOUT_MS,
  });

  if (probe.kind === "missing" || probe.kind === "stale") {
    await rm(endpoint, { force: true }).catch(() => undefined);
  }
}

async function cleanupLegacyAgentEndpoint(options: {
  stateRoot: string;
  hostPlatform: NodeJS.Platform;
}): Promise<void> {
  const endpoint = resolveLegacyClientPasswordAgentEndpointForTesting(
    options.stateRoot,
    options.hostPlatform,
  );
  const status = await sendLegacyAgentRequest({
    endpoint,
    request: { command: "status" },
    hostPlatform: options.hostPlatform,
  });

  if (status.kind === "missing") {
    return;
  }

  if (status.kind === "stale") {
    if (!isWindowsHostPlatform(options.hostPlatform)) {
      await rm(endpoint, { force: true }).catch(() => undefined);
    }
    return;
  }

  if (status.kind !== "ok" || !isLegacyStatusResponse(status.response)) {
    return;
  }

  const lock = await sendLegacyAgentRequest({
    endpoint,
    request: { command: "lock" },
    hostPlatform: options.hostPlatform,
  });

  if (lock.kind === "ok" && isLegacyLockResponse(lock.response) && !isWindowsHostPlatform(options.hostPlatform)) {
    await waitForLegacySocketCleanup(endpoint).catch(() => undefined);
  }
}

export function resolveLegacyClientPasswordAgentEndpointForTesting(
  stateRoot: string,
  hostPlatform: NodeJS.Platform = process.platform,
): string {
  const hash = createHash("sha256").update(stateRoot).digest("hex").slice(0, 24);

  if (isWindowsHostPlatform(hostPlatform)) {
    return `\\\\.\\pipe\\cogcoin-client-password-${hash}`;
  }

  return join(tmpdir(), `cogcoin-client-password-${hash}.sock`);
}

export function extractLegacyClientPasswordAgentProcessIdsForTesting(options: {
  endpoint: string;
  hostPlatform: NodeJS.Platform;
  stdout: string;
}): number[] {
  const matches = new Set<number>();

  if (isWindowsHostPlatform(options.hostPlatform)) {
    const trimmed = options.stdout.trim();

    if (trimmed.length === 0 || trimmed === "null") {
      return [];
    }

    const parsed = JSON.parse(trimmed) as unknown;
    const entries = Array.isArray(parsed) ? parsed : [parsed];

    for (const entry of entries) {
      const processId = typeof (entry as { ProcessId?: unknown }).ProcessId === "number"
        ? (entry as { ProcessId: number }).ProcessId
        : typeof (entry as { processId?: unknown }).processId === "number"
          ? (entry as { processId: number }).processId
          : null;
      const commandLine = typeof (entry as { CommandLine?: unknown }).CommandLine === "string"
        ? (entry as { CommandLine: string }).CommandLine
        : typeof (entry as { commandLine?: unknown }).commandLine === "string"
          ? (entry as { commandLine: string }).commandLine
          : "";

      if (processId !== null && isLegacyAgentCommand(commandLine, options.endpoint)) {
        matches.add(processId);
      }
    }

    return [...matches];
  }

  for (const line of options.stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);

    if (match === null) {
      continue;
    }

    const processId = Number(match[1]);
    const command = match[2] ?? "";

    if (Number.isInteger(processId) && isLegacyAgentCommand(command, options.endpoint)) {
      matches.add(processId);
    }
  }

  return [...matches];
}

async function listLegacyAgentProcessIds(options: {
  endpoint: string;
  hostPlatform: NodeJS.Platform;
}): Promise<number[]> {
  if (isWindowsHostPlatform(options.hostPlatform)) {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ]);
    return extractLegacyClientPasswordAgentProcessIdsForTesting({
      endpoint: options.endpoint,
      hostPlatform: options.hostPlatform,
      stdout,
    });
  }

  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="]);
  return extractLegacyClientPasswordAgentProcessIdsForTesting({
    endpoint: options.endpoint,
    hostPlatform: options.hostPlatform,
    stdout,
  });
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }

    return true;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + LEGACY_AGENT_STOP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (!await isProcessAlive(pid)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, LEGACY_AGENT_STOP_POLL_MS));
  }
}

async function stopLegacyAgentProcess(pid: number): Promise<void> {
  if (pid === process.pid || !await isProcessAlive(pid)) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH")) {
      throw error;
    }
  }

  try {
    await waitForProcessExit(pid);
    return;
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH")) {
        throw error;
      }
    }
  }

  await waitForProcessExit(pid).catch(() => undefined);
}

async function cleanupLegacyAgentProcesses(options: {
  stateRoot: string;
  hostPlatform: NodeJS.Platform;
}): Promise<void> {
  const endpoint = resolveLegacyClientPasswordAgentEndpointForTesting(
    options.stateRoot,
    options.hostPlatform,
  );
  const processIds = await listLegacyAgentProcessIds({
    endpoint,
    hostPlatform: options.hostPlatform,
  });

  for (const pid of processIds) {
    await stopLegacyAgentProcess(pid).catch(() => undefined);
  }
}

async function pruneLegacyRuntimeLeak(stateRoot: string): Promise<void> {
  const legacyRuntimeRoot = join(stateRoot, ".client-runtime");
  const entries = await readdir(legacyRuntimeRoot).catch(() => null);

  if (entries === null || entries.length > 0) {
    return;
  }

  await rmdir(legacyRuntimeRoot).catch(() => undefined);
}

async function runDefaultCleanupPass(context: ClientPasswordResolvedContext): Promise<void> {
  const hostPlatform = process.platform;

  await cleanupLegacyAgentEndpoint({
    stateRoot: context.stateRoot,
    hostPlatform,
  }).catch(() => undefined);
  await cleanupLegacyAgentProcesses({
    stateRoot: context.stateRoot,
    hostPlatform,
  }).catch(() => undefined);
  await pruneLegacyRuntimeLeak(context.stateRoot).catch(() => undefined);
}

export async function cleanupLegacyClientPasswordArtifactsResolved(
  context: ClientPasswordResolvedContext,
  deps: LegacyClientPasswordCleanupDependencies = {},
): Promise<void> {
  const cacheKey = context.stateRoot;
  const inFlight = inFlightCleanupByStateRoot.get(cacheKey);

  if (inFlight !== undefined) {
    await inFlight;
    return;
  }

  const cleanupPromise = (deps.runCleanupPass ?? runDefaultCleanupPass)(context).catch(() => undefined);
  inFlightCleanupByStateRoot.set(cacheKey, cleanupPromise);

  try {
    await cleanupPromise;
  } finally {
    if (inFlightCleanupByStateRoot.get(cacheKey) === cleanupPromise) {
      inFlightCleanupByStateRoot.delete(cacheKey);
    }
  }
}
