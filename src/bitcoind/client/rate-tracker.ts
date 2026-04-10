import type { BlockRateTracker } from "./internal-types.js";

export function estimateEtaSeconds(
  tracker: BlockRateTracker,
  currentHeight: number,
  targetHeight: number,
): number | null {
  const now = Date.now();

  if (
    tracker.lastHeight !== null
    && tracker.lastUpdatedAt !== null
    && currentHeight > tracker.lastHeight
  ) {
    const elapsedSeconds = Math.max(0.001, (now - tracker.lastUpdatedAt) / 1000);
    const blocksPerSecond = (currentHeight - tracker.lastHeight) / elapsedSeconds;

    tracker.blocksPerSecond = tracker.blocksPerSecond === null
      ? blocksPerSecond
      : ((tracker.blocksPerSecond * 3) + blocksPerSecond) / 4;
  } else if (tracker.lastHeight !== null && currentHeight < tracker.lastHeight) {
    tracker.blocksPerSecond = null;
  }

  tracker.lastHeight = currentHeight;
  tracker.lastUpdatedAt = now;

  if (currentHeight >= targetHeight) {
    return 0;
  }

  if (tracker.blocksPerSecond === null || tracker.blocksPerSecond <= 0) {
    return null;
  }

  return (targetHeight - currentHeight) / tracker.blocksPerSecond;
}
