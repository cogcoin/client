import { readFileSync } from "node:fs";

let welcomeArtCache: string | null = null;
let balanceArtCache: string | null = null;

const FIXED_ART_WIDTH = 80;
const BALANCE_ART_HEIGHT = 10;

function normalizeFixedArtText(raw: string, options: {
  name: string;
  height: number;
}): string {
  const lines = raw.replaceAll("\r\n", "\n").split("\n");

  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  if (lines.length !== options.height) {
    throw new Error(`${options.name}_art_height_invalid_${lines.length}`);
  }

  for (const line of lines) {
    if (line.length !== FIXED_ART_WIDTH) {
      throw new Error(`${options.name}_art_width_invalid_${line.length}`);
    }
  }

  return lines.join("\n");
}

export function loadWelcomeArtText(): string {
  if (welcomeArtCache !== null) {
    return welcomeArtCache;
  }

  welcomeArtCache = readFileSync(new URL("../art/welcome.txt", import.meta.url), "utf8");
  return welcomeArtCache;
}

export function loadBalanceArtText(): string {
  if (balanceArtCache !== null) {
    return balanceArtCache;
  }

  balanceArtCache = normalizeFixedArtText(
    readFileSync(new URL("../art/balance.txt", import.meta.url), "utf8"),
    {
      name: "balance",
      height: BALANCE_ART_HEIGHT,
    },
  );
  return balanceArtCache;
}
