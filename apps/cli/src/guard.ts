/** Thrown by `guard` when a database call outlives its deadline or the user interrupts. */
export class RaceStop extends Error {
  constructor(readonly kind: 'aborted' | 'timeout') {
    super(kind === 'aborted' ? 'interrupted' : 'database request timed out');
    this.name = 'RaceStop';
  }
}

/**
 * Races a promise against a deadline and an abort signal, so a hung database call cannot make the
 * CLI ignore its timeout or SIGINT. The losing promise is left to settle on its own (its error, if
 * any, is swallowed).
 */
export function guard<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  ms: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const onAbort = () => finish(() => reject(new RaceStop('aborted')));
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    if (signal?.aborted) {
      promise.catch(() => undefined);
      reject(new RaceStop('aborted'));
      return;
    }
    const timer = setTimeout(() => finish(() => reject(new RaceStop('timeout'))), Math.max(1, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => finish(() => resolve(v)),
      (e: unknown) => finish(() => reject(e instanceof Error ? e : new Error('unknown error'))),
    );
  });
}
