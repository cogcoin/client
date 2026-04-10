import {
  MINING_HOOK_MAX_CANDIDATES_PER_ROOT_DOMAIN,
  MINING_HOOK_MAX_CANDIDATES_TOTAL,
  MINING_HOOK_MAX_CANDIDATE_SENTENCE_UTF8_BYTES,
  MINING_HOOK_SCHEMA_VERSION,
  MINING_HOOK_TIMEOUT_MS,
} from "./constants.js";

export interface GenerateSentencesHookRequestV1 {
  schemaVersion: typeof MINING_HOOK_SCHEMA_VERSION;
  requestId: string;
  targetBlockHeight: number;
  referencedBlockHashDisplay: string;
  generatedAtUnixMs: number;
  extraPrompt: string | null;
  limits: {
    maxCandidatesPerRootDomain: number;
    maxCandidatesTotal: number;
    timeoutMs: number;
    maxCandidateSentenceUtf8Bytes: number;
  };
  rootDomains: Array<{
    domainId: number;
    domainName: string;
    requiredWords: [string, string, string, string, string];
  }>;
}

export interface GenerateSentencesHookCandidateV1 {
  domainId: number;
  sentence: string;
  attribution?: {
    hook?: string;
    provider?: string;
    model?: string;
    promptLabel?: string;
  };
}

export interface GenerateSentencesHookResponseV1 {
  schemaVersion: typeof MINING_HOOK_SCHEMA_VERSION;
  requestId: string;
  candidates: GenerateSentencesHookCandidateV1[];
}

export type MiningHookOperatorValidationState = "never" | "current" | "stale" | "failed";

export const MINING_HOOK_VALIDATION_FIXTURES: GenerateSentencesHookRequestV1[] = [
  {
    schemaVersion: MINING_HOOK_SCHEMA_VERSION,
    requestId: "validation-empty-mining-v1",
    targetBlockHeight: 840_000,
    referencedBlockHashDisplay: "0000000000000000000000000000000000000000000000000000000000000042",
    generatedAtUnixMs: 0,
    extraPrompt: "",
    limits: {
      maxCandidateSentenceUtf8Bytes: MINING_HOOK_MAX_CANDIDATE_SENTENCE_UTF8_BYTES,
      maxCandidatesPerRootDomain: MINING_HOOK_MAX_CANDIDATES_PER_ROOT_DOMAIN,
      maxCandidatesTotal: MINING_HOOK_MAX_CANDIDATES_TOTAL,
      timeoutMs: MINING_HOOK_TIMEOUT_MS,
    },
    rootDomains: [],
  },
  {
    schemaVersion: MINING_HOOK_SCHEMA_VERSION,
    requestId: "validation-fixture-mining-v1",
    targetBlockHeight: 840_000,
    referencedBlockHashDisplay: "0000000000000000000000000000000000000000000000000000000000000042",
    generatedAtUnixMs: 0,
    extraPrompt: "",
    limits: {
      maxCandidateSentenceUtf8Bytes: MINING_HOOK_MAX_CANDIDATE_SENTENCE_UTF8_BYTES,
      maxCandidatesPerRootDomain: MINING_HOOK_MAX_CANDIDATES_PER_ROOT_DOMAIN,
      maxCandidatesTotal: MINING_HOOK_MAX_CANDIDATES_TOTAL,
      timeoutMs: MINING_HOOK_TIMEOUT_MS,
    },
    rootDomains: [
      {
        domainId: 424_242,
        domainName: "fixture",
        requiredWords: ["abandon", "ability", "able", "about", "above"],
      },
    ],
  },
];

export function createGenerateSentencesHookLimits(): GenerateSentencesHookRequestV1["limits"] {
  return {
    maxCandidateSentenceUtf8Bytes: MINING_HOOK_MAX_CANDIDATE_SENTENCE_UTF8_BYTES,
    maxCandidatesPerRootDomain: MINING_HOOK_MAX_CANDIDATES_PER_ROOT_DOMAIN,
    maxCandidatesTotal: MINING_HOOK_MAX_CANDIDATES_TOTAL,
    timeoutMs: MINING_HOOK_TIMEOUT_MS,
  };
}

function normalizeAttribution(
  raw: unknown,
): GenerateSentencesHookCandidateV1["attribution"] | undefined {
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }

  const attribution = raw as Record<string, unknown>;
  const normalized: Record<string, string> = {};

  for (const key of ["hook", "provider", "model", "promptLabel"] as const) {
    const value = attribution[key];
    if (typeof value === "string" && value.length > 0) {
      normalized[key] = value;
    }
  }

  return Object.keys(normalized).length === 0
    ? undefined
    : (normalized as GenerateSentencesHookCandidateV1["attribution"]);
}

export function parseStrictJsonValue(raw: string, invalidMessage: string): unknown {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    throw new Error(invalidMessage);
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error(invalidMessage);
  }
}

export function stripMarkdownCodeFence(raw: string): string {
  const trimmed = raw.trim();

  if (!trimmed.startsWith("```")) {
    return raw;
  }

  const lines = trimmed.split(/\r?\n/);
  if (lines.length < 3) {
    return raw;
  }

  const first = lines[0]!.trim();
  const last = lines.at(-1)?.trim();
  if (!first.startsWith("```") || last !== "```") {
    return raw;
  }

  return lines.slice(1, -1).join("\n");
}

export function normalizeHookResponse(options: {
  request: GenerateSentencesHookRequestV1;
  response: unknown;
}): {
  response: GenerateSentencesHookResponseV1;
  candidates: GenerateSentencesHookCandidateV1[];
} {
  const raw = options.response;

  if (raw === null || typeof raw !== "object") {
    throw new Error("Custom mining hook returned an invalid JSON response.");
  }

  const response = raw as Record<string, unknown>;

  if (response.schemaVersion !== MINING_HOOK_SCHEMA_VERSION) {
    throw new Error("Custom mining hook returned an unsupported schema version.");
  }

  if (response.requestId !== options.request.requestId) {
    throw new Error("Custom mining hook returned a mismatched requestId.");
  }

  if (!Array.isArray(response.candidates)) {
    throw new Error("Custom mining hook response must include a candidates array.");
  }

  if (response.candidates.length > options.request.limits.maxCandidatesTotal) {
    throw new Error("Custom mining hook returned too many total candidates.");
  }

  const allowedDomainIds = new Set(options.request.rootDomains.map((domain) => domain.domainId));
  const perDomainCounts = new Map<number, number>();
  const dedupe = new Set<string>();
  const candidates: GenerateSentencesHookCandidateV1[] = [];

  for (const rawCandidate of response.candidates) {
    if (rawCandidate === null || typeof rawCandidate !== "object") {
      throw new Error("Custom mining hook returned an invalid candidate entry.");
    }

    const candidate = rawCandidate as Record<string, unknown>;
    const domainId = candidate.domainId;
    const sentence = candidate.sentence;

    if (!Number.isInteger(domainId)) {
      throw new Error("Custom mining hook candidate is missing a valid domainId.");
    }

    if (!allowedDomainIds.has(domainId as number)) {
      throw new Error("Custom mining hook candidate referenced an unknown domainId.");
    }

    if (typeof sentence !== "string") {
      throw new Error("Custom mining hook candidate is missing a valid sentence.");
    }

    const trimmedSentence = sentence.trim();
    if (trimmedSentence.length === 0) {
      throw new Error("Custom mining hook candidate sentence was empty after trimming.");
    }

    if (Buffer.byteLength(trimmedSentence, "utf8") > options.request.limits.maxCandidateSentenceUtf8Bytes) {
      throw new Error("Custom mining hook candidate sentence exceeded the UTF-8 byte limit.");
    }

    const nextCount = (perDomainCounts.get(domainId as number) ?? 0) + 1;
    perDomainCounts.set(domainId as number, nextCount);
    if (nextCount > options.request.limits.maxCandidatesPerRootDomain) {
      throw new Error("Custom mining hook returned too many candidates for one domain.");
    }

    const dedupeKey = `${domainId}:${trimmedSentence}`;
    if (dedupe.has(dedupeKey)) {
      continue;
    }

    dedupe.add(dedupeKey);
    candidates.push({
      domainId: domainId as number,
      sentence: trimmedSentence,
      attribution: normalizeAttribution(candidate.attribution),
    });
  }

  return {
    response: {
      schemaVersion: MINING_HOOK_SCHEMA_VERSION,
      requestId: options.request.requestId,
      candidates,
    },
    candidates,
  };
}
