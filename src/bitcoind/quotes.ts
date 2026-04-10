import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { WritingQuote } from "./types.js";

const BANNER_DISPLAY_MS = 15_000;
const QUOTE_ROTATION_MS = 7_000;

interface PersistedQuoteState {
  datasetHash: string;
  permutation: number[];
  index: number;
  displayStartedAt: number;
  quoteStartedAt: number;
  completedCycles: number;
  updatedAt: number;
}

export type QuoteDisplayPhase = "banner" | "scroll";

export interface QuoteStateSnapshot {
  currentQuote: WritingQuote;
  completedCycles: number;
  index: number;
  permutation: number[];
  displayPhase: QuoteDisplayPhase;
  displayStartedAt: number;
  quoteStartedAt: number;
}

async function writeJsonAtomic(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, JSON.stringify(payload, null, 2));
  await rename(tempPath, path);
}

function isPermutation(indices: number[], length: number): boolean {
  if (indices.length !== length) {
    return false;
  }

  const seen = new Set(indices);

  if (seen.size !== length) {
    return false;
  }

  for (let index = 0; index < length; index += 1) {
    if (!seen.has(index)) {
      return false;
    }
  }

  return true;
}

export function shuffleIndicesForTesting(
  length: number,
  random: () => number = Math.random,
): number[] {
  const indices = Array.from({ length }, (_value, index) => index);

  for (let index = indices.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [indices[index], indices[swapIndex]] = [indices[swapIndex] ?? 0, indices[index] ?? 0];
  }

  return indices;
}

async function loadWritingQuotes(): Promise<{ datasetHash: string; quotes: WritingQuote[] }> {
  const raw = await readFile(new URL("../writing_quotes.json", import.meta.url));
  const datasetHash = createHash("sha256").update(raw).digest("hex");
  const quotes = JSON.parse(raw.toString("utf8")) as WritingQuote[];

  if (!Array.isArray(quotes) || quotes.length === 0) {
    throw new Error("writing_quotes_invalid");
  }

  return { datasetHash, quotes };
}

export async function loadWritingQuotesForTesting(): Promise<{
  datasetHash: string;
  quotes: WritingQuote[];
}> {
  return loadWritingQuotes();
}

export class WritingQuoteRotator {
  readonly #quotes: WritingQuote[];
  readonly #datasetHash: string;
  readonly #statePath: string;
  readonly #random: () => number;
  #state: PersistedQuoteState;
  #queue: Promise<void> = Promise.resolve();

  private constructor(
    quotes: WritingQuote[],
    datasetHash: string,
    statePath: string,
    random: () => number,
    state: PersistedQuoteState,
  ) {
    this.#quotes = quotes;
    this.#datasetHash = datasetHash;
    this.#statePath = statePath;
    this.#random = random;
    this.#state = state;
  }

  static async create(
    statePath: string,
    random: () => number = Math.random,
  ): Promise<WritingQuoteRotator> {
    const { datasetHash, quotes } = await loadWritingQuotes();
    const state = await WritingQuoteRotator.#loadState(statePath, quotes.length, datasetHash, random);

    return new WritingQuoteRotator(quotes, datasetHash, statePath, random, state);
  }

  async current(now = Date.now()): Promise<QuoteStateSnapshot> {
    await this.#advanceIfNeeded(now);
    return this.#snapshot(now);
  }

  async forceAdvance(now = Date.now()): Promise<QuoteStateSnapshot> {
    await this.#enqueue(async () => {
      this.#advanceState(now, 1);
      await writeJsonAtomic(this.#statePath, this.#state);
    });

    return this.#snapshot(now);
  }

  async getPersistedStateForTesting(): Promise<QuoteStateSnapshot> {
    return this.current(Date.now());
  }

  async #advanceIfNeeded(now: number): Promise<void> {
    await this.#enqueue(async () => {
      const elapsed = Math.max(0, now - this.#state.quoteStartedAt);
      const steps = Math.floor(elapsed / QUOTE_ROTATION_MS);

      if (steps <= 0) {
        return;
      }

      this.#advanceState(now, steps);
      await writeJsonAtomic(this.#statePath, this.#state);
    });
  }

  #advanceState(now: number, steps: number): void {
    let remaining = steps;

    while (remaining > 0) {
      const nextIndex = this.#state.index + 1;

      if (nextIndex < this.#state.permutation.length) {
        this.#state.index = nextIndex;
      } else {
        this.#state.completedCycles += 1;
        this.#state.permutation = shuffleIndicesForTesting(this.#quotes.length, this.#random);
        this.#state.index = 0;
      }

      this.#state.quoteStartedAt += QUOTE_ROTATION_MS;
      remaining -= 1;
    }

    if (now > this.#state.quoteStartedAt + QUOTE_ROTATION_MS) {
      this.#state.quoteStartedAt = now - ((now - this.#state.quoteStartedAt) % QUOTE_ROTATION_MS);
    }

    this.#state.updatedAt = now;
  }

  static #advanceLoadedState(
    state: PersistedQuoteState,
    quoteCount: number,
    random: () => number,
    now: number,
  ): void {
    let remaining = Math.floor(Math.max(0, now - state.quoteStartedAt) / QUOTE_ROTATION_MS);

    while (remaining > 0) {
      const nextIndex = state.index + 1;

      if (nextIndex < state.permutation.length) {
        state.index = nextIndex;
      } else {
        state.completedCycles += 1;
        state.permutation = shuffleIndicesForTesting(quoteCount, random);
        state.index = 0;
      }

      state.quoteStartedAt += QUOTE_ROTATION_MS;
      remaining -= 1;
    }

    if (now > state.quoteStartedAt + QUOTE_ROTATION_MS) {
      state.quoteStartedAt = now - ((now - state.quoteStartedAt) % QUOTE_ROTATION_MS);
    }

    state.updatedAt = now;
  }

  #snapshot(now: number): QuoteStateSnapshot {
    const quoteIndex = this.#state.permutation[this.#state.index] ?? 0;
    return {
      currentQuote: this.#quotes[quoteIndex] ?? this.#quotes[0]!,
      completedCycles: this.#state.completedCycles,
      index: this.#state.index,
      permutation: [...this.#state.permutation],
      displayPhase: now < this.#state.displayStartedAt + BANNER_DISPLAY_MS ? "banner" : "scroll",
      displayStartedAt: this.#state.displayStartedAt,
      quoteStartedAt: this.#state.quoteStartedAt,
    };
  }

  async #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const resultPromise = this.#queue.then(fn, fn);
    this.#queue = resultPromise.then(() => undefined, () => undefined);
    return resultPromise;
  }

  static async #loadState(
    statePath: string,
    quoteCount: number,
    datasetHash: string,
    random: () => number,
  ): Promise<PersistedQuoteState> {
    const now = Date.now();

    try {
      const raw = await readFile(statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedQuoteState>;

      if (
        parsed.datasetHash === datasetHash
        && Array.isArray(parsed.permutation)
        && isPermutation(parsed.permutation, quoteCount)
        && typeof parsed.index === "number"
        && parsed.index >= 0
        && parsed.index < parsed.permutation.length
        && typeof parsed.quoteStartedAt === "number"
        && typeof parsed.completedCycles === "number"
      ) {
        const state: PersistedQuoteState = {
          datasetHash,
          permutation: parsed.permutation,
          index: parsed.index,
          displayStartedAt: typeof parsed.displayStartedAt === "number"
            ? parsed.displayStartedAt
            : parsed.quoteStartedAt - BANNER_DISPLAY_MS,
          quoteStartedAt: parsed.quoteStartedAt,
          completedCycles: parsed.completedCycles,
          updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : now,
        };
        WritingQuoteRotator.#advanceLoadedState(state, quoteCount, random, now);
        state.displayStartedAt = now;
        state.quoteStartedAt = now + BANNER_DISPLAY_MS;
        state.updatedAt = now;
        await writeJsonAtomic(statePath, state);

        return state;
      }
    } catch {
      // Fall back to a fresh randomized cycle.
    }

    const state: PersistedQuoteState = {
      datasetHash,
      permutation: shuffleIndicesForTesting(quoteCount, random),
      index: 0,
      displayStartedAt: now,
      quoteStartedAt: now + BANNER_DISPLAY_MS,
      completedCycles: 0,
      updatedAt: now,
    };
    await writeJsonAtomic(statePath, state);
    return state;
  }
}
