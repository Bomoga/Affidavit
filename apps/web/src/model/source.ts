import type { TrialEvent } from './types.js';

export interface EventSource {
  /** Yields events with seq greater than `afterSeq`, in order. Resuming never repeats or skips. */
  subscribe(afterSeq?: number): AsyncIterable<TrialEvent>;
}

/** Stand-in for the API's SSE endpoint (L3-10 swaps it for the real one). */
export function createFakeEventSource(events: readonly TrialEvent[]): EventSource {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *subscribe(afterSeq = 0) {
      for (const e of ordered) if (e.seq > afterSeq) yield e;
    },
  };
}
