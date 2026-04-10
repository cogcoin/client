import type {
  InterruptibleOutcome,
  ManagedClientLike,
  SignalSource,
  StopSignalWatcher,
  WritableLike,
} from "./types.js";
import { writeLine } from "./io.js";

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
      writeLine(stderr, "Stopping managed Cogcoin client...");
      void client.close().then(
        () => {
          settle(0);
        },
        () => {
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

  return outcome;
}
