export interface AutosaveController<T> {
  schedule(value: T): void;
  scheduleIfChanged(value: T): void;
  flush(): Promise<void>;
  dispose(): void;
}

export function createAutosaveController<T>(
  save: (value: T) => Promise<void>,
  delayMs = 750,
  onError: (error: unknown) => void = () => undefined,
): AutosaveController<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: T | null = null;
  let lastScheduled: T | null = null;
  let inFlight: Promise<void> | null = null;

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function runPending(): Promise<void> {
    clearTimer();
    if (inFlight) {
      return inFlight.then(() => runPending());
    }
    const value = pending;
    pending = null;
    if (value === null) return Promise.resolve();
    const run = save(value).catch((error) => {
      onError(error);
    });
    const tracked = run.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return inFlight;
  }

  function schedule(value: T) {
    pending = value;
    lastScheduled = value;
    clearTimer();
    timer = setTimeout(() => void runPending(), delayMs);
  }

  return {
    schedule,
    scheduleIfChanged(value) {
      if (value !== lastScheduled) schedule(value);
    },
    flush: runPending,
    dispose() {
      clearTimer();
      pending = null;
    },
  };
}
