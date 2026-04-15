import type { ProgressOutputMode } from "../types.js";
import { HEADLESS_PROGRESS_TICK_MS, PROGRESS_TICK_MS } from "./constants.js";

export interface TtyRenderStream {
  isTTY?: boolean;
  columns?: number;
  write(chunk: string): boolean | void;
}

export interface RenderClock {
  now(): number;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

export interface TtyRenderPolicy {
  enabled: boolean;
  linuxHeadlessThrottle: boolean;
  repaintIntervalMs: number;
}

export const DEFAULT_RENDER_CLOCK: RenderClock = {
  now: () => Date.now(),
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};

export function resolveTtyRenderPolicy(
  progressOutput: ProgressOutputMode,
  stream: Pick<TtyRenderStream, "isTTY">,
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  } = {},
): TtyRenderPolicy {
  const ttyActive = stream.isTTY === true;
  const enabled = progressOutput === "none"
    ? false
    : progressOutput === "tty"
      ? true
      : ttyActive;
  const env = options.env ?? process.env;
  const linuxHeadlessThrottle = enabled
    && ttyActive
    && (options.platform ?? process.platform) === "linux"
    && (env.DISPLAY?.trim() ?? "").length === 0
    && (env.WAYLAND_DISPLAY?.trim() ?? "").length === 0;

  return {
    enabled,
    linuxHeadlessThrottle,
    repaintIntervalMs: linuxHeadlessThrottle ? HEADLESS_PROGRESS_TICK_MS : PROGRESS_TICK_MS,
  };
}

export class TtyRenderThrottle {
  readonly #clock: RenderClock;
  readonly #intervalMs: number;
  readonly #onRender: () => void;
  readonly #throttled: boolean;
  #lastRenderAt: number | null = null;
  #pendingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: {
    clock?: RenderClock;
    intervalMs: number;
    onRender: () => void;
    throttled: boolean;
  }) {
    this.#clock = options.clock ?? DEFAULT_RENDER_CLOCK;
    this.#intervalMs = options.intervalMs;
    this.#onRender = options.onRender;
    this.#throttled = options.throttled;
  }

  request(): void {
    if (!this.#throttled) {
      this.cancel();
      this.#renderNow();
      return;
    }

    const now = this.#clock.now();

    if (this.#lastRenderAt === null || (now - this.#lastRenderAt) >= this.#intervalMs) {
      this.cancel();
      this.#renderNow();
      return;
    }

    if (this.#pendingTimer !== null) {
      return;
    }

    const delayMs = Math.max(0, this.#intervalMs - (now - this.#lastRenderAt));
    this.#pendingTimer = this.#clock.setTimeout(() => {
      this.#pendingTimer = null;
      this.#renderNow();
    }, delayMs);
  }

  flush(): void {
    if (this.#pendingTimer === null) {
      return;
    }

    this.#clock.clearTimeout(this.#pendingTimer);
    this.#pendingTimer = null;
    this.#renderNow();
  }

  cancel(): void {
    if (this.#pendingTimer === null) {
      return;
    }

    this.#clock.clearTimeout(this.#pendingTimer);
    this.#pendingTimer = null;
  }

  #renderNow(): void {
    this.#lastRenderAt = this.#clock.now();
    this.#onRender();
  }
}
