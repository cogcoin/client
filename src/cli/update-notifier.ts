import { readFile } from "node:fs/promises";

import { writeJsonFileAtomic } from "../wallet/fs/atomic.js";
import { writeLine } from "./io.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "./types.js";

const UPDATE_CHECK_CACHE_SCHEMA_VERSION = 1;
const UPDATE_CHECK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 500;
const UPDATE_CHECK_URL = "https://registry.npmjs.org/@cogcoin/client/latest";

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<{
    raw: string;
    numeric: boolean;
    numericValue: number | null;
  }>;
}

interface UpdateCheckCache {
  schemaVersion: typeof UPDATE_CHECK_CACHE_SCHEMA_VERSION;
  lastCheckedAtUnixMs: number;
  latestVersion: string | null;
  lastNotifiedCurrentVersion: string | null;
  lastNotifiedLatestVersion: string | null;
  lastNotifiedAtUnixMs: number | null;
  lastCheckErrorKind?: string;
}

type UpdateCheckResult =
  | {
    kind: "success";
    latestVersion: string;
  }
  | {
    kind: "failure";
    errorKind: string;
  };

function createEmptyUpdateCheckCache(): UpdateCheckCache {
  return {
    schemaVersion: UPDATE_CHECK_CACHE_SCHEMA_VERSION,
    lastCheckedAtUnixMs: 0,
    latestVersion: null,
    lastNotifiedCurrentVersion: null,
    lastNotifiedLatestVersion: null,
    lastNotifiedAtUnixMs: null,
  };
}

function parseSemver(version: string): ParsedSemver | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version.trim());

  if (match === null) {
    return null;
  }

  const prerelease = match[4] === undefined
    ? []
    : match[4].split(".").map((raw) => ({
      raw,
      numeric: /^(0|[1-9]\d*)$/.test(raw),
      numericValue: /^(0|[1-9]\d*)$/.test(raw) ? Number(raw) : null,
    }));

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function compareSemver(left: string, right: string): number | null {
  const leftParsed = parseSemver(left);
  const rightParsed = parseSemver(right);

  if (leftParsed === null || rightParsed === null) {
    return null;
  }

  if (leftParsed.major !== rightParsed.major) {
    return leftParsed.major > rightParsed.major ? 1 : -1;
  }

  if (leftParsed.minor !== rightParsed.minor) {
    return leftParsed.minor > rightParsed.minor ? 1 : -1;
  }

  if (leftParsed.patch !== rightParsed.patch) {
    return leftParsed.patch > rightParsed.patch ? 1 : -1;
  }

  if (leftParsed.prerelease.length === 0 && rightParsed.prerelease.length === 0) {
    return 0;
  }

  if (leftParsed.prerelease.length === 0) {
    return 1;
  }

  if (rightParsed.prerelease.length === 0) {
    return -1;
  }

  const maxLength = Math.max(leftParsed.prerelease.length, rightParsed.prerelease.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftIdentifier = leftParsed.prerelease[index];
    const rightIdentifier = rightParsed.prerelease[index];

    if (leftIdentifier === undefined) {
      return -1;
    }

    if (rightIdentifier === undefined) {
      return 1;
    }

    if (leftIdentifier.numeric && rightIdentifier.numeric) {
      if (leftIdentifier.numericValue !== rightIdentifier.numericValue) {
        return leftIdentifier.numericValue! > rightIdentifier.numericValue! ? 1 : -1;
      }
      continue;
    }

    if (leftIdentifier.numeric !== rightIdentifier.numeric) {
      return leftIdentifier.numeric ? -1 : 1;
    }

    if (leftIdentifier.raw !== rightIdentifier.raw) {
      return leftIdentifier.raw > rightIdentifier.raw ? 1 : -1;
    }
  }

  return 0;
}

function isUpdateCheckDisabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.COGCOIN_DISABLE_UPDATE_CHECK;

  if (raw === undefined) {
    return false;
  }

  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isEligibleForUpdateNotification(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): boolean {
  if (parsed.outputMode !== "text" || parsed.help || parsed.version) {
    return false;
  }

  return context.stdout.isTTY === true || context.stderr.isTTY === true;
}

function normalizeUpdateCheckCache(parsed: unknown): UpdateCheckCache | null {
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;

  if (candidate.schemaVersion !== UPDATE_CHECK_CACHE_SCHEMA_VERSION) {
    return null;
  }

  return {
    schemaVersion: UPDATE_CHECK_CACHE_SCHEMA_VERSION,
    lastCheckedAtUnixMs: typeof candidate.lastCheckedAtUnixMs === "number" ? candidate.lastCheckedAtUnixMs : 0,
    latestVersion: typeof candidate.latestVersion === "string" ? candidate.latestVersion : null,
    lastNotifiedCurrentVersion: typeof candidate.lastNotifiedCurrentVersion === "string"
      ? candidate.lastNotifiedCurrentVersion
      : null,
    lastNotifiedLatestVersion: typeof candidate.lastNotifiedLatestVersion === "string"
      ? candidate.lastNotifiedLatestVersion
      : null,
    lastNotifiedAtUnixMs: typeof candidate.lastNotifiedAtUnixMs === "number"
      ? candidate.lastNotifiedAtUnixMs
      : null,
    lastCheckErrorKind: typeof candidate.lastCheckErrorKind === "string"
      ? candidate.lastCheckErrorKind
      : undefined,
  };
}

async function loadUpdateCheckCache(cachePath: string): Promise<UpdateCheckCache | null> {
  try {
    const raw = await readFile(cachePath, "utf8");
    return normalizeUpdateCheckCache(JSON.parse(raw));
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    return null;
  }
}

function shouldRefreshUpdateCheck(cache: UpdateCheckCache, now: number): boolean {
  return now - cache.lastCheckedAtUnixMs >= UPDATE_CHECK_MAX_AGE_MS;
}

function shouldNotifyForVersionPair(
  cache: UpdateCheckCache,
  currentVersion: string,
  latestVersion: string,
  now: number,
): boolean {
  const versionComparison = compareSemver(latestVersion, currentVersion);

  if (versionComparison === null || versionComparison <= 0) {
    return false;
  }

  if (
    cache.lastNotifiedCurrentVersion !== currentVersion
    || cache.lastNotifiedLatestVersion !== latestVersion
  ) {
    return true;
  }

  if (cache.lastNotifiedAtUnixMs === null) {
    return true;
  }

  return now - cache.lastNotifiedAtUnixMs >= UPDATE_CHECK_MAX_AGE_MS;
}

function recordUpdateNotification(
  cache: UpdateCheckCache,
  currentVersion: string,
  latestVersion: string,
  now: number,
): UpdateCheckCache {
  return {
    ...cache,
    lastNotifiedCurrentVersion: currentVersion,
    lastNotifiedLatestVersion: latestVersion,
    lastNotifiedAtUnixMs: now,
  };
}

async function fetchLatestPublishedVersion(
  fetchImpl: typeof fetch,
): Promise<UpdateCheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, UPDATE_CHECK_TIMEOUT_MS);

  try {
    const response = await fetchImpl(UPDATE_CHECK_URL, {
      headers: {
        accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        kind: "failure",
        errorKind: `http_${response.status}`,
      };
    }

    let payload: unknown;

    try {
      payload = await response.json();
    } catch {
      return {
        kind: "failure",
        errorKind: "invalid_json",
      };
    }

    const latestVersion = typeof (payload as { version?: unknown }).version === "string"
      ? (payload as { version: string }).version
      : null;

    if (latestVersion === null) {
      return {
        kind: "failure",
        errorKind: "invalid_payload",
      };
    }

    if (parseSemver(latestVersion) === null) {
      return {
        kind: "failure",
        errorKind: "invalid_semver",
      };
    }

    return {
      kind: "success",
      latestVersion,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        kind: "failure",
        errorKind: "timeout",
      };
    }

    return {
      kind: "failure",
      errorKind: "network",
    };
  } finally {
    clearTimeout(timer);
  }
}

function writeUpdateNotice(
  context: RequiredCliRunnerContext,
  currentVersion: string,
  latestVersion: string,
): void {
  writeLine(context.stderr, `Update available: Cogcoin ${currentVersion} -> ${latestVersion}`);
  writeLine(context.stderr, "Run: npm install -g @cogcoin/client");
}

async function persistUpdateCheckCache(
  cachePath: string,
  cache: UpdateCheckCache,
): Promise<void> {
  await writeJsonFileAtomic(cachePath, cache);
}

export async function maybeNotifyAboutCliUpdate(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): Promise<void> {
  try {
    if (!isEligibleForUpdateNotification(parsed, context) || isUpdateCheckDisabled(context.env)) {
      return;
    }

    const currentVersion = await context.readPackageVersion();

    if (parseSemver(currentVersion) === null) {
      return;
    }

    const cachePath = context.resolveUpdateCheckStatePath();
    const now = context.now();
    let cache = await loadUpdateCheckCache(cachePath) ?? createEmptyUpdateCheckCache();
    let cacheChanged = false;

    if (shouldRefreshUpdateCheck(cache, now)) {
      const updateResult = await fetchLatestPublishedVersion(context.fetchImpl);
      cache = {
        ...cache,
        lastCheckedAtUnixMs: now,
        latestVersion: updateResult.kind === "success"
          ? updateResult.latestVersion
          : cache.latestVersion,
        lastCheckErrorKind: updateResult.kind === "success"
          ? undefined
          : updateResult.errorKind,
      };
      cacheChanged = true;
    }

    if (
      cache.latestVersion !== null
      && shouldNotifyForVersionPair(cache, currentVersion, cache.latestVersion, now)
    ) {
      writeUpdateNotice(context, currentVersion, cache.latestVersion);
      cache = recordUpdateNotification(cache, currentVersion, cache.latestVersion, now);
      cacheChanged = true;
      await persistUpdateCheckCache(cachePath, cache);
      return;
    }

    if (cacheChanged) {
      await persistUpdateCheckCache(cachePath, cache);
    }
  } catch {
    // Update checks are best-effort only.
  }
}
