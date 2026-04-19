import type { QuoteDisplayPhase } from "../quotes.js";
import type { BootstrapProgress, WritingQuote } from "../types.js";
import { ART_WIDTH, NEUTRAL_MESSAGE_TITLE } from "./constants.js";
import type { FollowSceneStateForTesting } from "./follow-scene.js";
import { renderFollowFrame } from "./follow-scene.js";
import { formatProgressLine, formatQuoteLine, truncateLine } from "./formatting.js";
import { renderArtFrame } from "./quote-scene.js";
import { renderTrainSceneFrame, resolveTrainSceneMessage, type TrainSceneKind } from "./train-scene.js";

interface RenderStream {
  isTTY?: boolean;
  columns?: number;
  write(chunk: string): boolean | void;
}

interface StreamWriteObserver {
  externalWriteCount: number;
  internalWriteDepth: number;
  refCount: number;
  originalWrite: RenderStream["write"];
}

export interface FollowSceneRenderOptions {
  artworkCogText?: string | null;
  artworkSatText?: string | null;
  artworkStatusLeftText?: string | null;
  artworkStatusRightText?: string | null;
  extraLines?: string[];
}

const STREAM_WRITE_OBSERVERS = new WeakMap<RenderStream, StreamWriteObserver>();

function getStreamWriteObserver(stream: RenderStream): StreamWriteObserver {
  const existing = STREAM_WRITE_OBSERVERS.get(stream);

  if (existing !== undefined) {
    existing.refCount += 1;
    return existing;
  }

  const observer: StreamWriteObserver = {
    externalWriteCount: 0,
    internalWriteDepth: 0,
    refCount: 1,
    originalWrite: stream.write,
  };

  stream.write = ((chunk: string): boolean => {
    if (observer.internalWriteDepth === 0) {
      observer.externalWriteCount += 1;
    }

    const result = observer.originalWrite.call(stream, chunk) as boolean | void;
    return result ?? true;
  }) as RenderStream["write"];

  STREAM_WRITE_OBSERVERS.set(stream, observer);
  return observer;
}

function releaseStreamWriteObserver(stream: RenderStream, observer: StreamWriteObserver): void {
  observer.refCount -= 1;

  if (observer.refCount > 0) {
    return;
  }

  stream.write = observer.originalWrite;
  STREAM_WRITE_OBSERVERS.delete(stream);
}

export class TtyProgressRenderer {
  readonly #stream: RenderStream;
  readonly #streamWriteObserver: StreamWriteObserver;
  #rendered = false;
  #observerReleased = false;
  #lastExternalWriteCount = 0;
  #previousFrameHeight = 0;

  constructor(stream: RenderStream = process.stderr) {
    this.#stream = stream;
    this.#streamWriteObserver = getStreamWriteObserver(stream);
    this.#lastExternalWriteCount = this.#streamWriteObserver.externalWriteCount;
  }

  render(
    displayPhase: QuoteDisplayPhase,
    quote: WritingQuote | null,
    progress: BootstrapProgress,
    cogcoinSyncHeight: number | null,
    cogcoinSyncTargetHeight: number | null,
    introElapsedMs = 0,
    statusFieldText = "",
  ): void {
    const now = Date.now();
    const width = Math.max(20, this.#stream.columns ?? 120);
    const progressLine = formatProgressLine(
      progress,
      cogcoinSyncHeight,
      cogcoinSyncTargetHeight,
      width,
      now,
    );
    const lines = width >= ART_WIDTH
      ? [...renderArtFrame(displayPhase, quote, statusFieldText, introElapsedMs), "", progressLine, ""]
      : [formatQuoteLine(quote, width), progressLine, ""];
    const frame = lines.join("\n");

    this.#resetFrameIfExternalWritesDetected();

    if (!this.#rendered) {
      this.#writeChunk(frame);
      this.#rendered = true;
      this.#previousFrameHeight = lines.length;
      return;
    }

    this.#writeChunk(this.#clearPreviousFrame());
    this.#writeChunk(frame);
    this.#previousFrameHeight = lines.length;
  }

  renderTrainScene(
    kind: TrainSceneKind,
    progress: BootstrapProgress,
    cogcoinSyncHeight: number | null,
    cogcoinSyncTargetHeight: number | null,
    elapsedMs: number,
    statusFieldText = "",
  ): void {
    const now = Date.now();
    const width = Math.max(20, this.#stream.columns ?? 120);
    const progressLine = formatProgressLine(
      progress,
      cogcoinSyncHeight,
      cogcoinSyncTargetHeight,
      width,
      now,
    );
    const sceneMessage = resolveTrainSceneMessage(kind, elapsedMs);
    const lines = width >= ART_WIDTH
      ? [...renderTrainSceneFrame(kind, elapsedMs, statusFieldText), "", progressLine, ""]
      : [truncateLine(sceneMessage, width), progressLine, ""];
    const frame = lines.join("\n");

    this.#resetFrameIfExternalWritesDetected();

    if (!this.#rendered) {
      this.#writeChunk(frame);
      this.#rendered = true;
      this.#previousFrameHeight = lines.length;
      return;
    }

    this.#writeChunk(this.#clearPreviousFrame());
    this.#writeChunk(frame);
    this.#previousFrameHeight = lines.length;
  }

  renderFollowScene(
    progress: BootstrapProgress,
    cogcoinSyncHeight: number | null,
    cogcoinSyncTargetHeight: number | null,
    followScene: FollowSceneStateForTesting,
    statusFieldText = "",
    renderOptions: FollowSceneRenderOptions = {},
  ): void {
    const now = Date.now();
    const width = Math.max(20, this.#stream.columns ?? 120);
    const progressLine = formatProgressLine(
      progress,
      cogcoinSyncHeight,
      cogcoinSyncTargetHeight,
      width,
      now,
    );
    const extraLines = (renderOptions.extraLines ?? []).map((line) => truncateLine(line, width));
    const lines = width >= ART_WIDTH
      ? [...renderFollowFrame(followScene, statusFieldText, now, {
        artworkCogText: renderOptions.artworkCogText ?? null,
        artworkSatText: renderOptions.artworkSatText ?? null,
        artworkStatusLeftText: renderOptions.artworkStatusLeftText ?? null,
        artworkStatusRightText: renderOptions.artworkStatusRightText ?? null,
      }), "", progressLine, "", ...extraLines]
      : [truncateLine(NEUTRAL_MESSAGE_TITLE, width), progressLine, "", ...extraLines];
    const frame = lines.join("\n");

    this.#resetFrameIfExternalWritesDetected();

    if (!this.#rendered) {
      this.#writeChunk(frame);
      this.#rendered = true;
      this.#previousFrameHeight = lines.length;
      return;
    }

    this.#writeChunk(this.#clearPreviousFrame());
    this.#writeChunk(frame);
    this.#previousFrameHeight = lines.length;
  }

  close(): void {
    if (this.#rendered) {
      this.#writeChunk("\n");
      this.#rendered = false;
      this.#previousFrameHeight = 0;
    }

    if (this.#observerReleased) {
      return;
    }

    releaseStreamWriteObserver(this.#stream, this.#streamWriteObserver);
    this.#observerReleased = true;
  }

  #writeChunk(chunk: string): void {
    this.#streamWriteObserver.internalWriteDepth += 1;

    try {
      this.#stream.write(chunk);
    } finally {
      this.#streamWriteObserver.internalWriteDepth = Math.max(0, this.#streamWriteObserver.internalWriteDepth - 1);
      this.#lastExternalWriteCount = this.#streamWriteObserver.externalWriteCount;
    }
  }

  #resetFrameIfExternalWritesDetected(): void {
    if (!this.#rendered) {
      return;
    }

    if (this.#streamWriteObserver.externalWriteCount === this.#lastExternalWriteCount) {
      return;
    }

    this.#rendered = false;
    this.#previousFrameHeight = 0;
    this.#lastExternalWriteCount = this.#streamWriteObserver.externalWriteCount;
  }

  #clearPreviousFrame(): string {
    let clear = "";

    for (let index = 0; index < this.#previousFrameHeight; index += 1) {
      clear += "\r\u001B[2K";

      if (index < this.#previousFrameHeight - 1) {
        clear += "\u001B[1A";
      }
    }

    return clear;
  }
}
