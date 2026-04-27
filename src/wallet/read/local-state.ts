import { access, constants } from "node:fs/promises";

import { normalizeWalletStateRecord, persistWalletCoinControlStateIfNeeded } from "../coin-control.js";
import { persistNormalizedWalletDescriptorStateIfNeeded } from "../descriptor-normalization.js";
import { attachOrStartManagedBitcoindService } from "../../bitcoind/service.js";
import { createRpcClient } from "../../bitcoind/node.js";
import type { RpcListUnspentEntry } from "../../bitcoind/types.js";
import { normalizeMiningStateRecord } from "../mining/state.js";
import { resolveWalletRootIdFromLocalArtifacts } from "../root-resolution.js";
import { resolveWalletRuntimePathsForTesting, type WalletRuntimePaths } from "../runtime.js";
import {
  extractWalletRootIdHintFromWalletStateEnvelope,
  loadRawWalletStateEnvelope,
  loadWalletState,
  type LoadedWalletState,
} from "../state/storage.js";
import {
  createDefaultWalletSecretProvider,
  createWalletSecretReference,
  inspectClientPasswordSetupReadiness,
  type WalletSecretProvider,
} from "../state/provider.js";
import {
  describeClientPasswordLockedMessage,
  describeClientPasswordMigrationMessage,
  describeClientPasswordSetupMessage,
} from "../state/client-password.js";
import type { WalletLocalStateStatus } from "./types.js";

type WalletLocalStateDeps = {
  attachOrStartManagedBitcoindService: typeof attachOrStartManagedBitcoindService;
  createRpcClient: typeof createRpcClient;
};

export interface FundingBalanceSummary {
  fundingDisplaySats: bigint | null;
  fundingSpendableSats: bigint | null;
}

const defaultWalletLocalStateDeps: WalletLocalStateDeps = {
  attachOrStartManagedBitcoindService,
  createRpcClient,
};

function btcAmountToSats(value: number): bigint {
  return BigInt(Math.round(value * 100_000_000));
}

function isSpendableFundingUtxo(entry: RpcListUnspentEntry, fundingScriptPubKeyHex: string): boolean {
  return entry.scriptPubKey === fundingScriptPubKeyHex
    && entry.confirmations >= 1
    && entry.spendable !== false
    && entry.safe !== false;
}

function isDisplayFundingUtxo(entry: RpcListUnspentEntry, fundingScriptPubKeyHex: string): boolean {
  return entry.scriptPubKey === fundingScriptPubKeyHex
    && entry.spendable !== false;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isWalletAccessError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("wallet_secret_missing_")
    || message.startsWith("wallet_secret_provider_")
    || message.startsWith("wallet_client_password_")
    || message === "wallet_state_legacy_envelope_unsupported";
}

function describeWalletAccessMessage(options: {
  accessError?: unknown;
}): string {
  const message = options.accessError instanceof Error ? options.accessError.message : String(options.accessError ?? "");

  if (message === "wallet_state_legacy_envelope_unsupported") {
    return "Wallet state exists but was created by an older Cogcoin wallet format that this version no longer loads directly.";
  }

  if (message === "wallet_client_password_setup_required") {
    return describeClientPasswordSetupMessage();
  }

  if (message === "wallet_client_password_migration_required") {
    return describeClientPasswordMigrationMessage();
  }

  if (message === "wallet_client_password_locked") {
    return describeClientPasswordLockedMessage();
  }

  if (message.startsWith("wallet_secret_provider_")) {
    return "Wallet state exists but the local secret provider is unavailable.";
  }

  if (message.startsWith("wallet_secret_missing_")) {
    return "Wallet state exists but its local secret-provider material is unavailable.";
  }

  return message.length > 0
    ? message
    : "Wallet state exists but could not be loaded from the local secret provider.";
}

async function normalizeLoadedWalletStateForRead(options: {
  access: { provider: WalletSecretProvider };
  dataDir?: string;
  loaded: LoadedWalletState;
  now: number;
  paths: WalletRuntimePaths;
  dependencies: WalletLocalStateDeps;
}): Promise<LoadedWalletState> {
  if (options.dataDir === undefined) {
    return options.loaded;
  }

  const node = await options.dependencies.attachOrStartManagedBitcoindService({
    dataDir: options.dataDir,
    chain: "main",
    startHeight: 0,
    walletRootId: options.loaded.state.walletRootId,
  });

  try {
    const access = {
      provider: options.access.provider,
      secretReference: createWalletSecretReference(options.loaded.state.walletRootId),
    };
    const normalized = await persistNormalizedWalletDescriptorStateIfNeeded({
      state: options.loaded.state,
      access,
      paths: options.paths,
      nowUnixMs: options.now,
      replacePrimary: options.loaded.source === "backup",
      rpc: options.dependencies.createRpcClient(node.rpc),
    });
    const coinControl = await persistWalletCoinControlStateIfNeeded({
      state: normalized.state,
      access,
      paths: options.paths,
      nowUnixMs: options.now,
      replacePrimary: (normalized.changed ? "primary" : options.loaded.source) === "backup",
      rpc: options.dependencies.createRpcClient(node.rpc),
    });

    return {
      source: coinControl.changed ? "primary" : normalized.changed ? "primary" : options.loaded.source,
      state: coinControl.state,
    };
  } finally {
    await node.stop?.().catch(() => undefined);
  }
}

export async function inspectWalletLocalStateWithDependencies(options: {
  dataDir?: string;
  secretProvider?: WalletSecretProvider;
  now?: number;
  paths?: WalletRuntimePaths;
  walletControlLockHeld?: boolean;
} = {}, dependencies: WalletLocalStateDeps = defaultWalletLocalStateDeps): Promise<WalletLocalStateStatus> {
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const now = options.now ?? Date.now();
  const provider = options.secretProvider ?? createDefaultWalletSecretProvider();
  const [hasPrimaryStateFile, hasBackupStateFile] = await Promise.all([
    pathExists(paths.walletStatePath),
    pathExists(paths.walletStateBackupPath),
  ]);
  const clientPasswordReadiness = await inspectClientPasswordSetupReadiness(provider).catch(() => "ready" as const);

  if (!hasPrimaryStateFile && !hasBackupStateFile) {
    return {
      availability: "uninitialized",
      clientPasswordReadiness,
      unlockRequired: false,
      walletRootId: null,
      state: null,
      source: null,
      hasPrimaryStateFile,
      hasBackupStateFile,
      message: "Wallet state has not been initialized yet.",
    };
  }

  if (clientPasswordReadiness !== "ready") {
    const rawEnvelope = await loadRawWalletStateEnvelope({
      primaryPath: paths.walletStatePath,
      backupPath: paths.walletStateBackupPath,
    }).catch(() => null);

    if (rawEnvelope?.envelope.secretProvider == null) {
      return {
        availability: "local-state-corrupt",
        clientPasswordReadiness: "ready",
        unlockRequired: false,
        walletRootId: extractWalletRootIdHintFromWalletStateEnvelope(rawEnvelope?.envelope ?? null),
        state: null,
        source: null,
        hasPrimaryStateFile,
        hasBackupStateFile,
        message: "Wallet state exists but was created by an older Cogcoin wallet format that this version no longer loads directly.",
      };
    }

    const resolvedRoot = await resolveWalletRootIdFromLocalArtifacts({
      paths,
      provider,
    }).catch(() => null);

    return {
      availability: "local-state-corrupt",
      clientPasswordReadiness,
      unlockRequired: false,
      walletRootId: resolvedRoot?.walletRootId ?? null,
      state: null,
      source: null,
      hasPrimaryStateFile,
      hasBackupStateFile,
      message: clientPasswordReadiness === "migration-required"
        ? describeClientPasswordMigrationMessage()
        : describeClientPasswordSetupMessage(),
    };
  }

  try {
    const loaded = await loadWalletState({
      primaryPath: paths.walletStatePath,
      backupPath: paths.walletStateBackupPath,
    }, {
      provider,
    });
    const normalized = await normalizeLoadedWalletStateForRead({
      loaded,
      access: { provider },
      dataDir: options.dataDir,
      now,
      paths,
      dependencies,
    });

    return {
      availability: "ready",
      clientPasswordReadiness,
      unlockRequired: false,
      walletRootId: normalized.state.walletRootId,
      state: normalizeWalletStateRecord({
        ...normalized.state,
        miningState: normalizeMiningStateRecord(normalized.state.miningState),
      }),
      source: normalized.source,
      hasPrimaryStateFile,
      hasBackupStateFile,
      message: null,
    };
  } catch (error) {
    const resolvedRoot = await resolveWalletRootIdFromLocalArtifacts({
      paths,
      provider,
    }).catch(() => null);
    const message = error instanceof Error ? error.message : String(error);

    return {
      availability: "local-state-corrupt",
      clientPasswordReadiness,
      unlockRequired: message === "wallet_client_password_locked",
      walletRootId: resolvedRoot?.walletRootId ?? null,
      state: null,
      source: null,
      hasPrimaryStateFile,
      hasBackupStateFile,
      message: isWalletAccessError(error)
        ? describeWalletAccessMessage({ accessError: error })
        : error instanceof Error
          ? error.message
          : String(error),
    };
  }
}

export async function inspectWalletLocalState(options: {
  dataDir?: string;
  secretProvider?: WalletSecretProvider;
  now?: number;
  paths?: WalletRuntimePaths;
  walletControlLockHeld?: boolean;
} = {}): Promise<WalletLocalStateStatus> {
  return inspectWalletLocalStateWithDependencies(options);
}

export async function readFundingSpendableSats(options: {
  state: WalletLocalStateStatus["state"];
  rpc: ReturnType<typeof createRpcClient> | null;
}): Promise<bigint | null> {
  return (await readFundingBalanceSummary(options)).fundingSpendableSats;
}

export async function readFundingBalanceSummary(options: {
  state: WalletLocalStateStatus["state"];
  rpc: Pick<ReturnType<typeof createRpcClient>, "listUnspent"> | null;
}): Promise<FundingBalanceSummary> {
  if (options.state === null || options.rpc === null) {
    return {
      fundingDisplaySats: null,
      fundingSpendableSats: null,
    };
  }

  const state = options.state;

  try {
    const utxos = await options.rpc.listUnspent(state.managedCoreWallet.walletName, 0);
    let fundingDisplaySats = 0n;
    let fundingSpendableSats = 0n;

    for (const entry of utxos) {
      if (!isDisplayFundingUtxo(entry, state.funding.scriptPubKeyHex)) {
        continue;
      }

      const amountSats = btcAmountToSats(entry.amount);
      fundingDisplaySats += amountSats;

      if (isSpendableFundingUtxo(entry, state.funding.scriptPubKeyHex)) {
        fundingSpendableSats += amountSats;
      }
    }

    return {
      fundingDisplaySats,
      fundingSpendableSats,
    };
  } catch {
    return {
      fundingDisplaySats: null,
      fundingSpendableSats: null,
    };
  }
}
