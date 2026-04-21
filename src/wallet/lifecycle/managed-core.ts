import { rename } from "node:fs/promises";
import { join } from "node:path";

import { attachOrStartManagedBitcoindService, createManagedWalletReplica } from "../../bitcoind/service.js";
import { createRpcClient } from "../../bitcoind/node.js";
import type { ManagedCoreWalletReplicaStatus } from "../../bitcoind/types.js";
import {
  resolveNormalizedWalletDescriptorState,
} from "../descriptor-normalization.js";
import type { WalletRuntimePaths } from "../runtime.js";
import { createWalletSecretReference, type WalletSecretProvider } from "../state/provider.js";
import { saveWalletState } from "../state/storage.js";
import type { WalletStateV1 } from "../types.js";
import { withUnlockedManagedCoreWallet } from "../managed-core-wallet.js";
import type {
  WalletLifecycleRpcClient,
  WalletManagedCoreDependencies,
} from "./types.js";
import { pathExists } from "./context.js";

export function sanitizeWalletName(walletRootId: string): string {
  return `cogcoin-${walletRootId}`.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 63);
}

export async function importDescriptorIntoManagedCoreWallet(
  state: WalletStateV1,
  provider: WalletSecretProvider,
  paths: WalletRuntimePaths,
  dataDir: string,
  nowUnixMs: number,
  attachService: typeof attachOrStartManagedBitcoindService = attachOrStartManagedBitcoindService,
  rpcFactory: (config: Parameters<typeof createRpcClient>[0]) => WalletLifecycleRpcClient = createRpcClient,
): Promise<WalletStateV1> {
  const node = await attachService({
    dataDir,
    chain: "main",
    startHeight: 0,
    walletRootId: state.walletRootId,
    managedWalletPassphrase: state.managedCoreWallet.internalPassphrase,
  });
  const rpc = rpcFactory(node.rpc);
  await createManagedWalletReplica(rpc, state.walletRootId, {
    managedWalletPassphrase: state.managedCoreWallet.internalPassphrase,
  });
  const normalizedDescriptors = await resolveNormalizedWalletDescriptorState(state, rpc);
  const walletName = sanitizeWalletName(state.walletRootId);

  await withUnlockedManagedCoreWallet({
    rpc,
    walletName,
    internalPassphrase: state.managedCoreWallet.internalPassphrase,
    run: async () => {
      const importResults = await rpc.importDescriptors(walletName, [{
        desc: normalizedDescriptors.privateExternal,
        timestamp: state.walletBirthTime,
        active: false,
        internal: false,
        range: [0, state.descriptor.rangeEnd],
      }]);

      if (!importResults.every((result) => result.success)) {
        throw new Error(`wallet_descriptor_import_failed_${JSON.stringify(importResults)}`);
      }
    },
  });

  const derivedFunding = await rpc.deriveAddresses(normalizedDescriptors.publicExternal, [0, 0]);

  if (derivedFunding[0] !== state.funding.address) {
    throw new Error("wallet_funding_address_verification_failed");
  }

  const descriptors = await rpc.listDescriptors(walletName);
  const importedDescriptor = descriptors.descriptors.find((entry) => entry.desc === normalizedDescriptors.publicExternal);

  if (importedDescriptor == null) {
    throw new Error("wallet_descriptor_not_present_after_import");
  }

  const verifiedReplica: ManagedCoreWalletReplicaStatus = {
    walletRootId: state.walletRootId,
    walletName,
    loaded: true,
    descriptors: true,
    privateKeysEnabled: true,
    created: false,
    proofStatus: "ready",
    descriptorChecksum: normalizedDescriptors.checksum,
    fundingAddress0: state.funding.address,
    fundingScriptPubKeyHex0: state.funding.scriptPubKeyHex,
    message: null,
  };

  const nextState: WalletStateV1 = {
    ...state,
    stateRevision: state.stateRevision + 1,
    lastWrittenAtUnixMs: nowUnixMs,
    descriptor: {
      ...state.descriptor,
      privateExternal: normalizedDescriptors.privateExternal,
      publicExternal: normalizedDescriptors.publicExternal,
      checksum: normalizedDescriptors.checksum,
    },
    managedCoreWallet: {
      ...state.managedCoreWallet,
      walletName,
      descriptorChecksum: normalizedDescriptors.checksum,
      walletAddress: verifiedReplica.fundingAddress0 ?? null,
      walletScriptPubKeyHex: verifiedReplica.fundingScriptPubKeyHex0 ?? null,
      proofStatus: "ready",
      lastImportedAtUnixMs: nowUnixMs,
      lastVerifiedAtUnixMs: nowUnixMs,
    },
  };

  await saveWalletState(
    {
      primaryPath: paths.walletStatePath,
      backupPath: paths.walletStateBackupPath,
    },
    nextState,
    {
      provider,
      secretReference: createWalletSecretReference(state.walletRootId),
    },
  );

  return nextState;
}

export async function recreateManagedCoreWalletReplica(
  state: WalletStateV1,
  provider: WalletSecretProvider,
  paths: WalletRuntimePaths,
  dataDir: string,
  nowUnixMs: number,
  options: WalletManagedCoreDependencies = {},
): Promise<WalletStateV1> {
  const walletName = sanitizeWalletName(state.walletRootId);
  const walletDir = join(dataDir, "wallets", walletName);
  const quarantineDir = `${walletDir}.quarantine-${nowUnixMs}`;
  const node = await (options.attachService ?? attachOrStartManagedBitcoindService)({
    dataDir,
    chain: "main",
    startHeight: 0,
    walletRootId: state.walletRootId,
    managedWalletPassphrase: state.managedCoreWallet.internalPassphrase,
  });
  const rpc = (options.rpcFactory ?? createRpcClient)(node.rpc);

  if (rpc.unloadWallet != null) {
    await rpc.unloadWallet(walletName, false).catch(() => undefined);
  }

  if (await pathExists(walletDir)) {
    await rename(walletDir, quarantineDir).catch(() => undefined);
  }

  return importDescriptorIntoManagedCoreWallet(
    {
      ...state,
      managedCoreWallet: {
        ...state.managedCoreWallet,
        proofStatus: "not-proven",
      },
    },
    provider,
    paths,
    dataDir,
    nowUnixMs,
    options.attachService,
    options.rpcFactory,
  );
}

export async function verifyManagedCoreWalletReplica(
  state: WalletStateV1,
  dataDir: string,
  dependencies: WalletManagedCoreDependencies & {
    nodeHandle?: { rpc: Parameters<typeof createRpcClient>[0] };
  } = {},
): Promise<ManagedCoreWalletReplicaStatus> {
  const walletName = state.managedCoreWallet.walletName;

  try {
    const node = dependencies.nodeHandle ?? await (dependencies.attachService ?? attachOrStartManagedBitcoindService)({
      dataDir,
      chain: "main",
      startHeight: 0,
      walletRootId: state.walletRootId,
    });
    const rpc = (dependencies.rpcFactory ?? createRpcClient)(node.rpc);
    const info = await rpc.getWalletInfo(walletName);
    const descriptors = await rpc.listDescriptors(walletName);
    const matchingDescriptor = state.managedCoreWallet.descriptorChecksum === null
      ? null
      : descriptors.descriptors.find((entry) => entry.desc.endsWith(`#${state.managedCoreWallet.descriptorChecksum}`));

    if (matchingDescriptor == null) {
      return {
        walletRootId: state.walletRootId,
        walletName,
        loaded: true,
        descriptors: info.descriptors,
        privateKeysEnabled: info.private_keys_enabled,
        created: false,
        proofStatus: "missing",
        descriptorChecksum: state.managedCoreWallet.descriptorChecksum,
        fundingAddress0: state.managedCoreWallet.walletAddress,
        fundingScriptPubKeyHex0: state.managedCoreWallet.walletScriptPubKeyHex,
        message: "Expected descriptor is missing from the managed Core wallet.",
      };
    }

    const derived = await rpc.deriveAddresses(state.descriptor.publicExternal, [0, 0]);

    if (derived[0] !== state.funding.address) {
      return {
        walletRootId: state.walletRootId,
        walletName,
        loaded: true,
        descriptors: info.descriptors,
        privateKeysEnabled: info.private_keys_enabled,
        created: false,
        proofStatus: "mismatch",
        descriptorChecksum: state.managedCoreWallet.descriptorChecksum,
        fundingAddress0: derived[0] ?? null,
        fundingScriptPubKeyHex0: null,
        message: "The managed Core wallet funding address does not match the trusted wallet state.",
      };
    }

    return {
      walletRootId: state.walletRootId,
      walletName,
      loaded: true,
      descriptors: info.descriptors,
      privateKeysEnabled: info.private_keys_enabled,
      created: false,
      proofStatus: "ready",
      descriptorChecksum: state.managedCoreWallet.descriptorChecksum,
      fundingAddress0: state.funding.address,
      fundingScriptPubKeyHex0: state.funding.scriptPubKeyHex,
      message: null,
    };
  } catch (error) {
    return {
      walletRootId: state.walletRootId,
      walletName,
      loaded: false,
      descriptors: false,
      privateKeysEnabled: false,
      created: false,
      proofStatus: "not-proven",
      descriptorChecksum: state.managedCoreWallet.descriptorChecksum,
      fundingAddress0: state.managedCoreWallet.walletAddress,
      fundingScriptPubKeyHex0: state.managedCoreWallet.walletScriptPubKeyHex,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
