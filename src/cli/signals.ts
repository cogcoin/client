import type {
  InterruptibleOutcome,
  ManagedClientLike,
  SignalSource,
  StopSignalWatcher,
  WritableLike,
} from "./types.js";
import { writeLine } from "./io.js";
import { clearLockIfOwnedByCurrentProcess } from "../wallet/fs/lock.js";

export function createCloseSignalWatcher(options: {
  signalSource: SignalSource;
  stderr: WritableLike;
  closeable: {
    close(): Promise<void>;
  };
  forceExit: (code: number) => never | void;
  lockPaths?: readonly string[];
  firstMessage?: string | null;
  successMessage?: string | null;
  failureMessage?: string | null;
}): StopSignalWatcher {
  let closing = false;
  let resolved = false;
  let onSignal = (): void => {};

  const cleanup = (): void => {
    options.signalSource.off("SIGINT", onSignal);
    options.signalSource.off("SIGTERM", onSignal);
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
        [...new Set(options.lockPaths ?? [])].map(async (lockPath) => {
          await clearLockIfOwnedByCurrentProcess(lockPath);
        }),
      );
    };

    const onFirstSignal = (): void => {
      closing = true;
      if (options.firstMessage !== null && options.firstMessage !== undefined) {
        writeLine(options.stderr, options.firstMessage);
      }
      void options.closeable.close().then(
        async () => {
          await releaseOwnedLocks();
          if (resolved) {
            return;
          }
          if (options.successMessage !== null && options.successMessage !== undefined) {
            writeLine(options.stderr, options.successMessage);
          }
          settle(0);
        },
        async () => {
          await releaseOwnedLocks();
          if (resolved) {
            return;
          }
          if (options.failureMessage !== null && options.failureMessage !== undefined) {
            writeLine(options.stderr, options.failureMessage);
          }
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
      if ((options.lockPaths ?? []).length === 0) {
        options.forceExit(130);
        return;
      }
      void releaseOwnedLocks().finally(() => {
        options.forceExit(130);
      });
    };
  });

  options.signalSource.on("SIGINT", onSignal);
  options.signalSource.on("SIGTERM", onSignal);

  return {
    cleanup,
    isStopping: () => closing,
    promise,
  };
}

export function createStopSignalWatcher(
  signalSource: SignalSource,
  stderr: WritableLike,
  client: ManagedClientLike,
  forceExit: (code: number) => never | void,
  lockPaths: readonly string[] = [],
): StopSignalWatcher {
  return createCloseSignalWatcher({
    signalSource,
    stderr,
    closeable: client,
    forceExit,
    lockPaths,
    firstMessage: "Detaching from managed Cogcoin client and resuming background indexer follow...",
    successMessage: "Detached cleanly; background indexer follow resumed.",
    failureMessage: "Detach failed before background indexer follow was confirmed.",
  });
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
