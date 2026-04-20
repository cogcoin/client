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

function createBuiltInProviderTimeoutError(options: {
  provider: MiningProviderKind;
  timeoutMs: number;
}): MiningProviderRequestError {
  const providerName = options.provider === "anthropic" ? "Anthropic" : "OpenAI";
  const seconds = Number.isInteger(options.timeoutMs / 1_000)
    ? String(options.timeoutMs / 1_000)
    : (options.timeoutMs / 1_000).toFixed(1);
  const unit = seconds === "1" ? "second" : "seconds";
  return new MiningProviderRequestError(
    "unavailable",
    `The built-in ${providerName} mining provider timed out after ${seconds} ${unit}.`,
  );
}

function buildSystemPrompt(extraPrompt: string | null): string {
  const lines = [
    "You are helping generate candidate Cogcoin mining sentences.",
    "Return only JSON matching the requested response schema.",
    "Every sentence must be a single natural-language sentence.",
    "Do not add commentary, markdown, or code fences.",
    "Do not invent domain IDs or request IDs.",
    "Each rootDomains entry may include an extraPrompt that applies only to that domain.",
    "If rootDomains[i].extraPrompt is present, use it only for candidates for that domainId.",
    "If rootDomains[i].extraPrompt is null, fall back to the request-level extraPrompt when it is present.",
    "Never apply one domain's prompt to another domain's candidates.",
  ];

  if (extraPrompt !== null && extraPrompt.trim().length > 0) {
    lines.push(`Request-level fallback instruction: ${extraPrompt.trim()}`);
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

const ANTHROPIC_MINING_RESPONSE_TOOL_NAME = "return_mining_candidates";

const ANTHROPIC_MINING_RESPONSE_TOOL = {
  name: ANTHROPIC_MINING_RESPONSE_TOOL_NAME,
  description: [
    "Return the Cogcoin mining sentence generation result in structured form.",
    "Use this tool exactly once instead of writing prose, markdown, or code fences.",
    "Set schemaVersion to 1, copy the requestId exactly, and include only candidates for domainId values from rootDomains.",
    "Each candidate sentence must be a single natural-language sentence with no surrounding commentary.",
  ].join(" "),
  input_schema: {
    type: "object",
    properties: {
      schemaVersion: { type: "integer" },
      requestId: { type: "string" },
      candidates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            domainId: { type: "integer" },
            sentence: { type: "string" },
          },
          required: ["domainId", "sentence"],
          additionalProperties: false,
        },
      },
    },
    required: ["schemaVersion", "requestId", "candidates"],
    additionalProperties: false,
  },
} as const;

function normalizeProviderCandidateResponse(options: {
  response: unknown;
  request: MiningSentenceGenerationRequest;
  providerLabel: string;
}): MiningSentenceCandidateV1[] {
  try {
    return normalizeMiningSentenceResponse({
      request: options.request,
      response: options.response,
    }).candidates;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : `${options.providerLabel} returned an invalid response.`);
  }
}

function parseProviderJsonResponse(options: {
  raw: string;
  request: MiningSentenceGenerationRequest;
  providerLabel: string;
}): MiningSentenceCandidateV1[] {
  return normalizeProviderCandidateResponse({
    response: parseStrictJsonValue(
      stripMarkdownCodeFence(options.raw),
      `${options.providerLabel} returned invalid JSON.`,
    ),
    request: options.request,
    providerLabel: options.providerLabel,
  });
}

function createProviderSignal(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  didTimeout(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  }, timeoutMs);
  timer.unref?.();

  const handleAbort = () => {
    controller.abort(signal?.reason);
  };

  if (signal !== undefined) {
    if (signal.aborted) {
      handleAbort();
    } else {
      signal.addEventListener("abort", handleAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    didTimeout() {
      return didTimeout;
    },
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", handleAbort);
    },
  };
}

async function requestBuiltInSentences(options: {
  provider: MiningProviderKind;
  apiKey: string;
  modelOverride: string | null;
  request: MiningSentenceGenerationRequest;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<MiningSentenceCandidateV1[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Math.min(MINING_BUILTIN_TIMEOUT_MS, options.request.limits.timeoutMs);
  const providerSignal = createProviderSignal(options.signal, timeoutMs);

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
              content: buildSystemPrompt(options.request.extraPrompt),
            },
            {
              role: "user",
              content: buildUserPrompt(options.request),
            },
          ],
        }),
        signal: providerSignal.signal,
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
        system: buildSystemPrompt(options.request.extraPrompt),
        messages: [
          {
            role: "user",
            content: buildUserPrompt(options.request),
          },
        ],
        tools: [ANTHROPIC_MINING_RESPONSE_TOOL],
        tool_choice: {
          type: "tool",
          name: ANTHROPIC_MINING_RESPONSE_TOOL_NAME,
        },
      }),
      signal: providerSignal.signal,
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
      candidates: normalizeProviderCandidateResponse({
        response: extractAnthropicResponsePayload(await response.json()),
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

    if (providerSignal.didTimeout()) {
      throw createBuiltInProviderTimeoutError({
        provider: options.provider,
        timeoutMs,
      });
    }

    if (
      error instanceof Error
      && (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      throw error;
    }

    throw new MiningProviderRequestError(
      "unavailable",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    providerSignal.dispose();
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

function extractAnthropicResponsePayload(payload: unknown): unknown {
  if (payload !== null && typeof payload === "object") {
    const content = (payload as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const entry of content) {
        if (entry === null || typeof entry !== "object") {
          continue;
        }

        const typedEntry = entry as {
          type?: unknown;
          name?: unknown;
          input?: unknown;
        };
        if (
          typedEntry.type === "tool_use"
          && typedEntry.name === ANTHROPIC_MINING_RESPONSE_TOOL_NAME
        ) {
          return typedEntry.input;
        }
      }
    }
  }

  return parseStrictJsonValue(
    stripMarkdownCodeFence(extractAnthropicText(payload)),
    "The built-in Anthropic mining provider returned invalid JSON.",
  );
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
      request,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    }),
  };
}

export {
  MiningProviderRequestError,
};
