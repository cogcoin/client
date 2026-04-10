import type { QuoteDisplayPhase } from "../quotes.js";
import type { WritingQuote } from "../types.js";
import { loadArtTemplate } from "./assets.js";
import {
  MAX_QUOTE_LINES,
  MESSAGE_FIELD_ROW,
  NEUTRAL_MESSAGE_TITLE,
  SCROLL_WINDOW_HEIGHT,
  SCROLL_WINDOW_TOP,
  SCROLL_WINDOW_WIDTH,
  STATUS_FIELD_ROW,
} from "./constants.js";
import {
  centerLine,
  computeCenteredLeftPadding,
  normalizeInlineText,
  overlayCenteredField,
  positionLine,
  replaceWindowSegment,
  truncateLine,
} from "./formatting.js";
import { renderIntroFrame } from "./train-scene.js";

function consumeWrappedLine(
  text: string,
  capacity: number,
): { line: string; remaining: string } {
  const remaining = text.trimStart();

  if (remaining.length <= capacity) {
    return {
      line: remaining,
      remaining: "",
    };
  }

  const candidate = remaining.slice(0, capacity + 1);
  const breakIndex = candidate.lastIndexOf(" ");

  if (breakIndex > 0) {
    return {
      line: remaining.slice(0, breakIndex).trimEnd(),
      remaining: remaining.slice(breakIndex + 1).trimStart(),
    };
  }

  return {
    line: remaining.slice(0, capacity),
    remaining: remaining.slice(capacity).trimStart(),
  };
}

function wrapTextToCapacities(
  text: string,
  capacities: number[],
): { lines: string[]; remaining: string } {
  let remaining = normalizeInlineText(text);
  const lines: string[] = [];

  for (const capacity of capacities) {
    if (remaining.length === 0) {
      break;
    }

    const wrapped = consumeWrappedLine(remaining, capacity);
    lines.push(wrapped.line);
    remaining = wrapped.remaining;
  }

  return { lines, remaining };
}

function decorateWrappedQuote(lines: string[], truncated: boolean): string[] {
  const decorated = [...lines];
  const lastIndex = decorated.length - 1;
  decorated[0] = `"${decorated[0]}`;
  decorated[lastIndex] = truncated
    ? `${decorated[lastIndex]}\u2026"`
    : `${decorated[lastIndex]}"`;
  return decorated;
}

function wrapQuoteText(text: string): { lines: string[]; truncated: boolean } {
  const normalized = normalizeInlineText(text);

  if (normalized.length === 0) {
    return {
      lines: ["\"\""],
      truncated: false,
    };
  }

  for (let lineCount = 1; lineCount <= MAX_QUOTE_LINES; lineCount += 1) {
    const capacities = lineCount === 1
      ? [SCROLL_WINDOW_WIDTH - 2]
      : [
        SCROLL_WINDOW_WIDTH - 1,
        ...Array.from({ length: Math.max(0, lineCount - 2) }, () => SCROLL_WINDOW_WIDTH),
        SCROLL_WINDOW_WIDTH - 1,
      ];
    const wrapped = wrapTextToCapacities(normalized, capacities);

    if (wrapped.remaining.length === 0) {
      return {
        lines: decorateWrappedQuote(wrapped.lines, false),
        truncated: false,
      };
    }
  }

  const prefixCapacities = [
    SCROLL_WINDOW_WIDTH - 1,
    ...Array.from({ length: MAX_QUOTE_LINES - 2 }, () => SCROLL_WINDOW_WIDTH),
  ];
  const wrapped = wrapTextToCapacities(normalized, prefixCapacities);
  const lastLine = consumeWrappedLine(wrapped.remaining, SCROLL_WINDOW_WIDTH - 2).line;

  return {
    lines: decorateWrappedQuote([...wrapped.lines, lastLine], true),
    truncated: true,
  };
}

function buildQuoteWindowLines(quoteLines: string[]): string[] {
  if (quoteLines.length <= 1) {
    return quoteLines.map((line) => centerLine(line, SCROLL_WINDOW_WIDTH));
  }

  const centeredPaddings = quoteLines.map((line) => computeCenteredLeftPadding(line, SCROLL_WINDOW_WIDTH));
  const lastLine = truncateLine(quoteLines[quoteLines.length - 1] ?? "", SCROLL_WINDOW_WIDTH);
  const maxLastPadding = Math.max(0, SCROLL_WINDOW_WIDTH - lastLine.length);
  const anchoredLastPadding = centeredPaddings
    .slice(0, -1)
    .sort((left, right) => left - right)
    .find((padding) => padding <= maxLastPadding)
    ?? computeCenteredLeftPadding(lastLine, SCROLL_WINDOW_WIDTH);

  return quoteLines.map((line, index) => {
    if (index === quoteLines.length - 1) {
      return positionLine(line, SCROLL_WINDOW_WIDTH, anchoredLastPadding);
    }

    return centerLine(line, SCROLL_WINDOW_WIDTH);
  });
}

function buildScrollWindow(quote: WritingQuote | null): string[] {
  const lines = Array.from({ length: SCROLL_WINDOW_HEIGHT }, () => " ".repeat(SCROLL_WINDOW_WIDTH));

  if (quote === null) {
    return lines;
  }

  const wrappedQuote = wrapQuoteText(quote.quote);
  const byline = truncateLine(`- ${normalizeInlineText(quote.author)}`, SCROLL_WINDOW_WIDTH);
  const quoteWindowLines = buildQuoteWindowLines(wrappedQuote.lines);
  const block = [...quoteWindowLines, " ".repeat(SCROLL_WINDOW_WIDTH), centerLine(byline, SCROLL_WINDOW_WIDTH)];
  const topPadding = Math.max(0, Math.ceil((SCROLL_WINDOW_HEIGHT - block.length) / 2));

  for (const [index, line] of block.entries()) {
    const targetRow = topPadding + index;

    if (targetRow >= SCROLL_WINDOW_HEIGHT) {
      break;
    }

    lines[targetRow] = line;
  }

  return lines;
}

export function renderArtFrame(
  displayPhase: QuoteDisplayPhase,
  quote: WritingQuote | null,
  statusFieldText: string,
  introElapsedMs = 0,
): string[] {
  if (displayPhase === "banner") {
    return renderIntroFrame(introElapsedMs, statusFieldText);
  }

  const frame = [...loadArtTemplate("scroll")];
  const windowLines = buildScrollWindow(quote);

  for (const [rowOffset, windowLine] of windowLines.entries()) {
    const rowIndex = SCROLL_WINDOW_TOP + rowOffset;
    frame[rowIndex] = replaceWindowSegment(frame[rowIndex] ?? "", windowLine);
  }

  overlayCenteredField(frame, MESSAGE_FIELD_ROW, NEUTRAL_MESSAGE_TITLE);
  overlayCenteredField(frame, STATUS_FIELD_ROW, statusFieldText);
  return frame;
}

export function renderArtFrameForTesting(
  displayPhase: QuoteDisplayPhase,
  quote: WritingQuote | null,
  statusFieldText = "",
  introElapsedMs = 0,
): string[] {
  return renderArtFrame(displayPhase, quote, statusFieldText, introElapsedMs);
}
