import { access, constants, copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { DEFAULT_SNAPSHOT_METADATA } from "../../bitcoind/bootstrap/constants.js";
import { resolveBootstrapPathsForTesting } from "../../bitcoind/bootstrap/paths.js";
import { resolveLegacyHooksRootPath } from "../../app-paths.js";
import type { WalletRuntimePaths } from "../runtime.js";
import type {
  StagedArtifact,
  WalletResetArtifactDependencies,
} from "./types.js";

function resolveArtifactDependencies(
  overrides: WalletResetArtifactDependencies = {},
) {
  return {
    access: overrides.access ?? access,
    copyFile: overrides.copyFile ?? copyFile,
    mkdir: overrides.mkdir ?? mkdir,
    readFile: overrides.readFile ?? readFile,
    rename: overrides.rename ?? rename,
    remove: overrides.remove ?? rm,
  };
}

export async function pathExists(
  path: string,
  deps: WalletResetArtifactDependencies = {},
): Promise<boolean> {
  const resolved = resolveArtifactDependencies(deps);

  try {
    await resolved.access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

export async function readJsonFileOrNull<T>(
  path: string,
  deps: WalletResetArtifactDependencies = {},
): Promise<T | null> {
  const resolved = resolveArtifactDependencies(deps);

  try {
    return JSON.parse(await resolved.readFile(path, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    return null;
  }
}

export function isPathWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && rel !== ".");
}

export function dedupeSortedPaths(candidates: readonly string[]): string[] {
  return [...new Set(candidates)].sort((left, right) => right.length - left.length);
}

export function resolveDefaultRemovedRoots(paths: WalletRuntimePaths): string[] {
  const configRoot = dirname(paths.clientConfigPath);
  return dedupeSortedPaths([
    paths.dataRoot,
    paths.stateRoot,
    paths.runtimeRoot,
    configRoot,
  ]);
}

export function resolveBitcoindPreservingRemovedRoots(paths: WalletRuntimePaths): string[] {
  const configRoot = dirname(paths.clientConfigPath);
  return dedupeSortedPaths([
    paths.clientDataDir,
    paths.indexerRoot,
    paths.stateRoot,
    paths.runtimeRoot,
    configRoot,
    resolveLegacyHooksRootPath({
      dataRoot: paths.dataRoot,
      clientConfigPath: paths.clientConfigPath,
    }),
  ]);
}

export function resolveRemovedRoots(
  paths: WalletRuntimePaths,
  options: {
    preserveBitcoinDataDir: boolean;
  } = {
    preserveBitcoinDataDir: false,
  },
): string[] {
  return options.preserveBitcoinDataDir
    ? resolveBitcoindPreservingRemovedRoots(paths)
    : resolveDefaultRemovedRoots(paths);
}

export function isDeletedByRemovalPlan(
  removedRoots: readonly string[],
  targetPath: string,
): boolean {
  return removedRoots.some((root) => isPathWithin(root, targetPath));
}

async function moveFile(
  sourcePath: string,
  destinationPath: string,
  deps: WalletResetArtifactDependencies = {},
): Promise<void> {
  const resolved = resolveArtifactDependencies(deps);
  await resolved.mkdir(dirname(destinationPath), { recursive: true });

  try {
    await resolved.rename(sourcePath, destinationPath);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }

    await resolved.copyFile(sourcePath, destinationPath);
    await resolved.remove(sourcePath, { force: true });
  }
}

export async function stageArtifact(
  sourcePath: string,
  stagingRoot: string,
  label: string,
  deps: WalletResetArtifactDependencies = {},
): Promise<StagedArtifact | null> {
  if (!await pathExists(sourcePath, deps)) {
    return null;
  }

  const stagedPath = join(stagingRoot, label);
  await moveFile(sourcePath, stagedPath, deps);
  return {
    originalPath: sourcePath,
    stagedPath,
    restorePath: sourcePath,
  };
}

export async function restoreStagedArtifacts(
  artifacts: readonly StagedArtifact[],
  deps: WalletResetArtifactDependencies = {},
): Promise<void> {
  for (const artifact of artifacts) {
    if (!await pathExists(artifact.stagedPath, deps)) {
      continue;
    }

    await moveFile(artifact.stagedPath, artifact.restorePath, deps);
  }
}

export async function deleteRemovedRoots(
  roots: readonly string[],
  deps: WalletResetArtifactDependencies = {},
): Promise<void> {
  const resolved = resolveArtifactDependencies(deps);

  try {
    for (const root of roots) {
      await resolved.remove(root, {
        recursive: true,
        force: true,
      });
    }
  } catch {
    throw new Error("reset_data_root_delete_failed");
  }
}

export async function deleteBootstrapSnapshotArtifacts(
  dataDir: string,
  deps: WalletResetArtifactDependencies = {},
): Promise<void> {
  const resolved = resolveArtifactDependencies(deps);
  const snapshotPaths = resolveBootstrapPathsForTesting(dataDir, DEFAULT_SNAPSHOT_METADATA);

  await Promise.all([
    snapshotPaths.snapshotPath,
    snapshotPaths.partialSnapshotPath,
    snapshotPaths.statePath,
    snapshotPaths.quoteStatePath,
  ].map(async (path) => resolved.remove(path, {
    recursive: false,
    force: true,
  })));
}
