import { readFile } from "node:fs/promises";

import { writeJsonFileAtomic } from "../fs/atomic.js";
import type { EncryptedEnvelopeV1, WalletStateV1 } from "../types.js";
import { normalizeWalletStateRecord } from "../coin-control.js";
import {
  decryptJsonWithSecretProvider,
  encryptJsonWithSecretProvider,
} from "./crypto.js";
import type { WalletSecretProvider, WalletSecretReference } from "./provider.js";

export interface WalletStateStoragePaths {
  primaryPath: string;
  backupPath: string;
}

export interface LoadedWalletState {
  source: "primary" | "backup";
  state: WalletStateV1;
}

export interface RawWalletStateEnvelope {
  source: "primary" | "backup";
  envelope: EncryptedEnvelopeV1;
}

export type WalletStateSaveAccess = {
  provider: WalletSecretProvider;
  secretReference: WalletSecretReference;
};

export type WalletStateLoadAccess = {
  provider: WalletSecretProvider;
};

async function readEnvelope(path: string): Promise<EncryptedEnvelopeV1> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as EncryptedEnvelopeV1;
}

function serializeWalletState(state: WalletStateV1): Record<string, unknown> {
  return {
    schemaVersion: 4,
    stateRevision: state.stateRevision,
    lastWrittenAtUnixMs: state.lastWrittenAtUnixMs,
    walletRootId: state.walletRootId,
    network: state.network,
    anchorValueSats: state.anchorValueSats,
    localScriptPubKeyHexes: state.localScriptPubKeyHexes,
    mnemonic: state.mnemonic,
    keys: state.keys,
    descriptor: state.descriptor,
    funding: state.funding,
    walletBirthTime: state.walletBirthTime,
    managedCoreWallet: {
      walletName: state.managedCoreWallet.walletName,
      internalPassphrase: state.managedCoreWallet.internalPassphrase,
      descriptorChecksum: state.managedCoreWallet.descriptorChecksum,
      walletAddress: state.managedCoreWallet.walletAddress,
      walletScriptPubKeyHex: state.managedCoreWallet.walletScriptPubKeyHex,
      proofStatus: state.managedCoreWallet.proofStatus,
      lastImportedAtUnixMs: state.managedCoreWallet.lastImportedAtUnixMs,
      lastVerifiedAtUnixMs: state.managedCoreWallet.lastVerifiedAtUnixMs,
    },
    domains: state.domains.map((domain) => ({
      name: domain.name,
      domainId: domain.domainId,
      currentOwnerScriptPubKeyHex: domain.currentOwnerScriptPubKeyHex,
      canonicalChainStatus: domain.canonicalChainStatus,
      currentCanonicalAnchorOutpoint: domain.currentCanonicalAnchorOutpoint,
      foundingMessageText: domain.foundingMessageText,
      birthTime: domain.birthTime,
    })),
    miningState: state.miningState,
    pendingMutations: state.pendingMutations,
  };
}

export async function loadRawWalletStateEnvelope(
  paths: WalletStateStoragePaths,
): Promise<RawWalletStateEnvelope | null> {
  try {
    return {
      source: "primary",
      envelope: await readEnvelope(paths.primaryPath),
    };
  } catch (primaryError) {
    try {
      return {
        source: "backup",
        envelope: await readEnvelope(paths.backupPath),
      };
    } catch {
      if (
        primaryError instanceof SyntaxError
        || !(primaryError instanceof Error)
        || !("code" in primaryError)
        || (primaryError as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw primaryError;
      }

      return null;
    }
  }
}

export function extractWalletRootIdHintFromWalletStateEnvelope(
  envelope: EncryptedEnvelopeV1 | null,
): string | null {
  const hint = envelope?.walletRootIdHint?.trim() ?? "";

  if (hint.length > 0) {
    return hint;
  }

  const keyId = envelope?.secretProvider?.keyId ?? null;
  const prefix = "wallet-state:";

  if (keyId === null || !keyId.startsWith(prefix)) {
    return null;
  }

  return keyId.slice(prefix.length);
}

async function loadWalletStateEnvelope(
  envelope: EncryptedEnvelopeV1,
  access: WalletStateLoadAccess,
): Promise<WalletStateV1> {
  if (envelope.secretProvider == null) {
    throw new Error("wallet_state_legacy_envelope_unsupported");
  }

  return normalizeWalletStateRecord(
    await decryptJsonWithSecretProvider<WalletStateV1>(envelope, access.provider),
  );
}

export async function saveWalletState(
  paths: WalletStateStoragePaths,
  state: WalletStateV1,
  access: WalletStateSaveAccess,
): Promise<void> {
  let previousPrimary: EncryptedEnvelopeV1 | null = null;

  try {
    previousPrimary = await readEnvelope(paths.primaryPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      previousPrimary = null;
    } else if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
      throw error;
    }
  }

  const envelope = await encryptJsonWithSecretProvider(
    serializeWalletState(state),
    access.provider,
    access.secretReference,
    {
      format: "cogcoin-local-wallet-state",
      walletRootIdHint: state.walletRootId,
    },
  );

  await writeJsonFileAtomic(paths.primaryPath, envelope, { mode: 0o600 });

  if (previousPrimary !== null) {
    await writeJsonFileAtomic(paths.backupPath, previousPrimary, { mode: 0o600 });
  }
}

export async function loadWalletState(
  paths: WalletStateStoragePaths,
  access: WalletStateLoadAccess,
): Promise<LoadedWalletState> {
  try {
    return {
      source: "primary",
      state: await loadWalletStateEnvelope(await readEnvelope(paths.primaryPath), access),
    };
  } catch (primaryError) {
    try {
      return {
        source: "backup",
        state: await loadWalletStateEnvelope(await readEnvelope(paths.backupPath), access),
      };
    } catch {
      throw primaryError;
    }
  }
}
