import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  constants,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { HookClientStateRecord } from "../types.js";
import {
  MINING_HOOK_COOLDOWN_MS,
  MINING_HOOK_FAILURE_THRESHOLD,
  MINING_HOOK_STDERR_MAX_BYTES,
  MINING_HOOK_STDOUT_MAX_BYTES,
  MINING_HOOK_TERMINATE_GRACE_MS,
  MINING_HOOK_VALIDATION_TIMEOUT_MS,
} from "./constants.js";
import {
  MINING_HOOK_VALIDATION_FIXTURES,
  type GenerateSentencesHookCandidateV1,
  type GenerateSentencesHookRequestV1,
  type GenerateSentencesHookResponseV1,
  type MiningHookOperatorValidationState,
  normalizeHookResponse,
  parseStrictJsonValue,
} from "./hook-protocol.js";
import type { MiningHookInspection } from "./types.js";

const DEFAULT_MINING_HOOK_TEMPLATE = `export async function generateSentences(request) {
  const domains = Array.isArray(request?.rootDomains) ? request.rootDomains : [];
  const candidates = domains.map((domain) => {
    const requiredWords = Array.isArray(domain?.requiredWords)
      ? domain.requiredWords.filter((word) => typeof word === "string" && word.length > 0).join(" ")
      : "abandon ability able about above";
    const domainName = typeof domain?.domainName === "string" && domain.domainName.length > 0
      ? domain.domainName
      : "domain";

    return {
      domainId: domain.domainId,
      sentence: \`\${domainName} sentence using \${requiredWords}.\`,
    };
  });

  return {
    schemaVersion: 1,
    requestId: typeof request?.requestId === "string" ? request.requestId : "",
    candidates,
  };
}
`;

const DEFAULT_MINING_HOOK_PACKAGE_JSON = {
  name: "cogcoin-mining-hooks",
  private: true,
  type: "module",
};

const HOOK_ENV_ALLOWLIST = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

const RECOGNIZED_LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
] as const;

interface HookPackageAssessment {
  status: "valid" | "missing" | "invalid";
  message: string | null;
}

interface HookRunnerOutput {
  stdout: string;
  stderr: string;
}

function mapStoredValidationState(
  raw: HookClientStateRecord["validationState"] | undefined | null,
): MiningHookOperatorValidationState {
  switch (raw) {
    case "current":
    case "validated":
      return "current";
    case "stale":
      return "stale";
    case "failed":
      return "failed";
    default:
      return "never";
  }
}

function mapOperatorToLegacyValidationState(
  operatorState: MiningHookOperatorValidationState,
): Exclude<MiningHookInspection["validationState"], "unavailable"> {
  switch (operatorState) {
    case "current":
      return "validated";
    case "stale":
      return "stale";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function listFilesRecursively(
  root: string,
  options: {
    includeNodeModules: boolean;
  },
): Promise<string[]> {
  let entries;

  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    const relativePath = relative(root, fullPath);
    const isNodeModules = entry.name === "node_modules";
    const isExcludedRoot = entry.name === ".cache" || entry.name === "tmp" || entry.name === "logs";

    if (entry.isDirectory()) {
      if ((!options.includeNodeModules && isNodeModules) || isExcludedRoot) {
        continue;
      }

      if (options.includeNodeModules && relativePath === join("node_modules", ".cache")) {
        continue;
      }

      files.push(...await listFilesRecursively(fullPath, options));
      continue;
    }

    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

async function computeFingerprint(options: {
  root: string;
  includeNodeModules: boolean;
}): Promise<string | null> {
  const files = await listFilesRecursively(options.root, {
    includeNodeModules: options.includeNodeModules,
  });

  if (files.length === 0) {
    return null;
  }

  const descriptors = await Promise.all(
    files
      .sort()
      .map(async (filePath) => ({
        relativePath: relative(options.root, filePath),
        sha256Hex: await hashFile(filePath),
      })),
  );
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    schemaVersion: 1,
    files: descriptors,
  }));
  return hash.digest("hex");
}

async function assessPackageJson(packagePath: string): Promise<HookPackageAssessment> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(packagePath, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        status: "missing",
        message: "package.json is missing for the custom mining hook.",
      };
    }

    return {
      status: "invalid",
      message: "package.json is not valid JSON or could not be read.",
    };
  }

  if (
    parsed === null
    || typeof parsed !== "object"
    || (parsed as { type?: unknown }).type !== "module"
  ) {
    return {
      status: "invalid",
      message: "package.json must set \"type\": \"module\" for custom mining hooks.",
    };
  }

  return {
    status: "valid",
    message: null,
  };
}

async function collectTrustPaths(options: {
  hookRootPath: string;
  entrypointPath: string;
  packagePath: string;
}): Promise<string[]> {
  const trustPaths = [
    dirname(options.hookRootPath),
    options.hookRootPath,
    options.entrypointPath,
    options.packagePath,
  ];

  for (const lockfile of RECOGNIZED_LOCKFILES) {
    const lockfilePath = `${options.hookRootPath}/${lockfile}`;
    if (await pathExists(lockfilePath)) {
      trustPaths.push(lockfilePath);
    }
  }

  const nodeModulesPath = `${options.hookRootPath}/node_modules`;
  if (await pathExists(nodeModulesPath)) {
    trustPaths.push(nodeModulesPath);
  }

  return [...new Set(trustPaths)];
}

function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function assessTrust(options: {
  hookRootPath: string;
  entrypointPath: string;
  packagePath: string;
}): Promise<{
  status: "trusted" | "untrusted" | "missing";
  message: string | null;
}> {
  const trustPaths = await collectTrustPaths(options);
  const hooksRootPath = dirname(options.hookRootPath);

  let hooksRootRealPath: string;
  try {
    hooksRootRealPath = await realpath(hooksRootPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        status: "missing",
        message: `Hook path ${hooksRootPath} does not exist yet.`,
      };
    }

    throw error;
  }

  for (const path of trustPaths) {
    let metadata;

    try {
      metadata = await lstat(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          status: "missing",
          message: `Hook path ${path} does not exist yet.`,
        };
      }

      throw error;
    }

    if (metadata.isSymbolicLink()) {
      return {
        status: "untrusted",
        message: `Hook path ${path} uses a symbolic link or reparse point.`,
      };
    }

    const canonicalPath = await realpath(path);
    if (!isPathInsideRoot(hooksRootRealPath, canonicalPath)) {
      return {
        status: "untrusted",
        message: `Hook path ${path} resolves outside the Cogcoin hooks root.`,
      };
    }

    if (process.platform === "win32") {
      continue;
    }

    const resolvedMetadata = await stat(path);
    if (typeof process.getuid === "function" && resolvedMetadata.uid !== process.getuid()) {
      return {
        status: "untrusted",
        message: `Hook path ${path} is not owned by the current user.`,
      };
    }

    if ((resolvedMetadata.mode & 0o022) !== 0) {
      return {
        status: "untrusted",
        message: `Hook path ${path} is writable by group or others.`,
      };
    }
  }

  return {
    status: "trusted",
    message: null,
  };
}

function buildHookChildEnvironment(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    COGCOIN_HOOK_KIND: "mining/generate-sentences",
    COGCOIN_HOOK_SCHEMA_VERSION: "1",
    NODE_ENV: "production",
    TZ: "UTC",
  };

  for (const key of HOOK_ENV_ALLOWLIST) {
    const value = parentEnv[key];
    if (typeof value === "string" && value.length > 0) {
      environment[key] = value;
    }
  }

  return environment;
}

async function terminateChildProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  child.kill("SIGTERM");

  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), MINING_HOOK_TERMINATE_GRACE_MS);
    child.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
    }
  }
}

async function runHookRunner(options: {
  hookRootPath: string;
  entrypointPath: string;
  request: GenerateSentencesHookRequestV1;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<HookRunnerOutput> {
  const runnerPath = fileURLToPath(new URL("./hook-runner.js", import.meta.url));
  const child = spawn(process.execPath, [
    runnerPath,
    options.entrypointPath,
  ], {
    cwd: options.hookRootPath,
    env: buildHookChildEnvironment(process.env),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  let aborted = false;
  let stdoutOverflow = false;
  let stderrOverflow = false;
  let terminated: Promise<void> | null = null;

  const terminate = () => {
    terminated ??= terminateChildProcess(child);
    return terminated;
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    void terminate();
  }, options.timeoutMs);

  const abortListener = () => {
    aborted = true;
    void terminate();
  };
  options.signal?.addEventListener("abort", abortListener, { once: true });

  child.stdin.on("error", () => undefined);
  child.stdin.end(`${JSON.stringify(options.request)}\n`, "utf8");

  child.stdout.on("data", (chunk: Buffer | string) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    stdoutBytes += Buffer.byteLength(text);
    if (stdoutBytes > MINING_HOOK_STDOUT_MAX_BYTES) {
      stdoutOverflow = true;
      void terminate();
      return;
    }

    stdout += text;
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    stderrBytes += Buffer.byteLength(text);
    if (stderrBytes > MINING_HOOK_STDERR_MAX_BYTES) {
      stderrOverflow = true;
      void terminate();
      return;
    }

    stderr += text;
  });

  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  clearTimeout(timeout);
  options.signal?.removeEventListener("abort", abortListener);

  if (stdoutOverflow) {
    throw new Error(`Custom mining hook stdout exceeded ${MINING_HOOK_STDOUT_MAX_BYTES} bytes.`);
  }

  if (stderrOverflow) {
    throw new Error(`Custom mining hook stderr exceeded ${MINING_HOOK_STDERR_MAX_BYTES} bytes.`);
  }

  if (timedOut) {
    throw new Error("Custom mining hook request timed out.");
  }

  if (aborted) {
    throw new Error("Custom mining hook request aborted.");
  }

  if (exit.code !== 0 || exit.signal !== null) {
    const diagnostic = stderr.trim().length > 0
      ? stderr.trim()
      : stdout.trim().length > 0
        ? stdout.trim()
        : "Custom mining hook request failed.";
    throw new Error(diagnostic);
  }

  return { stdout, stderr };
}

export async function runGenerateSentencesHookRequest(options: {
  hookRootPath: string;
  entrypointPath: string;
  request: GenerateSentencesHookRequestV1;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{
  response: GenerateSentencesHookResponseV1;
  candidates: GenerateSentencesHookCandidateV1[];
}> {
  const { stdout } = await runHookRunner({
    hookRootPath: options.hookRootPath,
    entrypointPath: options.entrypointPath,
    request: options.request,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? MINING_HOOK_VALIDATION_TIMEOUT_MS,
  });
  const response = parseStrictJsonValue(stdout, "Custom mining hook stdout was not valid JSON.");
  return normalizeHookResponse({
    request: options.request,
    response,
  });
}

export async function ensureMiningHookTemplate(options: {
  hookRootPath: string;
  entrypointPath: string;
  packagePath: string;
}): Promise<boolean> {
  const entrypointExists = await pathExists(options.entrypointPath);
  let created = false;

  if (!entrypointExists) {
    await mkdir(options.hookRootPath, { recursive: true });
    await writeFile(options.entrypointPath, DEFAULT_MINING_HOOK_TEMPLATE, {
      encoding: "utf8",
      mode: 0o600,
    });
    created = true;
  }

  if (!await pathExists(options.packagePath)) {
    await mkdir(options.hookRootPath, { recursive: true });
    await writeFile(
      options.packagePath,
      `${JSON.stringify(DEFAULT_MINING_HOOK_PACKAGE_JSON, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    created = true;
  }

  return created;
}

export async function validateCustomMiningHook(options: {
  hookRootPath: string;
  entrypointPath: string;
  packagePath: string;
}): Promise<{
  launchFingerprint: string;
  fullFingerprint: string;
}> {
  const entrypointExists = await pathExists(options.entrypointPath);

  if (!entrypointExists) {
    throw new Error("Custom mining hook entrypoint is missing.");
  }

  const packageAssessment = await assessPackageJson(options.packagePath);
  if (packageAssessment.status !== "valid") {
    throw new Error(packageAssessment.message ?? "Custom mining hook package.json is invalid.");
  }

  const trust = await assessTrust(options);
  if (trust.status !== "trusted") {
    throw new Error(trust.message ?? "Custom mining hook trust checks failed.");
  }

  const launchFingerprint = await computeFingerprint({
    root: options.hookRootPath,
    includeNodeModules: false,
  });
  const fullFingerprint = await computeFingerprint({
    root: options.hookRootPath,
    includeNodeModules: true,
  });

  if (launchFingerprint === null || fullFingerprint === null) {
    throw new Error("Custom mining hook files are incomplete.");
  }

  for (const request of MINING_HOOK_VALIDATION_FIXTURES) {
    await runGenerateSentencesHookRequest({
      hookRootPath: options.hookRootPath,
      entrypointPath: options.entrypointPath,
      request,
      timeoutMs: MINING_HOOK_VALIDATION_TIMEOUT_MS,
    });
  }

  return {
    launchFingerprint,
    fullFingerprint,
  };
}

export async function inspectMiningHookState(options: {
  hookRootPath: string;
  entrypointPath: string;
  packagePath: string;
  localState: HookClientStateRecord | null;
  verify: boolean;
  nowUnixMs?: number;
}): Promise<MiningHookInspection> {
  const entrypointExists = await pathExists(options.entrypointPath);
  const packageAssessment = await assessPackageJson(options.packagePath);
  const trust = await assessTrust(options);
  const currentLaunchFingerprint = await computeFingerprint({
    root: options.hookRootPath,
    includeNodeModules: false,
  });
  const currentFullFingerprint = options.verify
    ? await computeFingerprint({
      root: options.hookRootPath,
      includeNodeModules: true,
    })
    : null;
  const storedState = options.localState;
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  let operatorValidationState = mapStoredValidationState(storedState?.validationState);

  if (storedState !== null && operatorValidationState === "current") {
    const launchFingerprintMatches = storedState.validatedLaunchFingerprint !== null
      && currentLaunchFingerprint !== null
      && storedState.validatedLaunchFingerprint === currentLaunchFingerprint;
    const fullFingerprintMatches = !options.verify
      || storedState.validatedFullFingerprint === null
      || currentFullFingerprint === null
      || storedState.validatedFullFingerprint === currentFullFingerprint;

    if (trust.status !== "trusted" || !launchFingerprintMatches || !fullFingerprintMatches) {
      operatorValidationState = "stale";
    }
  }

  const cooldownUntilUnixMs = storedState?.cooldownUntilUnixMs ?? null;
  const cooldownActive = cooldownUntilUnixMs !== null && cooldownUntilUnixMs > nowUnixMs;

  return {
    mode: storedState?.mode ?? "unavailable",
    entrypointPath: options.entrypointPath,
    packagePath: options.packagePath,
    entrypointExists,
    packageStatus: packageAssessment.status,
    packageMessage: packageAssessment.message,
    trustStatus: trust.status,
    trustMessage: trust.message,
    validationState: storedState === null
      ? "unavailable"
      : mapOperatorToLegacyValidationState(operatorValidationState),
    operatorValidationState,
    validationError: storedState?.lastValidationError ?? null,
    validatedAtUnixMs: storedState?.lastValidationAtUnixMs ?? null,
    validatedLaunchFingerprint: storedState?.validatedLaunchFingerprint ?? null,
    validatedFullFingerprint: storedState?.validatedFullFingerprint ?? null,
    currentLaunchFingerprint,
    currentFullFingerprint,
    verifyUsed: options.verify,
    cooldownUntilUnixMs,
    cooldownActive,
    consecutiveFailureCount: storedState?.consecutiveFailureCount ?? 0,
  };
}

export function shouldEnterHookCooldown(options: {
  consecutiveFailureCount: number;
  nowUnixMs: number;
}): number | null {
  return options.consecutiveFailureCount >= MINING_HOOK_FAILURE_THRESHOLD
    ? options.nowUnixMs + MINING_HOOK_COOLDOWN_MS
    : null;
}
