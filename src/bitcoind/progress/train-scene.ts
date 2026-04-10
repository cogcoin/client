import {
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

export function resolveTrainSceneMessage(kind: TrainSceneKind, elapsedMs: number): string {
  if (elapsedMs < INTRO_ENTRY_MS) {
    return kind === "intro"
      ? "Here comes the mining train!"
      : "Congratuations, you are synced!";
  }

  if (elapsedMs < INTRO_ENTRY_MS + INTRO_PAUSE_MS) {
    return kind === "intro"
      ? "Welcome to Cogcoin!"
      : "You shape your own future.";
  }

  if (elapsedMs < INTRO_TOTAL_MS) {
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

function resolveIntroSpriteName(introElapsedMs: number): "train-smoke" | "train" {
  if (introElapsedMs >= INTRO_ENTRY_MS && introElapsedMs < INTRO_ENTRY_MS + INTRO_PAUSE_MS) {
    return "train";
  }

  return "train-smoke";
}

function resolveIntroSpriteX(introElapsedMs: number): number {
  if (introElapsedMs <= 0) {
    return TRAIN_OFFSCREEN_RIGHT_X;
  }

  if (introElapsedMs < INTRO_ENTRY_MS) {
    const progress = introElapsedMs / INTRO_ENTRY_MS;
    return Math.round(
      TRAIN_OFFSCREEN_RIGHT_X + ((TRAIN_CENTER_X - TRAIN_OFFSCREEN_RIGHT_X) * progress),
    );
  }

  if (introElapsedMs < INTRO_ENTRY_MS + INTRO_PAUSE_MS) {
    return TRAIN_CENTER_X;
  }

  if (introElapsedMs < INTRO_TOTAL_MS) {
    const progress = (introElapsedMs - INTRO_ENTRY_MS - INTRO_PAUSE_MS) / INTRO_EXIT_MS;
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
  const introFrame = elapsedMs >= INTRO_TOTAL_MS
    ? frame
    : overlaySpriteOnFrame(frame, loadSprite(resolveIntroSpriteName(elapsedMs)), resolveIntroSpriteX(elapsedMs));
  const message = resolveTrainSceneMessage(kind, elapsedMs);

  overlayCenteredField(introFrame, MESSAGE_FIELD_ROW, message.length > 0 ? message : NEUTRAL_MESSAGE_TITLE);
  overlayCenteredField(introFrame, STATUS_FIELD_ROW, statusFieldText);
  return introFrame;
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
