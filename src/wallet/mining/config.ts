import { readFile } from "node:fs/promises";

import { writeJsonFileAtomic } from "../fs/atomic.js";
import { decryptJsonWithSecretProvider, encryptJsonWithSecretProvider } from "../state/crypto.js";
import type { WalletSecretProvider, WalletSecretReference } from "../state/provider.js";
import type { ClientConfigV1, MiningProviderConfigRecord } from "./types.js";

function createEmptyClientConfig(): ClientConfigV1 {
  return {
    schemaVersion: 1,
    mining: {
      builtIn: null,
    },
  };
}

export async function loadClientConfig(options: {
  path: string;
  provider: WalletSecretProvider;
}): Promise<ClientConfigV1 | null> {
  try {
    const raw = await readFile(options.path, "utf8");
    return await decryptJsonWithSecretProvider<ClientConfigV1>(
      JSON.parse(raw) as Parameters<typeof decryptJsonWithSecretProvider<ClientConfigV1>>[0],
      options.provider,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function saveClientConfig(options: {
  path: string;
  provider: WalletSecretProvider;
  secretReference: WalletSecretReference;
  config: ClientConfigV1;
}): Promise<void> {
  const envelope = await encryptJsonWithSecretProvider(
    options.config,
    options.provider,
    options.secretReference,
    {
      format: "cogcoin-client-config",
    },
  );
  await writeJsonFileAtomic(options.path, envelope, { mode: 0o600 });
}

export async function saveBuiltInMiningProviderConfig(options: {
  path: string;
  provider: WalletSecretProvider;
  secretReference: WalletSecretReference;
  config: MiningProviderConfigRecord;
}): Promise<ClientConfigV1> {
  const existing = await loadClientConfig({
    path: options.path,
    provider: options.provider,
  }).catch(() => null);
  const nextConfig = existing ?? createEmptyClientConfig();
  nextConfig.mining.builtIn = options.config;
  await saveClientConfig({
    path: options.path,
    provider: options.provider,
    secretReference: options.secretReference,
    config: nextConfig,
  });
  return nextConfig;
}
