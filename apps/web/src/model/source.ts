import type { TrialEvent } from '@affidavit/contracts';

export interface EventSource {
  /**
   * Yields events in seq order. With no argument the stream starts from the beginning (seq 0
   * included). With `afterSeq`, only events whose seq is greater are yielded, so passing the
   * last seq seen resumes with no gap and no repeat.
   */
  subscribe(afterSeq?: number): AsyncIterable<TrialEvent>;
}

/** Stand-in for the API's SSE endpoint (L3-10 swaps it for the real one). */
export function createFakeEventSource(events: readonly TrialEvent[]): EventSource {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *subscribe(afterSeq?: number) {
      for (const e of ordered) if (afterSeq === undefined || e.seq > afterSeq) yield e;
    },
  };
}
