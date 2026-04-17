import { rm } from "node:fs/promises";

import { deriveWalletMaterialFromMnemonic } from "./material.js";
import { saveWalletState, type WalletStateSaveAccess } from "./state/storage.js";
import type { WalletRuntimePaths } from "./runtime.js";
import type { WalletStateV1 } from "./types.js";

export interface WalletDescriptorInfoRpc {
  getDescriptorInfo(descriptor: string): Promise<{
    descriptor: string;
    checksum: string;
  }>;
}

export interface NormalizedWalletDescriptorState {
  privateExternal: string;
  publicExternal: string;
  checksum: string;
}

export function stripDescriptorChecksum(descriptor: string): string {
  return descriptor.replace(/#[A-Za-z0-9]+$/, "");
}

export function buildDescriptorWithChecksum(descriptor: string, checksum: string): string {
  return `${stripDescriptorChecksum(descriptor)}#${checksum}`;
}

function assertWalletDescriptorStateRecoverable(state: WalletStateV1): void {
  const material = deriveWalletMaterialFromMnemonic(state.mnemonic.phrase);

  if (
    material.keys.masterFingerprintHex !== state.keys.masterFingerprintHex
    || material.keys.accountPath !== state.keys.accountPath
    || material.keys.accountXprv !== state.keys.accountXprv
    || material.keys.accountXpub !== state.keys.accountXpub
    || material.funding.address !== state.funding.address
    || material.funding.scriptPubKeyHex !== state.funding.scriptPubKeyHex
  ) {
    throw new Error("wallet_descriptor_state_unrecoverable");
  }
}

export async function resolveNormalizedWalletDescriptorState(
  state: WalletStateV1,
  rpc: WalletDescriptorInfoRpc,
): Promise<NormalizedWalletDescriptorState> {
  assertWalletDescriptorStateRecoverable(state);

  const material = deriveWalletMaterialFromMnemonic(state.mnemonic.phrase);
  const privateDescriptor = await rpc.getDescriptorInfo(stripDescriptorChecksum(material.descriptor.privateExternal));
  const publicDescriptor = await rpc.getDescriptorInfo(stripDescriptorChecksum(material.descriptor.publicExternal));

  return {
    privateExternal: buildDescriptorWithChecksum(material.descriptor.privateExternal, privateDescriptor.checksum),
    publicExternal: buildDescriptorWithChecksum(publicDescriptor.descriptor, publicDescriptor.checksum),
    checksum: publicDescriptor.checksum,
  };
}

export function applyNormalizedWalletDescriptorState(
  state: WalletStateV1,
  normalized: NormalizedWalletDescriptorState,
): WalletStateV1 {
  return {
    ...state,
    descriptor: {
      ...state.descriptor,
      privateExternal: normalized.privateExternal,
      publicExternal: normalized.publicExternal,
      checksum: normalized.checksum,
    },
    managedCoreWallet: {
      ...state.managedCoreWallet,
      descriptorChecksum: normalized.checksum,
    },
  };
}

export async function normalizeWalletDescriptorState(
  state: WalletStateV1,
  rpc: WalletDescriptorInfoRpc,
): Promise<{
  changed: boolean;
  state: WalletStateV1;
}> {
  const normalized = await resolveNormalizedWalletDescriptorState(state, rpc);
  const changed = state.descriptor.privateExternal !== normalized.privateExternal
    || state.descriptor.publicExternal !== normalized.publicExternal
    || state.descriptor.checksum !== normalized.checksum
    || state.managedCoreWallet.descriptorChecksum !== normalized.checksum;

  return {
    changed,
    state: changed ? applyNormalizedWalletDescriptorState(state, normalized) : state,
  };
}

export async function persistWalletStateUpdate(options: {
  state: WalletStateV1;
  access: WalletStateSaveAccess;
  paths: WalletRuntimePaths;
  nowUnixMs: number;
  replacePrimary?: boolean;
}): Promise<WalletStateV1> {
  const nextState = {
    ...options.state,
    stateRevision: options.state.stateRevision + 1,
    lastWrittenAtUnixMs: options.nowUnixMs,
  };

  if (options.replacePrimary) {
    await rm(options.paths.walletStatePath, { force: true }).catch(() => undefined);
  }

  await saveWalletState(
    {
      primaryPath: options.paths.walletStatePath,
      backupPath: options.paths.walletStateBackupPath,
    },
    nextState,
    options.access,
  );

  return nextState;
}

export async function persistNormalizedWalletDescriptorStateIfNeeded(options: {
  state: WalletStateV1;
  access: WalletStateSaveAccess;
  paths: WalletRuntimePaths;
  nowUnixMs: number;
  replacePrimary?: boolean;
  rpc: WalletDescriptorInfoRpc;
}): Promise<{
  changed: boolean;
  state: WalletStateV1;
}> {
  const normalized = await normalizeWalletDescriptorState(options.state, options.rpc);

  if (!normalized.changed) {
    return {
      changed: false,
      state: options.state,
    };
  }

  const nextState = await persistWalletStateUpdate({
    state: normalized.state,
    access: options.access,
    paths: options.paths,
    nowUnixMs: options.nowUnixMs,
    replacePrimary: options.replacePrimary,
  });

  return {
    changed: true,
    state: nextState,
  };
}
