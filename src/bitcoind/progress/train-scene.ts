import {
  COMPLETION_ENTRY_MS,
  COMPLETION_EXIT_MS,
  COMPLETION_PAUSE_MS,
  COMPLETION_TOTAL_MS,
  INTRO_ENTRY_MS,
  INTRO_EXIT_MS,
  INTRO_PAUSE_MS,
  INTRO_TOTAL_MS,
  MESSAGE_FIELD_ROW,
  NEUTRAL_MESSAGE_TITLE,
  SCROLL_WINDOW_LEFT,
  STATUS_FIELD_ROW,
  TRAIN_CENTER_X,
  TRAIN_CLIP_MAX_COLUMN,
  TRAIN_CLIP_MIN_COLUMN,
  TRAIN_OFFSCREEN_LEFT_X,
  TRAIN_OFFSCREEN_RIGHT_X,
  TRAIN_SPRITE_TOP,
} from "./constants.js";
import { loadArtTemplate, loadSprite } from "./assets.js";
import { overlayCenteredField } from "./formatting.js";

export type TrainSceneKind = "intro" | "completion";

function resolveTrainSceneTimings(kind: TrainSceneKind): {
  entryMs: number;
  pauseMs: number;
  exitMs: number;
  totalMs: number;
} {
  return kind === "intro"
    ? {
      entryMs: INTRO_ENTRY_MS,
      pauseMs: INTRO_PAUSE_MS,
      exitMs: INTRO_EXIT_MS,
      totalMs: INTRO_TOTAL_MS,
    }
    : {
      entryMs: COMPLETION_ENTRY_MS,
      pauseMs: COMPLETION_PAUSE_MS,
      exitMs: COMPLETION_EXIT_MS,
      totalMs: COMPLETION_TOTAL_MS,
    };
}

export function resolveTrainSceneMessage(kind: TrainSceneKind, elapsedMs: number): string {
  const timings = resolveTrainSceneTimings(kind);

  if (elapsedMs < timings.entryMs) {
    return kind === "intro"
      ? "Here comes the mining train!"
      : "Congratuations, you are synced!";
  }

  if (elapsedMs < timings.entryMs + timings.pauseMs || kind === "completion") {
    return kind === "intro"
      ? "Welcome to Cogcoin!"
      : "You shape your own future.";
  }

  if (elapsedMs < timings.totalMs) {
    return kind === "intro"
      ? "How many sentences will you mine?"
      : "Your Cogcoin story begins...";
  }

  return "";
}

export function resolveIntroMessageForTesting(introElapsedMs: number): string {
  return resolveTrainSceneMessage("intro", introElapsedMs);
}

export function resolveCompletionMessageForTesting(completionElapsedMs: number): string {
  return resolveTrainSceneMessage("completion", completionElapsedMs);
}

function resolveTrainSpriteName(kind: TrainSceneKind, elapsedMs: number): "train-smoke" | "train" {
  const timings = resolveTrainSceneTimings(kind);

  if (elapsedMs >= timings.entryMs && (kind === "completion" || elapsedMs < timings.entryMs + timings.pauseMs)) {
    return "train";
  }

  return "train-smoke";
}

function resolveTrainSpriteX(kind: TrainSceneKind, elapsedMs: number): number {
  const timings = resolveTrainSceneTimings(kind);

  if (elapsedMs <= 0) {
    return TRAIN_OFFSCREEN_RIGHT_X;
  }

  if (elapsedMs < timings.entryMs) {
    const progress = elapsedMs / timings.entryMs;
    return Math.round(
      TRAIN_OFFSCREEN_RIGHT_X + ((TRAIN_CENTER_X - TRAIN_OFFSCREEN_RIGHT_X) * progress),
    );
  }

  if (kind === "completion" || elapsedMs < timings.entryMs + timings.pauseMs) {
    return TRAIN_CENTER_X;
  }

  if (elapsedMs < timings.totalMs) {
    const progress = (elapsedMs - timings.entryMs - timings.pauseMs) / timings.exitMs;
    return Math.round(
      TRAIN_CENTER_X + ((TRAIN_OFFSCREEN_LEFT_X - TRAIN_CENTER_X) * progress),
    );
  }

  return TRAIN_OFFSCREEN_LEFT_X;
}

function overlaySpriteOnFrame(
  frame: readonly string[],
  sprite: readonly string[],
  spriteX: number,
): string[] {
  const rows = frame.map((line) => [...line]);

  for (const [rowOffset, spriteLine] of sprite.entries()) {
    const targetRow = TRAIN_SPRITE_TOP + rowOffset;
    const targetChars = rows[targetRow];

    if (targetChars === undefined) {
      continue;
    }

    for (const [columnOffset, character] of [...spriteLine].entries()) {
      const targetColumn = spriteX + columnOffset;

      if (
        character === " "
        || targetColumn < TRAIN_CLIP_MIN_COLUMN
        || targetColumn > TRAIN_CLIP_MAX_COLUMN
      ) {
        continue;
      }

      targetChars[SCROLL_WINDOW_LEFT + targetColumn] = character;
    }
  }

  return rows.map((chars) => chars.join(""));
}

export function renderTrainSceneFrame(
  kind: TrainSceneKind,
  elapsedMs: number,
  statusFieldText: string,
): string[] {
  const frame = [...loadArtTemplate("scroll")];
  const timings = resolveTrainSceneTimings(kind);
  const renderedFrame = kind === "intro" && elapsedMs >= timings.totalMs
    ? frame
    : overlaySpriteOnFrame(frame, loadSprite(resolveTrainSpriteName(kind, elapsedMs)), resolveTrainSpriteX(kind, elapsedMs));
  const message = resolveTrainSceneMessage(kind, elapsedMs);

  overlayCenteredField(renderedFrame, MESSAGE_FIELD_ROW, message.length > 0 ? message : NEUTRAL_MESSAGE_TITLE);
  overlayCenteredField(renderedFrame, STATUS_FIELD_ROW, statusFieldText);
  return renderedFrame;
}

export function renderIntroFrame(introElapsedMs: number, statusFieldText: string): string[] {
  return renderTrainSceneFrame("intro", introElapsedMs, statusFieldText);
}

export function renderCompletionFrame(completionElapsedMs: number, statusFieldText: string): string[] {
  return renderTrainSceneFrame("completion", completionElapsedMs, statusFieldText);
}

export function renderIntroFrameForTesting(introElapsedMs: number, statusFieldText = ""): string[] {
  return renderIntroFrame(introElapsedMs, statusFieldText);
}

export function renderCompletionFrameForTesting(completionElapsedMs: number, statusFieldText = ""): string[] {
  return renderCompletionFrame(completionElapsedMs, statusFieldText);
}
