import {
  MINING_SENTENCE_MAX_CANDIDATES_PER_ROOT_DOMAIN,
  MINING_SENTENCE_MAX_CANDIDATES_TOTAL,
  MINING_SENTENCE_MAX_CANDIDATE_SENTENCE_UTF8_BYTES,
  MINING_SENTENCE_SCHEMA_VERSION,
  MINING_SENTENCE_TIMEOUT_MS,
} from "./constants.js";

export interface MiningSentenceGenerationRequestV1 {
  schemaVersion: typeof MINING_SENTENCE_SCHEMA_VERSION;
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

export interface MiningSentenceCandidateV1 {
  domainId: number;
  sentence: string;
  attribution?: {
    provider?: string;
    model?: string;
    promptLabel?: string;
  };
}

export interface MiningSentenceGenerationResponseV1 {
  schemaVersion: typeof MINING_SENTENCE_SCHEMA_VERSION;
  requestId: string;
  candidates: MiningSentenceCandidateV1[];
}

export function createMiningSentenceRequestLimits(): MiningSentenceGenerationRequestV1["limits"] {
  return {
    maxCandidateSentenceUtf8Bytes: MINING_SENTENCE_MAX_CANDIDATE_SENTENCE_UTF8_BYTES,
    maxCandidatesPerRootDomain: MINING_SENTENCE_MAX_CANDIDATES_PER_ROOT_DOMAIN,
    maxCandidatesTotal: MINING_SENTENCE_MAX_CANDIDATES_TOTAL,
    timeoutMs: MINING_SENTENCE_TIMEOUT_MS,
  };
}

function normalizeAttribution(
  raw: unknown,
): MiningSentenceCandidateV1["attribution"] | undefined {
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }

  const attribution = raw as Record<string, unknown>;
  const normalized: Record<string, string> = {};

  for (const key of ["provider", "model", "promptLabel"] as const) {
    const value = attribution[key];
    if (typeof value === "string" && value.length > 0) {
      normalized[key] = value;
    }
  }

  return Object.keys(normalized).length === 0
    ? undefined
    : (normalized as MiningSentenceCandidateV1["attribution"]);
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

export function normalizeMiningSentenceResponse(options: {
  request: MiningSentenceGenerationRequestV1;
  response: unknown;
}): {
  response: MiningSentenceGenerationResponseV1;
  candidates: MiningSentenceCandidateV1[];
} {
  const raw = options.response;

  if (raw === null || typeof raw !== "object") {
    throw new Error("Mining sentence generation returned an invalid JSON response.");
  }

  const response = raw as Record<string, unknown>;

  if (response.schemaVersion !== MINING_SENTENCE_SCHEMA_VERSION) {
    throw new Error("Mining sentence generation returned an unsupported schema version.");
  }

  if (response.requestId !== options.request.requestId) {
    throw new Error("Mining sentence generation returned a mismatched requestId.");
  }

  if (!Array.isArray(response.candidates)) {
    throw new Error("Mining sentence generation response must include a candidates array.");
  }

  if (response.candidates.length > options.request.limits.maxCandidatesTotal) {
    throw new Error("Mining sentence generation returned too many total candidates.");
  }

  const allowedDomainIds = new Set(options.request.rootDomains.map((domain) => domain.domainId));
  const perDomainCounts = new Map<number, number>();
  const dedupe = new Set<string>();
  const candidates: MiningSentenceCandidateV1[] = [];

  for (const rawCandidate of response.candidates) {
    if (rawCandidate === null || typeof rawCandidate !== "object") {
      throw new Error("Mining sentence generation returned an invalid candidate entry.");
    }

    const candidate = rawCandidate as Record<string, unknown>;
    const domainId = candidate.domainId;
    const sentence = candidate.sentence;

    if (!Number.isInteger(domainId)) {
      throw new Error("Mining sentence generation candidate is missing a valid domainId.");
    }

    if (!allowedDomainIds.has(domainId as number)) {
      throw new Error("Mining sentence generation candidate referenced an unknown domainId.");
    }

    if (typeof sentence !== "string") {
      throw new Error("Mining sentence generation candidate is missing a valid sentence.");
    }

    const trimmedSentence = sentence.trim();
    if (trimmedSentence.length === 0) {
      throw new Error("Mining sentence generation candidate sentence was empty after trimming.");
    }

    if (Buffer.byteLength(trimmedSentence, "utf8") > options.request.limits.maxCandidateSentenceUtf8Bytes) {
      throw new Error("Mining sentence generation candidate sentence exceeded the UTF-8 byte limit.");
    }

    const nextCount = (perDomainCounts.get(domainId as number) ?? 0) + 1;
    perDomainCounts.set(domainId as number, nextCount);
    if (nextCount > options.request.limits.maxCandidatesPerRootDomain) {
      throw new Error("Mining sentence generation returned too many candidates for one domain.");
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
      schemaVersion: MINING_SENTENCE_SCHEMA_VERSION,
      requestId: options.request.requestId,
      candidates,
    },
    candidates,
  };
}
