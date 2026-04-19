import { readFile } from "node:fs/promises";

import { writeJsonFileAtomic } from "../fs/atomic.js";
import { decryptJsonWithSecretProvider, encryptJsonWithSecretProvider } from "../state/crypto.js";
import type { WalletSecretProvider, WalletSecretReference } from "../state/provider.js";
import type { ClientConfigV1, MiningProviderConfigRecord } from "./types.js";
import { normalizeMiningProviderConfigRecord } from "./provider-model.js";

function normalizeDomainExtraPrompts(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== "object") {
    return {};
  }

  const normalized = new Map<string, string>();

  for (const [rawDomainName, rawPrompt] of Object.entries(raw)) {
    if (typeof rawPrompt !== "string") {
      continue;
    }

    const domainName = rawDomainName.trim().toLowerCase();
    const prompt = rawPrompt.trim();

    if (domainName.length === 0 || prompt.length === 0) {
      continue;
    }

    normalized.set(domainName, prompt);
  }

  return Object.fromEntries(
    [...normalized.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function createEmptyClientConfig(): ClientConfigV1 {
  return {
    schemaVersion: 1,
    mining: {
      builtIn: null,
      domainExtraPrompts: {},
    },
  };
}

function normalizeClientConfig(config: ClientConfigV1): ClientConfigV1 {
  const mining = config.mining ?? createEmptyClientConfig().mining;

  return {
    ...config,
    mining: {
      ...mining,
      builtIn: mining.builtIn === null ? null : normalizeMiningProviderConfigRecord(mining.builtIn),
      domainExtraPrompts: normalizeDomainExtraPrompts(mining.domainExtraPrompts),
    },
  };
}

export async function loadClientConfig(options: {
  path: string;
  provider: WalletSecretProvider;
}): Promise<ClientConfigV1 | null> {
  try {
    const raw = await readFile(options.path, "utf8");
    return normalizeClientConfig(await decryptJsonWithSecretProvider<ClientConfigV1>(
      JSON.parse(raw) as Parameters<typeof decryptJsonWithSecretProvider<ClientConfigV1>>[0],
      options.provider,
    ));
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
    normalizeClientConfig(options.config),
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
  nextConfig.mining.builtIn = normalizeMiningProviderConfigRecord(options.config);
  await saveClientConfig({
    path: options.path,
    provider: options.provider,
    secretReference: options.secretReference,
    config: nextConfig,
  });
  return nextConfig;
}
