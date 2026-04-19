import { loadArtTemplate, loadFollowCarTemplate } from "./assets.js";
import {
  FIELD_LEFT,
  FIELD_WIDTH,
  FOLLOW_AGE_ROW,
  FOLLOW_APPROACH_MS,
  FOLLOW_CAR_HEIGHT,
  FOLLOW_CAR_PITCH,
  FOLLOW_CAR_TOP,
  FOLLOW_CAR_WIDTH,
  FOLLOW_CENTER_SLOT_X,
  FOLLOW_CLIP_MAX_COLUMN,
  FOLLOW_CLIP_MIN_COLUMN,
  FOLLOW_CONNECTION_SLOT_X,
  FOLLOW_FAST_APPROACH_MS,
  FOLLOW_FAST_SHIFT_MS,
  FOLLOW_PENDING_ENTER_MS,
  FOLLOW_PENDING_LABEL,
  FOLLOW_PENDING_OFFSCREEN_LEFT_X,
  FOLLOW_PENDING_SLOT_X,
  FOLLOW_RIGHT_SLOT_XS,
  FOLLOW_SHIFT_MS,
  FOLLOW_WINDOW_LEFT,
  MESSAGE_FIELD_ROW,
  NEUTRAL_MESSAGE_TITLE,
  STATUS_FIELD_ROW,
} from "./constants.js";
import {
  centerLine,
  computeCenteredLeftPadding,
  overlayCenteredField,
  replaceSegment,
  rightAlignLine,
  truncateLine,
} from "./formatting.js";

const FOLLOW_TITLE_LEFT = computeCenteredLeftPadding(NEUTRAL_MESSAGE_TITLE, FIELD_WIDTH);
const FOLLOW_TITLE_WIDTH = NEUTRAL_MESSAGE_TITLE.length;
const FOLLOW_COG_LEFT = 0;
const FOLLOW_COG_WIDTH = FOLLOW_TITLE_LEFT;
const FOLLOW_SAT_LEFT = FOLLOW_TITLE_LEFT + FOLLOW_TITLE_WIDTH;
const FOLLOW_SAT_WIDTH = FIELD_WIDTH - FOLLOW_SAT_LEFT;

export type FollowAnimationKind = "placeholder_enter" | "tip_approach" | "convoy_shift";

export interface FollowAnimation {
  kind: FollowAnimationKind;
  startedAt: number;
  height: number | null;
  durationMs: number;
}

export interface FollowSceneStateForTesting {
  liveActivated: boolean;
  indexedHeight: number | null;
  displayedCenterHeight: number | null;
  observedNodeHeight: number | null;
  blockTimesByHeight: Record<number, number>;
  queuedHeights: number[];
  pendingLabel: string | null;
  pendingStaticX: number | null;
  animation: FollowAnimation | null;
}

interface FollowCarPlacement {
  label: string;
  ageLabel: string | null;
  height: number | null;
  showAge: boolean;
  x: number;
}

export interface FollowFrameRenderOptions {
  artworkCogText?: string | null;
  artworkSatText?: string | null;
}

export function createFollowSceneState(
  indexedHeight: number | null = null,
  blockTimesByHeight: Record<number, number> = {},
): FollowSceneStateForTesting {
  return {
    liveActivated: false,
    indexedHeight,
    displayedCenterHeight: indexedHeight,
    observedNodeHeight: indexedHeight,
    blockTimesByHeight: normalizeFollowBlockTimes(blockTimesByHeight),
    queuedHeights: [],
    pendingLabel: null,
    pendingStaticX: null,
    animation: null,
  };
}

function cloneFollowSceneState(state: FollowSceneStateForTesting): FollowSceneStateForTesting {
  return {
    ...state,
    blockTimesByHeight: { ...state.blockTimesByHeight },
    queuedHeights: [...state.queuedHeights],
    animation: state.animation === null ? null : { ...state.animation },
  };
}

function renderFollowLabel(value: number | null): string {
  return value === null ? FOLLOW_PENDING_LABEL : String(value);
}

function normalizeFollowBlockTimes(blockTimesByHeight: Record<number, number>): Record<number, number> {
  return Object.fromEntries(
    Object.entries(blockTimesByHeight).flatMap(([heightText, blockTime]) => {
      const height = Number(heightText);

      if (!Number.isInteger(height) || height < 0 || !Number.isFinite(blockTime)) {
        return [];
      }

      return [[String(height), Math.trunc(blockTime)]];
    }),
  );
}

export function setFollowBlockTime(
  state: FollowSceneStateForTesting,
  height: number,
  blockTime: number,
): void {
  if (!Number.isInteger(height) || height < 0 || !Number.isFinite(blockTime)) {
    return;
  }

  state.blockTimesByHeight[height] = Math.trunc(blockTime);
}

export function replaceFollowBlockTimes(
  state: FollowSceneStateForTesting,
  blockTimesByHeight: Record<number, number>,
): void {
  state.blockTimesByHeight = normalizeFollowBlockTimes(blockTimesByHeight);
}

export function formatCompactFollowAgeLabel(blockTime: number, now: number): string {
  const elapsedSeconds = Math.max(1, Math.floor(now / 1000) - blockTime);

  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);

  if (elapsedMinutes < 60) {
    return `${Math.max(1, elapsedMinutes)}m`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);

  if (elapsedHours < 24) {
    return `${elapsedHours}h`;
  }

  return `${Math.floor(elapsedHours / 24)}d`;
}

export const formatCompactFollowAgeLabelForTesting = formatCompactFollowAgeLabel;

function leftAlignLane(line: string, width: number): string {
  const aligned = truncateLine(line, width);
  return aligned.padEnd(width, " ");
}

function renderFollowHeaderField(options: FollowFrameRenderOptions): string {
  let field = centerLine(NEUTRAL_MESSAGE_TITLE, FIELD_WIDTH);

  if (options.artworkCogText !== null && options.artworkCogText !== undefined && options.artworkCogText.length > 0) {
    field = replaceSegment(
      field,
      FOLLOW_COG_LEFT,
      FOLLOW_COG_WIDTH,
      leftAlignLane(options.artworkCogText, FOLLOW_COG_WIDTH),
    );
  }

  if (options.artworkSatText !== null && options.artworkSatText !== undefined && options.artworkSatText.length > 0) {
    field = replaceSegment(
      field,
      FOLLOW_SAT_LEFT,
      FOLLOW_SAT_WIDTH,
      rightAlignLine(options.artworkSatText, FOLLOW_SAT_WIDTH),
    );
  }

  return field;
}

function highestTrackedFollowHeight(state: FollowSceneStateForTesting): number {
  return Math.max(
    state.indexedHeight ?? Number.NEGATIVE_INFINITY,
    state.displayedCenterHeight ?? Number.NEGATIVE_INFINITY,
    state.animation?.height ?? Number.NEGATIVE_INFINITY,
    ...state.queuedHeights,
  );
}

function resolveLatestAuthoritativeFollowHeight(
  indexedHeight: number | null,
  nodeHeight: number | null,
): number | null {
  if (indexedHeight === null) {
    return nodeHeight;
  }

  if (nodeHeight === null) {
    return indexedHeight;
  }

  return Math.max(indexedHeight, nodeHeight);
}

function resolveDisplayedFollowHeight(state: FollowSceneStateForTesting): number | null {
  return state.displayedCenterHeight ?? state.indexedHeight;
}

function resetFollowSceneState(state: FollowSceneStateForTesting): void {
  state.displayedCenterHeight = state.indexedHeight;
  state.blockTimesByHeight = {};
  state.queuedHeights = [];
  state.pendingLabel = null;
  state.pendingStaticX = null;
  state.animation = null;
}

function resyncFollowSceneToLatestHeight(
  state: FollowSceneStateForTesting,
  latestHeight: number | null,
): void {
  state.displayedCenterHeight = latestHeight;
  state.queuedHeights = [];
  state.pendingLabel = null;
  state.pendingStaticX = null;
  state.animation = null;
}

function shouldResyncAuthoritativeFollowScene(options: {
  state: FollowSceneStateForTesting;
  latestHeight: number | null;
  settleLatest: boolean;
}): boolean {
  if (options.latestHeight === null) {
    return false;
  }

  if (options.settleLatest) {
    return true;
  }

  const displayedHeight = resolveDisplayedFollowHeight(options.state);

  if (displayedHeight === null) {
    return false;
  }

  return options.latestHeight - displayedHeight > 1;
}

function enqueueFollowHeights(state: FollowSceneStateForTesting, nodeHeight: number): void {
  const startHeight = Math.max(state.indexedHeight ?? -1, highestTrackedFollowHeight(state));

  for (let height = startHeight + 1; height <= nodeHeight; height += 1) {
    state.queuedHeights.push(height);
  }
}

export function syncFollowSceneState(
  state: FollowSceneStateForTesting,
  {
    indexedHeight,
    nodeHeight,
    liveActivated,
    authoritativeTip,
    settleLatest,
  }: {
    indexedHeight?: number | null;
    nodeHeight?: number | null;
    liveActivated?: boolean;
    authoritativeTip?: boolean;
    settleLatest?: boolean;
  },
): void {
  const wasLive = state.liveActivated;
  const nextLive = liveActivated ?? state.liveActivated;
  let shouldReset = false;

  if (indexedHeight !== undefined) {
    if (state.indexedHeight !== null && indexedHeight !== null && indexedHeight < state.indexedHeight) {
      shouldReset = true;
    }

    state.indexedHeight = indexedHeight;

    if (!nextLive || state.displayedCenterHeight === null) {
      state.displayedCenterHeight = indexedHeight;
    }
  }

  if (nodeHeight !== undefined) {
    if (state.observedNodeHeight !== null && nodeHeight !== null && nodeHeight < state.observedNodeHeight) {
      shouldReset = true;
    }

    state.observedNodeHeight = nodeHeight;
  }

  state.liveActivated = nextLive;

  if (shouldReset) {
    resetFollowSceneState(state);
  }

  const latestAuthoritativeHeight = resolveLatestAuthoritativeFollowHeight(
    state.indexedHeight,
    state.observedNodeHeight,
  );

  if (
    state.liveActivated
    && authoritativeTip === true
    && shouldResyncAuthoritativeFollowScene({
      state,
      latestHeight: latestAuthoritativeHeight,
      settleLatest: settleLatest === true,
    })
  ) {
    resyncFollowSceneToLatestHeight(state, latestAuthoritativeHeight);
  } else if (state.liveActivated && state.observedNodeHeight !== null) {
    enqueueFollowHeights(state, state.observedNodeHeight);
  }

  if (!wasLive && state.liveActivated && state.displayedCenterHeight === null) {
    state.displayedCenterHeight = state.indexedHeight;
  }

  if (state.pendingLabel === FOLLOW_PENDING_LABEL && state.queuedHeights.length > 0) {
    state.pendingLabel = renderFollowLabel(state.queuedHeights[0] ?? null);
  }

  if (!state.liveActivated) {
    state.pendingLabel = null;
    state.pendingStaticX = null;
    state.animation = null;
  }
}

function animationDuration(kind: FollowAnimationKind): number {
  switch (kind) {
    case "placeholder_enter":
      return FOLLOW_PENDING_ENTER_MS;
    case "tip_approach":
      return FOLLOW_APPROACH_MS;
    case "convoy_shift":
      return FOLLOW_SHIFT_MS;
  }
}

function shouldUseFastFollowCatchUp(state: FollowSceneStateForTesting): boolean {
  const observedTip = state.observedNodeHeight;

  if (observedTip === null) {
    return false;
  }

  const displayedFollowHeight = state.displayedCenterHeight ?? state.indexedHeight;

  if (displayedFollowHeight === null) {
    return false;
  }

  return observedTip - displayedFollowHeight >= 2;
}

function createFollowAnimation(
  kind: FollowAnimationKind,
  startedAt: number,
  height: number | null,
  durationMs = animationDuration(kind),
): FollowAnimation {
  return {
    kind,
    startedAt,
    height,
    durationMs,
  };
}

export function advanceFollowSceneState(state: FollowSceneStateForTesting, now: number): void {
  for (let index = 0; index < 8; index += 1) {
    if (state.animation !== null) {
      const duration = state.animation.durationMs;

      if (now - state.animation.startedAt < duration) {
        return;
      }

      switch (state.animation.kind) {
        case "placeholder_enter":
          state.pendingStaticX = FOLLOW_PENDING_SLOT_X;
          state.pendingLabel = state.queuedHeights.length > 0
            ? renderFollowLabel(state.queuedHeights[0] ?? null)
            : FOLLOW_PENDING_LABEL;
          state.animation = null;
          continue;
        case "tip_approach":
          state.pendingStaticX = FOLLOW_CONNECTION_SLOT_X;
          state.pendingLabel = renderFollowLabel(state.animation.height);
          state.animation = createFollowAnimation(
            "convoy_shift",
            state.animation.startedAt + state.animation.durationMs,
            state.animation.height,
            shouldUseFastFollowCatchUp(state) ? FOLLOW_FAST_SHIFT_MS : FOLLOW_SHIFT_MS,
          );
          continue;
        case "convoy_shift": {
          const completedHeight = state.animation.height;

          if (completedHeight !== null) {
            state.displayedCenterHeight = completedHeight;
          }

          if (state.queuedHeights[0] === completedHeight) {
            state.queuedHeights.shift();
          }

          state.pendingStaticX = null;
          state.pendingLabel = null;
          state.animation = null;
          continue;
        }
      }
    }

    if (!state.liveActivated) {
      return;
    }

    if (state.queuedHeights.length > 0) {
      state.pendingLabel = renderFollowLabel(state.queuedHeights[0] ?? null);
      state.pendingStaticX ??= FOLLOW_PENDING_SLOT_X;
      state.animation = createFollowAnimation(
        "tip_approach",
        now,
        state.queuedHeights[0] ?? null,
        shouldUseFastFollowCatchUp(state) ? FOLLOW_FAST_APPROACH_MS : FOLLOW_APPROACH_MS,
      );
      continue;
    }

    if (state.pendingLabel === null) {
      state.pendingLabel = FOLLOW_PENDING_LABEL;
      state.pendingStaticX = null;
      state.animation = createFollowAnimation("placeholder_enter", now, null, FOLLOW_PENDING_ENTER_MS);
      continue;
    }

    return;
  }
}

function resolveAnimationProgress(startedAt: number, duration: number, now: number): number {
  return Math.max(0, Math.min(1, (now - startedAt) / duration));
}

function buildFollowCarCanvas(label: string): string[] {
  const sprite = [...loadFollowCarTemplate()];
  sprite[3] = centerLine(label, FOLLOW_CAR_WIDTH);
  return sprite;
}

function createFollowBaseFrame(): string[] {
  return [...loadArtTemplate("scroll")];
}

function overlayFollowCar(
  frame: readonly string[],
  car: FollowCarPlacement,
): string[] {
  const canvas = buildFollowCarCanvas(car.label);
  const rows = frame.map((line) => [...line]);

  for (const [rowOffset, spriteLine] of canvas.entries()) {
    const targetRow = FOLLOW_CAR_TOP + rowOffset;
    const targetChars = rows[targetRow];

    if (targetChars === undefined) {
      continue;
    }

    for (const [columnOffset, character] of [...spriteLine].entries()) {
      const targetColumn = car.x + columnOffset;

      if (
        character === " "
        || targetColumn < FOLLOW_CLIP_MIN_COLUMN
        || targetColumn > FOLLOW_CLIP_MAX_COLUMN
      ) {
        continue;
      }

      targetChars[FOLLOW_WINDOW_LEFT + targetColumn] = character;
    }
  }

  return rows.map((chars) => chars.join(""));
}

function overlayFollowAgeLabel(
  frame: readonly string[],
  car: FollowCarPlacement,
  ageLabel: string,
): string[] {
  const targetChars = [...(frame[FOLLOW_AGE_ROW] ?? "")];

  for (const [columnOffset, character] of [...centerLine(ageLabel, FOLLOW_CAR_WIDTH)].entries()) {
    const targetColumn = car.x + columnOffset;

    if (
      character === " "
      || targetColumn < FOLLOW_CLIP_MIN_COLUMN
      || targetColumn > FOLLOW_CLIP_MAX_COLUMN
    ) {
      continue;
    }

    targetChars[FOLLOW_WINDOW_LEFT + targetColumn] = character;
  }

  return frame.map((line, index) => (index === FOLLOW_AGE_ROW ? targetChars.join("") : line));
}

function resolveFollowAgeLabel(
  state: FollowSceneStateForTesting,
  car: FollowCarPlacement,
  now: number,
): string | null {
  if (car.ageLabel !== null) {
    return car.ageLabel;
  }

  if (!car.showAge || car.height === null) {
    return null;
  }

  const blockTime = state.blockTimesByHeight[car.height];

  if (blockTime === undefined) {
    return null;
  }

  return formatCompactFollowAgeLabel(blockTime, now);
}

function resolveFollowCarPlacements(
  state: FollowSceneStateForTesting,
  now: number,
): FollowCarPlacement[] {
  const placements: FollowCarPlacement[] = [];
  const baseCars = state.displayedCenterHeight === null
    ? []
    : [
      {
        label: renderFollowLabel(state.displayedCenterHeight),
        ageLabel: null,
        height: state.displayedCenterHeight,
        showAge: true,
        x: FOLLOW_CENTER_SLOT_X,
      },
      ...FOLLOW_RIGHT_SLOT_XS.map((x, index) => ({
        label: renderFollowLabel((state.displayedCenterHeight ?? 0) - (index + 1)),
        ageLabel: null,
        height: (state.displayedCenterHeight ?? 0) - (index + 1),
        showAge: true,
        x,
      })).filter((car) => Number(car.label) >= 0),
    ];

  if (state.animation?.kind === "convoy_shift") {
    const progress = resolveAnimationProgress(state.animation.startedAt, state.animation.durationMs, now);
    const offset = Math.round(FOLLOW_CAR_PITCH * progress);

    if (state.animation.height !== null) {
      placements.push({
        label: renderFollowLabel(state.animation.height),
        ageLabel: null,
        height: state.animation.height,
        showAge: false,
        x: Math.round(FOLLOW_CONNECTION_SLOT_X + ((FOLLOW_CENTER_SLOT_X - FOLLOW_CONNECTION_SLOT_X) * progress)),
      });
    }

    placements.push(...baseCars.map((car) => ({
      ...car,
      showAge: true,
      x: car.x + offset,
    })));
    return placements;
  }

  placements.push(...baseCars);

  if (state.animation?.kind === "tip_approach" && state.animation.height !== null) {
    const progress = resolveAnimationProgress(state.animation.startedAt, state.animation.durationMs, now);
    placements.push({
      label: renderFollowLabel(state.animation.height),
      ageLabel: null,
      height: state.animation.height,
      showAge: false,
      x: Math.round(FOLLOW_PENDING_SLOT_X + ((FOLLOW_CONNECTION_SLOT_X - FOLLOW_PENDING_SLOT_X) * progress)),
    });
    return placements;
  }

  if (state.animation?.kind === "placeholder_enter") {
    const progress = resolveAnimationProgress(state.animation.startedAt, state.animation.durationMs, now);
    placements.push({
      label: state.pendingLabel === FOLLOW_PENDING_LABEL ? "" : (state.pendingLabel ?? FOLLOW_PENDING_LABEL),
      ageLabel: state.pendingLabel === FOLLOW_PENDING_LABEL ? FOLLOW_PENDING_LABEL : null,
      height: state.animation.height,
      showAge: false,
      x: Math.round(FOLLOW_PENDING_OFFSCREEN_LEFT_X + ((FOLLOW_PENDING_SLOT_X - FOLLOW_PENDING_OFFSCREEN_LEFT_X) * progress)),
    });
    return placements;
  }

  if (state.pendingLabel !== null && state.pendingStaticX !== null) {
    placements.push({
      label: state.pendingLabel === FOLLOW_PENDING_LABEL ? "" : state.pendingLabel,
      ageLabel: state.pendingLabel === FOLLOW_PENDING_LABEL ? FOLLOW_PENDING_LABEL : null,
      height: null,
      showAge: false,
      x: state.pendingStaticX,
    });
  }

  return placements;
}

export function renderFollowFrame(
  state: FollowSceneStateForTesting,
  statusFieldText: string,
  now: number,
  options: FollowFrameRenderOptions = {},
): string[] {
  let frame = createFollowBaseFrame();
  const placements = resolveFollowCarPlacements(state, now);

  for (const car of placements) {
    frame = overlayFollowCar(frame, car);
  }

  for (const car of placements) {
    const ageLabel = resolveFollowAgeLabel(state, car, now);

    if (ageLabel !== null) {
      frame = overlayFollowAgeLabel(frame, car, ageLabel);
    }
  }

  const headerRow = frame[MESSAGE_FIELD_ROW];
  if (headerRow !== undefined) {
    frame[MESSAGE_FIELD_ROW] = replaceSegment(
      headerRow,
      FIELD_LEFT,
      FIELD_WIDTH,
      renderFollowHeaderField(options),
    );
  }
  overlayCenteredField(frame, STATUS_FIELD_ROW, statusFieldText);

  return frame;
}

export function createFollowSceneStateForTesting(
  indexedHeight: number | null = null,
  blockTimesByHeight: Record<number, number> = {},
): FollowSceneStateForTesting {
  return createFollowSceneState(indexedHeight, blockTimesByHeight);
}

export function setFollowBlockTimesForTesting(
  state: FollowSceneStateForTesting,
  blockTimesByHeight: Record<number, number>,
): FollowSceneStateForTesting {
  replaceFollowBlockTimes(state, blockTimesByHeight);
  return cloneFollowSceneState(state);
}

export function setFollowBlockTimeForTesting(
  state: FollowSceneStateForTesting,
  height: number,
  blockTime: number,
): FollowSceneStateForTesting {
  setFollowBlockTime(state, height, blockTime);
  return cloneFollowSceneState(state);
}

export function syncFollowSceneStateForTesting(
  state: FollowSceneStateForTesting,
  options: {
    indexedHeight?: number | null;
    nodeHeight?: number | null;
    liveActivated?: boolean;
    authoritativeTip?: boolean;
    settleLatest?: boolean;
  },
): FollowSceneStateForTesting {
  syncFollowSceneState(state, options);
  return cloneFollowSceneState(state);
}

export function advanceFollowSceneStateForTesting(
  state: FollowSceneStateForTesting,
  now: number,
): FollowSceneStateForTesting {
  advanceFollowSceneState(state, now);
  return cloneFollowSceneState(state);
}

export function renderFollowFrameForTesting(
  state: FollowSceneStateForTesting,
  statusFieldText = "",
  now = 0,
  options: FollowFrameRenderOptions = {},
): string[] {
  return renderFollowFrame(state, statusFieldText, now, options);
}
