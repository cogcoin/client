import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_SNAPSHOT_METADATA } from "../../bitcoind/bootstrap/constants.js";
import { resolveBootstrapPathsForTesting } from "../../bitcoind/bootstrap/paths.js";
import { validateSnapshotFileForTesting } from "../../bitcoind/bootstrap/snapshot-file.js";
import type { WalletSecretProvider } from "../state/provider.js";
import {
  loadRawWalletStateEnvelope,
} from "../state/storage.js";
import { resolveWalletRuntimePathsForTesting } from "../runtime.js";

import {
  isDeletedByRemovalPlan,
  pathExists,
  readJsonFileOrNull,
  resolveRemovedRoots,
} from "./artifacts.js";
import { collectTrackedManagedProcesses } from "./process-cleanup.js";
import type {
  WalletResetArtifactDependencies,
  WalletResetPreflight,
  WalletResetPreflightOptions,
} from "./types.js";

function providerUsesExternalSecretStore(provider: WalletSecretProvider): boolean {
  return provider.kind === "macos-keychain";
}

export function resetDeletesOsSecrets(options: {
  provider: WalletSecretProvider;
  preflight: WalletResetPreflight;
}): boolean {
  return providerUsesExternalSecretStore(options.provider)
    && (
      options.preflight.wallet.secretProviderKeyId !== null
      || options.preflight.wallet.importedSeedSecretProviderKeyIds.length > 0
    );
}

async function collectLegacyImportedSeedSecretProviderKeyIds(
  stateRoot: string,
  deps: WalletResetArtifactDependencies = {},
): Promise<string[]> {
  const seedsRoot = join(stateRoot, "seeds");
  const entries = await readdir(seedsRoot, { withFileTypes: true }).catch((error) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  });
  const keyIds = new Set<string>();

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const seedRoot = join(seedsRoot, entry.name);
    const candidatePaths = [
      join(seedRoot, "wallet-state.enc"),
      join(seedRoot, "wallet-state.enc.bak"),
      join(seedRoot, "wallet-init-pending.enc"),
      join(seedRoot, "wallet-init-pending.enc.bak"),
    ];

    for (const candidatePath of candidatePaths) {
      const envelope = await readJsonFileOrNull<{ secretProvider?: { keyId?: string | null } | null }>(
        candidatePath,
        deps,
      );
      const keyId = envelope?.secretProvider?.keyId?.trim() ?? "";

      if (keyId.length > 0) {
        keyIds.add(keyId);
      }
    }
  }

  return [...keyIds].sort((left, right) => left.localeCompare(right));
}

export async function preflightReset(
  options: WalletResetPreflightOptions,
): Promise<WalletResetPreflight> {
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const removedRoots = resolveRemovedRoots(paths);
  const rawEnvelope = await loadRawWalletStateEnvelope({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  });
  const snapshotPaths = resolveBootstrapPathsForTesting(options.dataDir, DEFAULT_SNAPSHOT_METADATA);
  const validateSnapshot = options.validateSnapshotFile
    ?? ((path: string) => validateSnapshotFileForTesting(path, DEFAULT_SNAPSHOT_METADATA));
  const artifactDeps = options.artifactDeps ?? {};
  const hasWalletState = await pathExists(paths.walletStatePath, artifactDeps)
    || await pathExists(paths.walletStateBackupPath, artifactDeps);
  const hasBitcoinDataDir = await pathExists(options.dataDir, artifactDeps);
  const bitcoinDataDirWithinResetScope = hasBitcoinDataDir
    && isDeletedByRemovalPlan(removedRoots, options.dataDir);
  const hasSnapshot = await pathExists(snapshotPaths.snapshotPath, artifactDeps);
  const hasPartialSnapshot = await pathExists(snapshotPaths.partialSnapshotPath, artifactDeps);

  let snapshotStatus: WalletResetPreflight["snapshot"]["status"] = "not-present";
  if (hasSnapshot) {
    try {
      await validateSnapshot(snapshotPaths.snapshotPath);
      snapshotStatus = "valid";
    } catch {
      snapshotStatus = "invalid";
    }
  } else if (hasPartialSnapshot) {
    snapshotStatus = "invalid";
  }

  const tracked = await collectTrackedManagedProcesses(paths, options.processCleanupDeps);
  const secretProviderKeyId = rawEnvelope?.envelope.secretProvider?.keyId ?? null;
  const importedSeedSecretProviderKeyIds = await collectLegacyImportedSeedSecretProviderKeyIds(
    paths.stateRoot,
    artifactDeps,
  );

  return {
    dataRoot: paths.dataRoot,
    removedRoots,
    wallet: {
      present: hasWalletState,
      mode: rawEnvelope == null
        ? (hasWalletState ? "unknown" : "unknown")
        : rawEnvelope.envelope.secretProvider != null
          ? "provider-backed"
          : "unsupported-legacy",
      envelopeSource: rawEnvelope?.source ?? null,
      secretProviderKeyId,
      importedSeedSecretProviderKeyIds,
      rawEnvelope,
    },
    snapshot: {
      status: snapshotStatus,
      path: snapshotPaths.snapshotPath,
      shouldPrompt: snapshotStatus === "valid",
      withinResetScope: isDeletedByRemovalPlan(removedRoots, snapshotPaths.snapshotPath),
    },
    bitcoinDataDir: {
      status: !hasBitcoinDataDir
        ? "not-present"
        : bitcoinDataDirWithinResetScope
          ? "within-reset-scope"
          : "outside-reset-scope",
      path: options.dataDir,
      shouldPrompt: bitcoinDataDirWithinResetScope,
    },
    trackedProcesses: tracked.trackedProcesses,
    trackedProcessKinds: tracked.trackedProcessKinds,
    serviceLockPaths: tracked.serviceLockPaths,
  };
}
