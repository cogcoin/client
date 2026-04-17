import { readFileSync } from "node:fs";

let welcomeArtCache: string | null = null;

export function loadWelcomeArtText(): string {
  if (welcomeArtCache !== null) {
    return welcomeArtCache;
  }

  welcomeArtCache = readFileSync(new URL("../art/welcome.txt", import.meta.url), "utf8");
  return welcomeArtCache;
}
