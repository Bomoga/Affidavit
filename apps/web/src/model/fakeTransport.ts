import type { TrialEvent } from '@affidavit/contracts';
import type { StreamTransport } from './liveStream.js';

/** One scripted fault, applied to the Nth connection (0 is the first). */
export interface ConnectionScript {
  /** Raw messages to send instead of the default replay, in order. */
  messages?: (string | TrialEvent)[];
  /** Drop the connection (throw) after this many messages. Omit to end cleanly. */
  dropAfter?: number;
}

export interface FakeTransportOptions {
  /** Events to replay, from the fixture. */
  events: readonly TrialEvent[];
  /** Honour the resume position by sending only seqs after it. Default true. */
  honourResume?: boolean;
  /** Per connection overrides. Connections without a script replay the events. */
  scripts?: readonly (ConnectionScript | undefined)[];
  /** Awaited between messages so a test can step the stream. */
  gate?: () => Promise<void>;
}

export interface FakeTransport extends StreamTransport {
  /** The resume position each connection was opened with. */
  readonly opens: readonly (number | undefined)[];
}

const text = (m: string | TrialEvent): string => (typeof m === 'string' ? m : JSON.stringify(m));

/**
 * Replays recorded events as an incremental stream and injects faults: a mid-stream drop,
 * duplicate re-delivery, skipped seqs, and malformed messages (write those as `messages`).
 */
export function createFakeTransport(options: FakeTransportOptions): FakeTransport {
  const ordered = [...options.events].sort((a, b) => a.seq - b.seq);
  const opens: (number | undefined)[] = [];
  return {
    opens,
    // eslint-disable-next-line @typescript-eslint/require-await
    async open(_caseId, afterSeq, signal) {
      const index = opens.length;
      opens.push(afterSeq);
      const script = options.scripts?.[index];
      const honour = options.honourResume ?? true;
      const source =
        script?.messages ??
        ordered.filter((e) => !honour || afterSeq === undefined || e.seq > afterSeq);
      return (async function* () {
        let sent = 0;
        for (const m of source) {
          if (signal.aborted) return;
          if (script?.dropAfter !== undefined && sent >= script.dropAfter)
            throw new Error('connection dropped');
          await options.gate?.();
          yield text(m);
          sent += 1;
        }
        if (script?.dropAfter !== undefined && sent >= script.dropAfter)
          throw new Error('connection dropped');
      })();
    },
  };
}
