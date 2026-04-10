import { loadClientConfig } from "./config.js";
import { inspectMiningHookState, runGenerateSentencesHookRequest } from "./hooks.js";
import {
  MINING_BUILTIN_TIMEOUT_MS,
} from "./constants.js";
import type { MiningProviderKind } from "./types.js";
import type {
  GenerateSentencesHookCandidateV1,
  GenerateSentencesHookRequestV1,
} from "./hook-protocol.js";
import {
  normalizeHookResponse,
  parseStrictJsonValue,
  stripMarkdownCodeFence,
} from "./hook-protocol.js";
import type { WalletRuntimePaths } from "../runtime.js";
import type { HookClientStateRecord } from "../types.js";
import type { WalletSecretProvider } from "../state/provider.js";

export type MiningSentenceGenerationRequest = GenerateSentencesHookRequestV1;
export type MiningSentenceGenerationCandidate = GenerateSentencesHookCandidateV1;

export interface MiningSentenceSourceOptions {
  paths: WalletRuntimePaths;
  provider: WalletSecretProvider;
  hookState: HookClientStateRecord | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

class MiningProviderRequestError extends Error {
  readonly providerState: "unavailable" | "rate-limited" | "auth-error";

  constructor(providerState: "unavailable" | "rate-limited" | "auth-error", message: string) {
    super(message);
    this.name = "MiningProviderRequestError";
    this.providerState = providerState;
  }
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
  candidates: GenerateSentencesHookCandidateV1[];
  provider: MiningProviderKind;
  model: string;
}): GenerateSentencesHookCandidateV1[] {
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
}): GenerateSentencesHookCandidateV1[] {
  const response = parseStrictJsonValue(
    stripMarkdownCodeFence(options.raw),
    `${options.providerLabel} returned invalid JSON.`,
  );

  try {
    return normalizeHookResponse({
      request: options.request,
      response,
    }).candidates;
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message.replace(/^Custom mining hook /, `${options.providerLabel} `)
        : `${options.providerLabel} returned an invalid response.`,
    );
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
}): Promise<GenerateSentencesHookCandidateV1[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const providerSignal = createProviderSignal(
    options.signal,
    Math.min(MINING_BUILTIN_TIMEOUT_MS, options.request.limits.timeoutMs),
  );

  try {
    if (options.provider === "openai") {
      const model = options.modelOverride ?? "gpt-5.4-mini";
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

    const model = options.modelOverride ?? "claude-sonnet-4-20250514";
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

async function requestCustomHookSentences(options: {
  paths: WalletRuntimePaths;
  hookState: HookClientStateRecord | null;
  request: MiningSentenceGenerationRequest;
  signal?: AbortSignal;
}): Promise<GenerateSentencesHookCandidateV1[]> {
  const inspection = await inspectMiningHookState({
    hookRootPath: options.paths.hooksMiningDir,
    entrypointPath: options.paths.hooksMiningEntrypointPath,
    packagePath: options.paths.hooksMiningPackageJsonPath,
    localState: options.hookState,
    verify: false,
    nowUnixMs: Date.now(),
  });

  if (inspection.mode !== "custom") {
    throw new Error("Custom mining hooks are not enabled.");
  }

  if (inspection.cooldownActive) {
    throw new Error("Custom mining hook is cooling down after repeated failures. Wait for the cooldown to expire or rerun `cogcoin hooks enable mining`.");
  }

  if (
    inspection.operatorValidationState === "failed"
    || inspection.operatorValidationState === "stale"
    || inspection.operatorValidationState === "never"
  ) {
    throw new Error("Custom mining hook validation is stale or failed. Rerun `cogcoin hooks enable mining`.");
  }

  if (inspection.trustStatus !== "trusted") {
    throw new Error(inspection.trustMessage ?? "Custom mining hook trust checks failed.");
  }

  return runGenerateSentencesHookRequest({
    hookRootPath: options.paths.hooksMiningDir,
    entrypointPath: options.paths.hooksMiningEntrypointPath,
    request: options.request,
    signal: options.signal,
    timeoutMs: options.request.limits.timeoutMs,
  }).then((result) => result.candidates);
}

export async function generateMiningSentences(
  request: MiningSentenceGenerationRequest,
  options: MiningSentenceSourceOptions,
): Promise<{
  hookMode: "builtin" | "custom";
  candidates: GenerateSentencesHookCandidateV1[];
  providerState: "ready" | "n/a";
}> {
  const hookMode = options.hookState?.mode === "custom" ? "custom" : "builtin";

  if (hookMode === "custom") {
    return {
      hookMode,
      candidates: await requestCustomHookSentences({
        paths: options.paths,
        hookState: options.hookState,
        request,
        signal: options.signal,
      }),
      providerState: "n/a",
    };
  }

  const config = await loadClientConfig({
    path: options.paths.clientConfigPath,
    provider: options.provider,
  });
  const builtIn = config?.mining.builtIn ?? null;

  if (builtIn === null) {
    throw new MiningProviderRequestError("unavailable", "Mining is not configured. Run `cogcoin mine setup`.");
  }

  return {
    hookMode,
    candidates: await requestBuiltInSentences({
      provider: builtIn.provider,
      apiKey: builtIn.apiKey,
      modelOverride: builtIn.modelOverride,
      extraPrompt: builtIn.extraPrompt ?? request.extraPrompt,
      request,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    }),
    providerState: "ready",
  };
}

export {
  MiningProviderRequestError,
};
