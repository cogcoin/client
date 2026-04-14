import { readFileSync } from "node:fs";

const WALLET_ART_WIDTH = 80;
const WALLET_ART_SLOT_WIDTH = 8;
const WALLET_ART_PLACEHOLDER_WORD = "achieved";
const WALLET_ART_WORD_COUNT = 24;

let walletArtTemplateCache: readonly string[] | null = null;

function normalizeWalletArtTemplate(raw: string): string[] {
  const lines = raw.replaceAll("\r\n", "\n").split("\n");

  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  for (const line of lines) {
    if (line.length !== WALLET_ART_WIDTH) {
      throw new Error(`wallet_art_template_width_invalid_${line.length}`);
    }
  }

  const template = lines.join("\n");

  for (let index = 1; index <= WALLET_ART_WORD_COUNT; index += 1) {
    if (!template.includes(`${index}.${WALLET_ART_PLACEHOLDER_WORD}`)) {
      throw new Error(`wallet_art_template_placeholder_missing_${index}`);
    }
  }

  return lines;
}

function loadWalletArtTemplate(): readonly string[] {
  if (walletArtTemplateCache !== null) {
    return walletArtTemplateCache;
  }

  walletArtTemplateCache = normalizeWalletArtTemplate(
    readFileSync(new URL("../art/wallet.txt", import.meta.url), "utf8"),
  );
  return walletArtTemplateCache;
}

function formatWalletArtWord(word: string | undefined): string {
  const normalized = word ?? "";

  if (normalized.length > WALLET_ART_SLOT_WIDTH) {
    throw new Error(`wallet_art_word_too_wide_${normalized.length}`);
  }

  return normalized.padEnd(WALLET_ART_SLOT_WIDTH, " ");
}

export function renderWalletMnemonicRevealArt(words: readonly string[]): string[] {
  const rendered = loadWalletArtTemplate().map((line) => {
    let next = line;

    for (let index = 0; index < WALLET_ART_WORD_COUNT; index += 1) {
      next = next.replace(
        `${index + 1}.${WALLET_ART_PLACEHOLDER_WORD}`,
        `${index + 1}.${formatWalletArtWord(words[index])}`,
      );
    }

    return next;
  });

  if (rendered.some((line) => line.includes(`.${WALLET_ART_PLACEHOLDER_WORD}`))) {
    throw new Error("wallet_art_render_placeholder_unreplaced");
  }

  return rendered;
}

export function loadWalletArtTemplateForTesting(): string[] {
  return [...loadWalletArtTemplate()];
}
