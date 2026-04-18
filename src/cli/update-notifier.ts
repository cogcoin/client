import { writeLine } from "./io.js";
import {
  PASSIVE_UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_CHECK_MAX_AGE_MS,
  applyUpdateCheckResult,
  compareSemver,
  createEmptyUpdateCheckCache,
  fetchLatestPublishedVersion,
  isUpdateCheckDisabled,
  loadUpdateCheckCache,
  persistUpdateCheckCache,
  recordUpdateNotification,
  shouldRefreshUpdateCheck,
  type UpdateCheckCache,
} from "./update-service.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "./types.js";

function isEligibleForUpdateNotification(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): boolean {
  if (parsed.command === "update") {
    return false;
  }

  if (parsed.outputMode !== "text" || parsed.help || parsed.version) {
    return false;
  }

  return context.stdout.isTTY === true || context.stderr.isTTY === true;
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

function writeUpdateNotice(
  context: RequiredCliRunnerContext,
  currentVersion: string,
  latestVersion: string,
): void {
  writeLine(context.stderr, `Update available: Cogcoin ${currentVersion} -> ${latestVersion}`);
  writeLine(context.stderr, "Run: npm install -g @cogcoin/client");
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
    const cachePath = context.resolveUpdateCheckStatePath();
    const now = context.now();
    let cache = await loadUpdateCheckCache(cachePath) ?? createEmptyUpdateCheckCache();
    let cacheChanged = false;

    if (shouldRefreshUpdateCheck(cache, now)) {
      const updateResult = await fetchLatestPublishedVersion(context.fetchImpl, {
        timeoutMs: PASSIVE_UPDATE_CHECK_TIMEOUT_MS,
      });
      cache = applyUpdateCheckResult(cache, updateResult, now);
      cacheChanged = true;
    }

    if (
      cache.latestVersion !== null
      && shouldNotifyForVersionPair(cache, currentVersion, cache.latestVersion, now)
    ) {
      writeUpdateNotice(context, currentVersion, cache.latestVersion);
      cache = recordUpdateNotification(cache, currentVersion, cache.latestVersion, now);
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
