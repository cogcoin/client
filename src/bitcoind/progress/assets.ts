import { readFileSync } from "node:fs";

import {
  ART_HEIGHT,
  ART_WIDTH,
  FOLLOW_CAR_HEIGHT,
  FOLLOW_CAR_WIDTH,
  TRAIN_SPRITE_HEIGHT,
  TRAIN_SPRITE_WIDTH,
} from "./constants.js";

export type ArtTemplateName = "banner" | "scroll";
export type SpriteName = "train-smoke" | "train";

const ART_TEMPLATE_CACHE: Partial<Record<ArtTemplateName, readonly string[]>> = {};
const SPRITE_CACHE: Partial<Record<SpriteName, readonly string[]>> = {};
let FOLLOW_CAR_TEMPLATE_CACHE: readonly string[] | null = null;

function normalizeArtTemplate(raw: string, name: ArtTemplateName): string[] {
  const lines = raw.replaceAll("\r\n", "\n").split("\n");

  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  if (lines.length !== ART_HEIGHT) {
    throw new Error(`art_template_height_invalid_${name}_${lines.length}`);
  }

  for (const line of lines) {
    if (line.length !== ART_WIDTH) {
      throw new Error(`art_template_width_invalid_${name}_${line.length}`);
    }
  }

  return lines;
}

export function loadArtTemplate(name: ArtTemplateName): readonly string[] {
  const cached = ART_TEMPLATE_CACHE[name];

  if (cached !== undefined) {
    return cached;
  }

  const lines = normalizeArtTemplate(
    readFileSync(new URL(`../../art/${name}.txt`, import.meta.url), "utf8"),
    name,
  );
  ART_TEMPLATE_CACHE[name] = lines;
  return lines;
}

function normalizeSprite(raw: string, name: SpriteName): string[] {
  const lines = raw.replaceAll("\r\n", "\n").split("\n");

  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  if (lines.length !== TRAIN_SPRITE_HEIGHT) {
    throw new Error(`sprite_height_invalid_${name}_${lines.length}`);
  }

  return lines.map((line) => {
    if (line.length > TRAIN_SPRITE_WIDTH) {
      throw new Error(`sprite_width_invalid_${name}_${line.length}`);
    }

    return line.padEnd(TRAIN_SPRITE_WIDTH, " ");
  });
}

export function loadSprite(name: SpriteName): readonly string[] {
  const cached = SPRITE_CACHE[name];

  if (cached !== undefined) {
    return cached;
  }

  const lines = normalizeSprite(
    readFileSync(new URL(`../../art/${name}.txt`, import.meta.url), "utf8"),
    name,
  );
  SPRITE_CACHE[name] = lines;
  return lines;
}

function normalizeFollowCarTemplate(raw: string): string[] {
  const lines = raw.replaceAll("\r\n", "\n").split("\n");

  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  if (lines.length !== FOLLOW_CAR_HEIGHT) {
    throw new Error(`sprite_height_invalid_train-car_${lines.length}`);
  }

  return lines.map((line) => {
    if (line.length > FOLLOW_CAR_WIDTH) {
      throw new Error(`sprite_width_invalid_train-car_${line.length}`);
    }

    return line.padEnd(FOLLOW_CAR_WIDTH, " ");
  });
}

export function loadFollowCarTemplate(): readonly string[] {
  if (FOLLOW_CAR_TEMPLATE_CACHE !== null) {
    return FOLLOW_CAR_TEMPLATE_CACHE;
  }

  FOLLOW_CAR_TEMPLATE_CACHE = normalizeFollowCarTemplate(
    readFileSync(new URL("../../art/train-car.txt", import.meta.url), "utf8"),
  );
  return FOLLOW_CAR_TEMPLATE_CACHE;
}

export function loadBannerArtForTesting(): string[] {
  return [...loadArtTemplate("banner")];
}

export function loadScrollArtForTesting(): string[] {
  return [...loadArtTemplate("scroll")];
}

export function loadTrainSmokeArtForTesting(): string[] {
  return [...loadSprite("train-smoke")];
}

export function loadTrainArtForTesting(): string[] {
  return [...loadSprite("train")];
}

export function loadTrainCarArtForTesting(): string[] {
  return [...loadFollowCarTemplate()];
}
