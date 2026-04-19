import type { WalletReadContext } from "../read/index.js";
import { findWalletDomain, isMineableWalletDomain } from "../read/index.js";
import { createWalletSecretReference, type WalletSecretProvider } from "../state/provider.js";
import type { WalletRuntimePaths } from "../runtime.js";
import { loadClientConfig, saveClientConfig } from "./config.js";
import type {
  ClientConfigV1,
  MiningDomainPromptEntry,
  MiningDomainPromptListResult,
  MiningDomainPromptMutationResult,
} from "./types.js";

function createEmptyClientConfig(): ClientConfigV1 {
  return {
    schemaVersion: 1,
    mining: {
      builtIn: null,
      domainExtraPrompts: {},
    },
  };
}

export function canonicalizeMiningDomainPromptName(domainName: string): string {
  return domainName.trim().toLowerCase();
}

function fallbackPromptConfigured(config: ClientConfigV1 | null): boolean {
  const extraPrompt = config?.mining.builtIn?.extraPrompt ?? null;
  return extraPrompt !== null && extraPrompt.length > 0;
}

function listMineableDomains(readContext: WalletReadContext): Map<string, { name: string; domainId: number | null }> {
  const domains = new Map<string, { name: string; domainId: number | null }>();

  for (const domain of readContext.model?.domains ?? []) {
    if (!isMineableWalletDomain(readContext, domain)) {
      continue;
    }

    domains.set(canonicalizeMiningDomainPromptName(domain.name), {
      name: domain.name,
      domainId: domain.domainId,
    });
  }

  return domains;
}

function buildPromptEntries(options: {
  readContext: WalletReadContext;
  domainExtraPrompts: Record<string, string>;
  fallbackPromptConfigured: boolean;
}): MiningDomainPromptEntry[] {
  const entries = new Map<string, MiningDomainPromptEntry>();
  const mineableDomains = listMineableDomains(options.readContext);

  for (const domain of mineableDomains.values()) {
    const canonicalDomainName = canonicalizeMiningDomainPromptName(domain.name);
    const prompt = options.domainExtraPrompts[canonicalDomainName] ?? null;
    entries.set(canonicalDomainName, {
      domain,
      mineable: true,
      prompt,
      effectivePromptSource: prompt !== null
        ? "domain"
        : options.fallbackPromptConfigured
          ? "global-fallback"
          : "none",
    });
  }

  for (const [domainName, prompt] of Object.entries(options.domainExtraPrompts)) {
    if (entries.has(domainName)) {
      continue;
    }

    const found = findWalletDomain(options.readContext, domainName);
    entries.set(domainName, {
      domain: {
        name: domainName,
        domainId: found?.domain.domainId ?? null,
      },
      mineable: false,
      prompt,
      effectivePromptSource: "domain",
    });
  }

  return [...entries.values()].sort((left, right) => left.domain.name.localeCompare(right.domain.name));
}

function isMineableTarget(readContext: WalletReadContext, domainName: string): boolean {
  const domain = readContext.model?.domains.find((entry) => canonicalizeMiningDomainPromptName(entry.name) === domainName);
  return domain === undefined ? false : isMineableWalletDomain(readContext, domain);
}

export async function inspectMiningDomainPromptState(options: {
  paths: WalletRuntimePaths;
  provider: WalletSecretProvider;
  readContext: WalletReadContext;
}): Promise<MiningDomainPromptListResult> {
  const config = await loadClientConfig({
    path: options.paths.clientConfigPath,
    provider: options.provider,
  });

  return {
    fallbackPromptConfigured: fallbackPromptConfigured(config),
    prompts: buildPromptEntries({
      readContext: options.readContext,
      domainExtraPrompts: config?.mining.domainExtraPrompts ?? {},
      fallbackPromptConfigured: fallbackPromptConfigured(config),
    }),
  };
}

export async function updateMiningDomainPrompt(options: {
  paths: WalletRuntimePaths;
  provider: WalletSecretProvider;
  readContext: WalletReadContext;
  domainName: string;
  prompt: string | null;
}): Promise<MiningDomainPromptMutationResult> {
  const canonicalDomainName = canonicalizeMiningDomainPromptName(options.domainName);
  const config = await loadClientConfig({
    path: options.paths.clientConfigPath,
    provider: options.provider,
  });
  const currentPrompts = {
    ...(config?.mining.domainExtraPrompts ?? {}),
  };
  const existingPrompt = currentPrompts[canonicalDomainName] ?? null;
  const mineable = isMineableTarget(options.readContext, canonicalDomainName);
  const found = findWalletDomain(options.readContext, canonicalDomainName);
  const nextPrompt = options.prompt === null || options.prompt.trim().length === 0
    ? null
    : options.prompt.trim();

  if (!mineable && existingPrompt === null) {
    throw new Error("mine_prompt_domain_not_mineable");
  }

  if (options.readContext.localState.walletRootId === null) {
    throw new Error("wallet_uninitialized");
  }

  if (nextPrompt === null) {
    delete currentPrompts[canonicalDomainName];
  } else {
    currentPrompts[canonicalDomainName] = nextPrompt;
  }

  const nextConfig = config ?? createEmptyClientConfig();
  nextConfig.mining.domainExtraPrompts = currentPrompts;

  await saveClientConfig({
    path: options.paths.clientConfigPath,
    provider: options.provider,
    secretReference: createWalletSecretReference(options.readContext.localState.walletRootId),
    config: nextConfig,
  });

  return {
    domain: {
      name: canonicalDomainName,
      domainId: found?.domain.domainId ?? null,
    },
    previousPrompt: existingPrompt,
    prompt: nextPrompt,
    status: nextPrompt === null ? "cleared" : "updated",
    fallbackPromptConfigured: fallbackPromptConfigured(config),
  };
}
