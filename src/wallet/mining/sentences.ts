import { loadClientConfig } from "./config.js";
import {
  MINING_BUILTIN_TIMEOUT_MS,
} from "./constants.js";
import type { MiningProviderKind } from "./types.js";
import type {
  MiningSentenceCandidateV1,
  MiningSentenceGenerationRequestV1,
} from "./sentence-protocol.js";
import {
  normalizeMiningSentenceResponse,
  parseStrictJsonValue,
  stripMarkdownCodeFence,
} from "./sentence-protocol.js";
import { resolveBuiltInProviderModel } from "./provider-model.js";
import type { WalletRuntimePaths } from "../runtime.js";
import type { WalletSecretProvider } from "../state/provider.js";

export type MiningSentenceGenerationRequest = MiningSentenceGenerationRequestV1;
export type MiningSentenceGenerationCandidate = MiningSentenceCandidateV1;

export interface MiningSentenceSourceOptions {
  paths: WalletRuntimePaths;
  provider: WalletSecretProvider;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

class MiningProviderRequestError extends Error {
  readonly providerState: "unavailable" | "rate-limited" | "auth-error" | "not-found";

  constructor(providerState: "unavailable" | "rate-limited" | "auth-error" | "not-found", message: string) {
    super(message);
    this.name = "MiningProviderRequestError";
    this.providerState = providerState;
  }
}

function createBuiltInProviderNotFoundError(options: {
  provider: MiningProviderKind;
  model: string;
  usingDefaultModel: boolean;
}): MiningProviderRequestError {
  const providerName = options.provider === "anthropic" ? "Anthropic" : "OpenAI";
  const providerLabel = `The built-in ${providerName} mining provider`;
  const message = options.usingDefaultModel
    ? `${providerLabel} returned HTTP 404 for default model "${options.model}". ${providerName} may no longer serve that model. Rerun \`cogcoin mine setup\` to choose a valid override.`
    : `${providerLabel} returned HTTP 404 for model "${options.model}". The configured model override may be invalid. Rerun \`cogcoin mine setup\` to clear or correct it.`;
  return new MiningProviderRequestError("not-found", message);
}

function buildSystemPrompt(extraPrompt: string | null): string {
  const lines = [
    "You are helping generate candidate Cogcoin mining sentences.",
    "Return only JSON matching the requested response schema.",
    "Every sentence must be a single natural-language sentence.",
    "Do not add commentary, markdown, or code fences.",
    "Do not invent domain IDs or request IDs.",
  ];

  if (extraPrompt !== null && extraPrompt.trim().length > 0) {
    lines.push(`Extra instruction: ${extraPrompt.trim()}`);
  }

  return lines.join("\n");
}

function buildUserPrompt(request: MiningSentenceGenerationRequest): string {
  return [
    "Return a JSON object with:",
    `- schemaVersion: 1`,
    `- requestId: ${request.requestId}`,
    "- candidates: [{ domainId, sentence }]",
    "Use only domain IDs from rootDomains.",
    `Keep each sentence within ${request.limits.maxCandidateSentenceUtf8Bytes} UTF-8 bytes after trimming.`,
    "Mining request JSON:",
    JSON.stringify(request, null, 2),
  ].join("\n");
}

function annotateProviderCandidates(options: {
  candidates: MiningSentenceCandidateV1[];
  provider: MiningProviderKind;
  model: string;
}): MiningSentenceCandidateV1[] {
  return options.candidates.map((candidate) => ({
    ...candidate,
    attribution: candidate.attribution ?? {
      provider: options.provider,
      model: options.model,
      promptLabel: "built-in",
    },
  }));
}

function parseProviderJsonResponse(options: {
  raw: string;
  request: MiningSentenceGenerationRequest;
  providerLabel: string;
}): MiningSentenceCandidateV1[] {
  const response = parseStrictJsonValue(
    stripMarkdownCodeFence(options.raw),
    `${options.providerLabel} returned invalid JSON.`,
  );

  try {
    return normalizeMiningSentenceResponse({
      request: options.request,
      response,
    }).candidates;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : `${options.providerLabel} returned an invalid response.`);
  }
}

function createProviderSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
}

async function requestBuiltInSentences(options: {
  provider: MiningProviderKind;
  apiKey: string;
  modelOverride: string | null;
  extraPrompt: string | null;
  request: MiningSentenceGenerationRequest;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<MiningSentenceCandidateV1[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const providerSignal = createProviderSignal(
    options.signal,
    Math.min(MINING_BUILTIN_TIMEOUT_MS, options.request.limits.timeoutMs),
  );

  try {
    if (options.provider === "openai") {
      const { effectiveModel: model, usingDefaultModel } = resolveBuiltInProviderModel(
        options.provider,
        options.modelOverride,
      );
      const response = await fetchImpl("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: [
            {
              role: "system",
              content: buildSystemPrompt(options.extraPrompt),
            },
            {
              role: "user",
              content: buildUserPrompt(options.request),
            },
          ],
        }),
        signal: providerSignal,
      });

      if (response.status === 401 || response.status === 403) {
        throw new MiningProviderRequestError("auth-error", "The built-in OpenAI mining provider rejected the configured API key.");
      }

      if (response.status === 429) {
        throw new MiningProviderRequestError("rate-limited", "The built-in OpenAI mining provider is rate limited.");
      }

      if (response.status === 404) {
        throw createBuiltInProviderNotFoundError({
          provider: options.provider,
          model,
          usingDefaultModel,
        });
      }

      if (!response.ok) {
        throw new MiningProviderRequestError("unavailable", `The built-in OpenAI mining provider returned HTTP ${response.status}.`);
      }

      return annotateProviderCandidates({
        candidates: parseProviderJsonResponse({
          raw: extractOpenAiText(await response.json()),
          request: options.request,
          providerLabel: "The built-in OpenAI mining provider",
        }),
        provider: options.provider,
        model,
      });
    }

    const { effectiveModel: model, usingDefaultModel } = resolveBuiltInProviderModel(
      options.provider,
      options.modelOverride,
    );
    const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": options.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1_200,
        system: buildSystemPrompt(options.extraPrompt),
        messages: [
          {
            role: "user",
            content: buildUserPrompt(options.request),
          },
        ],
      }),
      signal: providerSignal,
    });

    if (response.status === 401 || response.status === 403) {
      throw new MiningProviderRequestError("auth-error", "The built-in Anthropic mining provider rejected the configured API key.");
    }

    if (response.status === 429) {
      throw new MiningProviderRequestError("rate-limited", "The built-in Anthropic mining provider is rate limited.");
    }

    if (response.status === 404) {
      throw createBuiltInProviderNotFoundError({
        provider: options.provider,
        model,
        usingDefaultModel,
      });
    }

    if (!response.ok) {
      throw new MiningProviderRequestError("unavailable", `The built-in Anthropic mining provider returned HTTP ${response.status}.`);
    }

    return annotateProviderCandidates({
      candidates: parseProviderJsonResponse({
        raw: extractAnthropicText(await response.json()),
        request: options.request,
        providerLabel: "The built-in Anthropic mining provider",
      }),
      provider: options.provider,
      model,
    });
  } catch (error) {
    if (error instanceof MiningProviderRequestError) {
      throw error;
    }

    if (error instanceof Error && error.name === "AbortError") {
      throw new MiningProviderRequestError("unavailable", "Mining sentence generation was aborted.");
    }

    throw new MiningProviderRequestError(
      "unavailable",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function extractOpenAiText(payload: unknown): string {
  if (payload !== null && typeof payload === "object") {
    const outputText = (payload as { output_text?: unknown }).output_text;
    if (typeof outputText === "string" && outputText.trim().length > 0) {
      return outputText;
    }

    const output = (payload as { output?: unknown }).output;
    if (Array.isArray(output)) {
      const collected: string[] = [];

      for (const item of output) {
        if (item === null || typeof item !== "object") {
          continue;
        }

        const content = (item as { content?: unknown }).content;
        if (!Array.isArray(content)) {
          continue;
        }

        for (const part of content) {
          if (part !== null && typeof part === "object") {
            const text = (part as { text?: unknown }).text;
            if (typeof text === "string" && text.trim().length > 0) {
              collected.push(text);
            }
          }
        }
      }

      if (collected.length > 0) {
        return collected.join("\n");
      }
    }
  }

  throw new Error("The built-in OpenAI mining provider returned an empty response.");
}

function extractAnthropicText(payload: unknown): string {
  if (payload !== null && typeof payload === "object") {
    const content = (payload as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const parts = content
        .flatMap((entry) => {
          if (entry !== null && typeof entry === "object") {
            const text = (entry as { text?: unknown }).text;
            return typeof text === "string" && text.trim().length > 0 ? [text] : [];
          }

          return [];
        });
      if (parts.length > 0) {
        return parts.join("\n");
      }
    }
  }

  throw new Error("The built-in Anthropic mining provider returned an empty response.");
}

export async function generateMiningSentences(
  request: MiningSentenceGenerationRequest,
  options: MiningSentenceSourceOptions,
): Promise<{
  candidates: MiningSentenceCandidateV1[];
}> {
  const config = await loadClientConfig({
    path: options.paths.clientConfigPath,
    provider: options.provider,
  });
  const builtIn = config?.mining.builtIn ?? null;

  if (builtIn === null) {
    throw new MiningProviderRequestError("unavailable", "Mining is not configured. Run `cogcoin mine setup`.");
  }

  return {
    candidates: await requestBuiltInSentences({
      provider: builtIn.provider,
      apiKey: builtIn.apiKey,
      modelOverride: builtIn.modelOverride,
      extraPrompt: builtIn.extraPrompt ?? request.extraPrompt,
      request,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    }),
  };
}

export {
  MiningProviderRequestError,
};
