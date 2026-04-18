import type {
  MiningModelSelectionSource,
  MiningProviderConfigRecord,
  MiningProviderKind,
} from "./types.js";

export interface BuiltInProviderModelCatalogEntry {
  label: string;
  modelId: string;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

export interface BuiltInProviderSelection {
  modelId: string;
  effectiveModel: string;
  modelSelectionSource: MiningModelSelectionSource;
  usingDefaultModel: boolean;
}

export interface BuiltInModelDailyCostEstimate {
  estimatedDailyCostUsd: number;
  estimatedDailyCostDisplay: string;
}

const DEFAULT_BUILT_IN_PROVIDER_MODELS: Record<MiningProviderKind, string> = {
  openai: "gpt-5.4-mini",
  anthropic: "claude-sonnet-4-20250514",
};

const RECOMMENDED_BUILT_IN_PROVIDER_MODELS: Record<MiningProviderKind, string> = {
  openai: "gpt-5.4-mini",
  anthropic: "claude-sonnet-4-6",
};

const BUILT_IN_PROVIDER_MODEL_CATALOG: Record<MiningProviderKind, readonly BuiltInProviderModelCatalogEntry[]> = {
  openai: [
    {
      label: "GPT-5.4",
      modelId: "gpt-5.4",
      inputUsdPerMillionTokens: 2.5,
      outputUsdPerMillionTokens: 15,
    },
    {
      label: "GPT-5.4 mini",
      modelId: "gpt-5.4-mini",
      inputUsdPerMillionTokens: 0.75,
      outputUsdPerMillionTokens: 4.5,
    },
    {
      label: "GPT-5.4 nano",
      modelId: "gpt-5.4-nano",
      inputUsdPerMillionTokens: 0.2,
      outputUsdPerMillionTokens: 1.25,
    },
  ],
  anthropic: [
    {
      label: "Claude Opus 4.7",
      modelId: "claude-opus-4-7",
      inputUsdPerMillionTokens: 5,
      outputUsdPerMillionTokens: 25,
    },
    {
      label: "Claude Sonnet 4.6",
      modelId: "claude-sonnet-4-6",
      inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 15,
    },
    {
      label: "Claude Haiku 4.5",
      modelId: "claude-haiku-4-5",
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 5,
    },
  ],
};

const DAILY_COST_ESTIMATE_CALLS_PER_DAY = 144;
const DAILY_COST_ESTIMATE_BASE_INPUT_TOKENS = 340;
const DAILY_COST_ESTIMATE_PER_ROOT_INPUT_TOKENS = 85;
const DAILY_COST_ESTIMATE_BASE_OUTPUT_TOKENS = 120;
const DAILY_COST_ESTIMATE_PER_ROOT_OUTPUT_TOKENS = 105;

export const MINING_MODEL_DAILY_COST_ESTIMATE_ASSUMPTION =
  "Approximate daily cost assumes 144 sentence-generation calls/day using your current anchored root count, standard token pricing, no caching, and no extra prompt.";

function normalizeModelOverride(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") {
    return null;
  }

  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function getLegacyBuiltInProviderDefaultModel(provider: MiningProviderKind): string {
  return DEFAULT_BUILT_IN_PROVIDER_MODELS[provider];
}

export function getRecommendedBuiltInProviderModel(provider: MiningProviderKind): string {
  return RECOMMENDED_BUILT_IN_PROVIDER_MODELS[provider];
}

export function getBuiltInProviderModelCatalog(provider: MiningProviderKind): readonly BuiltInProviderModelCatalogEntry[] {
  return BUILT_IN_PROVIDER_MODEL_CATALOG[provider];
}

export function findBuiltInProviderModelCatalogEntry(
  provider: MiningProviderKind,
  modelId: string,
): BuiltInProviderModelCatalogEntry | null {
  return BUILT_IN_PROVIDER_MODEL_CATALOG[provider].find((entry) => entry.modelId === modelId) ?? null;
}

export function normalizeMiningModelSelectionSource(
  raw: unknown,
  modelOverride: string | null,
): MiningModelSelectionSource {
  switch (raw) {
    case "catalog":
    case "custom":
    case "legacy-default":
    case "legacy-custom":
      return raw;
    default:
      return modelOverride === null ? "legacy-default" : "legacy-custom";
  }
}

export function normalizeMiningProviderConfigRecord(
  config: MiningProviderConfigRecord,
): MiningProviderConfigRecord {
  const modelOverride = normalizeModelOverride(config.modelOverride);
  return {
    ...config,
    extraPrompt: typeof config.extraPrompt === "string" && config.extraPrompt.trim().length > 0
      ? config.extraPrompt
      : null,
    modelOverride,
    modelSelectionSource: normalizeMiningModelSelectionSource(config.modelSelectionSource, modelOverride),
  };
}

export function resolveBuiltInProviderModel(
  provider: MiningProviderKind,
  modelOverride: string | null,
): {
  effectiveModel: string;
  usingDefaultModel: boolean;
} {
  const normalizedModelOverride = normalizeModelOverride(modelOverride);
  return {
    effectiveModel: normalizedModelOverride ?? DEFAULT_BUILT_IN_PROVIDER_MODELS[provider],
    usingDefaultModel: normalizedModelOverride === null,
  };
}

export function resolveBuiltInProviderSelection(
  config: Pick<MiningProviderConfigRecord, "provider" | "modelOverride" | "modelSelectionSource">,
): BuiltInProviderSelection {
  const modelOverride = normalizeModelOverride(config.modelOverride);
  const modelSelectionSource = normalizeMiningModelSelectionSource(config.modelSelectionSource, modelOverride);
  const { effectiveModel, usingDefaultModel } = resolveBuiltInProviderModel(config.provider, modelOverride);

  return {
    modelId: effectiveModel,
    effectiveModel,
    modelSelectionSource,
    usingDefaultModel,
  };
}

export function estimateBuiltInModelDailyCost(
  provider: MiningProviderKind,
  modelId: string,
  eligibleRootCount: number,
): BuiltInModelDailyCostEstimate | null {
  const model = findBuiltInProviderModelCatalogEntry(provider, modelId);

  if (model === null) {
    return null;
  }

  const rootCount = Math.max(0, Math.trunc(eligibleRootCount));
  const estimatedInputTokens = DAILY_COST_ESTIMATE_BASE_INPUT_TOKENS
    + (DAILY_COST_ESTIMATE_PER_ROOT_INPUT_TOKENS * rootCount);
  const estimatedOutputTokens = DAILY_COST_ESTIMATE_BASE_OUTPUT_TOKENS
    + (DAILY_COST_ESTIMATE_PER_ROOT_OUTPUT_TOKENS * rootCount);
  const estimatedPerCallUsd = (
    (estimatedInputTokens / 1_000_000) * model.inputUsdPerMillionTokens
  ) + (
    (estimatedOutputTokens / 1_000_000) * model.outputUsdPerMillionTokens
  );
  const estimatedDailyCostUsd = Number((estimatedPerCallUsd * DAILY_COST_ESTIMATE_CALLS_PER_DAY).toFixed(6));

  return {
    estimatedDailyCostUsd,
    estimatedDailyCostDisplay: estimatedDailyCostUsd < 0.005
      ? "<$0.01/day"
      : `$${estimatedDailyCostUsd.toFixed(2)}/day`,
  };
}
