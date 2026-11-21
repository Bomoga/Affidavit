import { SseTrialEvent, TERMINAL_STAGES, type TrialEvent } from '@affidavit/contracts';
import type { TenantCases } from './backend.js';
import type { SseConfig } from './config.js';

/**
 * One SSE message for an event. The `id` field is the event seq, so a standard EventSource sends
 * it back as Last-Event-ID on reconnect. JSON.stringify escapes every line break, so `data` is
 * always a single line.
 */
export function formatEvent(event: TrialEvent): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * The resume position from the two places a client may send it: the `Last-Event-ID` header (what
 * EventSource sends) and the `after` query parameter (what a fetch client can set). Both mean
 * "the last seq I have". When both are present the larger wins. -1 means from the start.
 */
export function resumeAfter(header: number | undefined, query: number | undefined): number {
  return Math.max(header ?? -1, query ?? -1);
}

export interface StreamDeps {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  onInvalid?: () => void;
  /**
   * Re-checked before every store read. False (logout, expiry, eviction) ends the stream with a
   * final `session-ended` event.
   */
  sessionLive?: () => Promise<boolean>;
}

/** The last message of a stream whose session ended. A named event, so no trial-event handler sees it. */
export const SESSION_ENDED_MESSAGE = 'event: session-ended\ndata: {"error":"session-ended"}\n\n';

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * The SSE body for one case, as text chunks. Sends every stored event with seq > `after` in seq
 * order, then polls the store for new ones. Seqs are sent contiguously: an event past a hole is
 * held back until the hole fills, or for at most `holeWaitMs` (a seq allocated by a writer that
 * died is never filled), after which the hole is skipped. The stream ends cleanly once the case
 * has been at a terminal stage for `terminalGraceMs` with nothing new, after `maxStreamMs`, when
 * the case stops being visible, or when the client goes away (`signal`). When the session behind
 * the stream ends it closes with SESSION_ENDED_MESSAGE. The store is read at most
 * `config.pageSize` events at a time; a full page is followed at once by the next.
 */
export async function* trialEventStream(
  cases: TenantCases,
  caseId: string,
  after: number,
  config: SseConfig,
  signal: AbortSignal,
  deps: StreamDeps,
): AsyncGenerator<string> {
  yield ': affidavit trial events\nretry: 2000\n\n';
  const started = deps.now();
  let last = after;
  let lastWrite = started;
  let holeSince: number | null = null;
  let terminalQuietSince: number | null = null;
  while (!signal.aborted) {
    if (deps.sessionLive && !(await deps.sessionLive())) {
      if (!signal.aborted) yield SESSION_ENDED_MESSAGE;
      return;
    }
    const batch = await cases.events(caseId, last, config.pageSize);
    if (batch === null || signal.aborted) return;
    let progressed = false;
    let heldBack = false;
    for (const raw of batch) {
      if (raw.seq <= last) continue;
      if (raw.seq !== last + 1) {
        holeSince ??= deps.now();
        if (deps.now() - holeSince < config.holeWaitMs) {
          heldBack = true;
          break;
        }
      }
      holeSince = null;
      const parsed = SseTrialEvent.safeParse(raw);
      if (!parsed.success || parsed.data.caseId !== caseId) {
        // A stored event that does not match the contract is never sent. Skip its seq.
        deps.onInvalid?.();
        last = raw.seq;
        continue;
      }
      yield formatEvent(parsed.data);
      last = parsed.data.seq;
      lastWrite = deps.now();
      progressed = true;
    }
    if (deps.now() - started >= config.maxStreamMs) return;
    // A full page means more may be stored already: read the next page without waiting.
    if (batch.length >= config.pageSize && !heldBack) continue;
    const stage = await cases.stage(caseId);
    if (stage === null) return;
    if (TERMINAL_STAGES.includes(stage) && holeSince === null) {
      if (progressed || terminalQuietSince === null) terminalQuietSince = deps.now();
      else if (deps.now() - terminalQuietSince >= config.terminalGraceMs) return;
    } else {
      terminalQuietSince = null;
    }
    if (deps.now() - started >= config.maxStreamMs) return;
    if (deps.now() - lastWrite >= config.heartbeatMs) {
      yield ': keepalive\n\n';
      lastWrite = deps.now();
    }
    await deps.sleep(config.pollMs, signal);
  }
}
