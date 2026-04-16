import type {
  InterruptibleOutcome,
  ManagedClientLike,
  SignalSource,
  StopSignalWatcher,
  WritableLike,
} from "./types.js";
import { writeLine } from "./io.js";
import { clearLockIfOwnedByCurrentProcess } from "../wallet/fs/lock.js";

export function createStopSignalWatcher(
  signalSource: SignalSource,
  stderr: WritableLike,
  client: ManagedClientLike,
  forceExit: (code: number) => never | void,
): StopSignalWatcher {
  let closing = false;
  let resolved = false;
  let onSignal = (): void => {};

  const cleanup = (): void => {
    signalSource.off("SIGINT", onSignal);
    signalSource.off("SIGTERM", onSignal);
  };

  const promise = new Promise<number>((resolve) => {
    const settle = (code: number): void => {
      if (resolved) {
        return;
      }

      resolved = true;
      cleanup();
      resolve(code);
    };

    const onFirstSignal = (): void => {
      closing = true;
      writeLine(stderr, "Detaching from managed Cogcoin client and resuming background indexer follow...");
      void client.close().then(
        () => {
          if (resolved) {
            return;
          }
          writeLine(stderr, "Detached cleanly; background indexer follow resumed.");
          settle(0);
        },
        () => {
          if (resolved) {
            return;
          }
          writeLine(stderr, "Detach failed before background indexer follow was confirmed.");
          settle(1);
        },
      );
    };

    onSignal = (): void => {
      if (!closing) {
        onFirstSignal();
        return;
      }

      settle(130);
      forceExit(130);
    };
  });

  signalSource.on("SIGINT", onSignal);
  signalSource.on("SIGTERM", onSignal);

  return {
    cleanup,
    isStopping: () => closing,
    promise,
  };
}

export function createOwnedLockCleanupSignalWatcher(
  signalSource: SignalSource,
  forceExit: (code: number) => never | void,
  lockPaths: readonly string[],
): StopSignalWatcher {
  let stopping = false;
  let resolved = false;
  let onSignal = (): void => {};

  const cleanup = (): void => {
    signalSource.off("SIGINT", onSignal);
    signalSource.off("SIGTERM", onSignal);
  };

  const promise = new Promise<number>((resolve) => {
    const settle = (code: number): void => {
      if (resolved) {
        return;
      }

      resolved = true;
      cleanup();
      resolve(code);
    };

    const releaseOwnedLocks = async (): Promise<void> => {
      await Promise.allSettled(
        [...new Set(lockPaths)].map(async (lockPath) => {
          await clearLockIfOwnedByCurrentProcess(lockPath);
        }),
      );
    };

    onSignal = (): void => {
      if (stopping) {
        settle(130);
        forceExit(130);
        return;
      }

      stopping = true;
      settle(130);
      void releaseOwnedLocks().finally(() => {
        forceExit(130);
      });
    };
  });

  signalSource.on("SIGINT", onSignal);
  signalSource.on("SIGTERM", onSignal);

  return {
    cleanup,
    isStopping: () => stopping,
    promise,
  };
}

export async function waitForCompletionOrStop<T>(
  promise: Promise<T>,
  stopWatcher: StopSignalWatcher,
): Promise<InterruptibleOutcome<T>> {
  const outcome = await Promise.race([
    promise.then(
      (value) => ({ kind: "completed", value } as const),
      (error) => ({ kind: "error", error } as const),
    ),
    stopWatcher.promise.then((code) => ({ kind: "stopped", code } as const)),
  ]);

  if (outcome.kind === "stopped") {
    return outcome;
  }

  if (outcome.kind === "error") {
    if (stopWatcher.isStopping()) {
      return {
        kind: "stopped",
        code: await stopWatcher.promise,
      };
    }

    throw outcome.error;
  }

  if (stopWatcher.isStopping()) {
    return {
      kind: "stopped",
      code: await stopWatcher.promise,
    };
  }

  return outcome;
}
