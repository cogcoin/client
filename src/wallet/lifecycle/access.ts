import {
  normalizeWalletStateRecord,
  persistWalletCoinControlStateIfNeeded,
} from "../coin-control.js";
import { persistNormalizedWalletDescriptorStateIfNeeded } from "../descriptor-normalization.js";
import { normalizeMiningStateRecord } from "../mining/state.js";
import { createWalletSecretReference } from "../state/provider.js";
import { loadWalletState } from "../state/storage.js";
import type {
  WalletAccessContext,
  WalletLoadedState,
} from "./types.js";

export function isWalletSecretAccessError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("wallet_secret_missing_")
    || message.startsWith("wallet_secret_provider_");
}

export function mapWalletReadAccessError(error: unknown): Error {
  if (isWalletSecretAccessError(error)) {
    return new Error("wallet_secret_provider_unavailable");
  }

  return new Error("local-state-corrupt");
}

export async function normalizeLoadedWalletStateIfNeeded(
  options: WalletAccessContext & WalletLoadedState,
): Promise<WalletLoadedState> {
  let state = options.state;
  let source = options.source;

  if (options.dataDir !== undefined) {
    const node = await options.attachService({
      dataDir: options.dataDir,
      chain: "main",
      startHeight: 0,
      walletRootId: state.walletRootId,
    });

    try {
      const normalizedDescriptorState = await persistNormalizedWalletDescriptorStateIfNeeded({
        state,
        access: {
          provider: options.provider,
          secretReference: createWalletSecretReference(state.walletRootId),
        },
        paths: options.paths,
        nowUnixMs: options.nowUnixMs,
        replacePrimary: source === "backup",
        rpc: options.rpcFactory(node.rpc),
      });
      state = normalizedDescriptorState.state;
      source = normalizedDescriptorState.changed ? "primary" : source;

      const reconciledCoinControl = await persistWalletCoinControlStateIfNeeded({
        state,
        access: {
          provider: options.provider,
          secretReference: createWalletSecretReference(state.walletRootId),
        },
        paths: options.paths,
        nowUnixMs: options.nowUnixMs,
        replacePrimary: source === "backup",
        rpc: options.rpcFactory(node.rpc),
      });
      state = reconciledCoinControl.state;
      source = reconciledCoinControl.changed ? "primary" : source;
    } finally {
      await node.stop?.().catch(() => undefined);
    }
  }

  return {
    state: normalizeWalletStateRecord({
      ...state,
      miningState: normalizeMiningStateRecord(state.miningState),
    }),
    source,
  };
}

export async function loadWalletStateForAccess(
  options: WalletAccessContext,
): Promise<WalletLoadedState> {
  const loaded = await loadWalletState({
    primaryPath: options.paths.walletStatePath,
    backupPath: options.paths.walletStateBackupPath,
  }, {
    provider: options.provider,
  });

  return await normalizeLoadedWalletStateIfNeeded({
    ...options,
    state: loaded.state,
    source: loaded.source,
  });
}
