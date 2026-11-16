import { TERMINAL_STAGES, TrialEvent } from '@affidavit/contracts';

/** Ids go into URL paths. Same rule as the MCP server: anything outside this set is refused. */
export const SAFE_CASE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type ConnectionStatus =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'disconnected'
  /** The server refused the stream (404 or another non-retryable 4xx). Retrying cannot help. */
  | 'not-found'
  /** The verdict and the end of the trial have been applied; nothing more is expected. */
  | 'complete';

/** The server answered with a 4xx other than 408 and 429, so reconnecting would only repeat it. */
export class NonRetryableStreamError extends Error {
  constructor(readonly status: number) {
    super(`Event stream refused with status ${status}`);
    this.name = 'NonRetryableStreamError';
  }
}

/** True for a 4xx status that will not change on retry. 408 and 429 are worth retrying. */
export function isNonRetryableStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * One connection to the event stream. `open` resolves once the connection is established and
 * yields each message's data field (raw text, untrusted) until the connection ends. Throwing or
 * rejecting means the connection dropped. `afterSeq` is the last seq already applied; how (or
 * whether) it is sent on the wire is the transport's business, because contracts v1.0 does not
 * specify it. A transport that ignores it replays from the start, which is safe: the client
 * discards every seq it already has.
 */
export interface StreamTransport {
  open(
    caseId: string,
    afterSeq: number | undefined,
    signal: AbortSignal,
  ): Promise<AsyncIterable<string>>;
}

export interface InvalidEventReport {
  reason: 'not-json' | 'schema' | 'wrong-case';
}

export interface StreamSnapshot {
  /** Applied events in seq order, with no duplicates. */
  events: readonly TrialEvent[];
  status: ConnectionStatus;
  /** Events dropped because they were malformed. Never rendered. */
  invalidCount: number;
  /** Times a seq jump forced a reconnect. */
  gapCount: number;
  /** True when the record passed the event cap and the stream stopped. Retry does not help. */
  tooLong: boolean;
}

export interface BackoffPolicy {
  baseMs: number;
  capMs: number;
  /** Consecutive failed attempts before the stream gives up and reports `disconnected`. */
  maxAttempts: number;
  /**
   * Consecutive connections that opened fine and closed cleanly without a single new event
   * (an idle proxy timing out a long stage) before the stream gives up. Defaults to 20.
   */
  maxIdleOpens?: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 500, capMs: 15_000, maxAttempts: 8 };
const DEFAULT_MAX_IDLE_OPENS = 20;

export function backoffDelay(attempt: number, policy: BackoffPolicy): number {
  return Math.min(policy.capMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
}

export interface TrialStreamOptions {
  caseId: string;
  transport: StreamTransport;
  backoff?: BackoffPolicy;
  /** Resolves after `ms`, or immediately when aborted. Injected so tests need no real timers. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onInvalid?: (report: InvalidEventReport) => void;
  /** Most events the stream will apply. Defaults to DEFAULT_MAX_EVENTS. */
  maxEvents?: number;
}

/**
 * Trial always writes a verdict after a dismissal, escalation or budget exhaustion, so the verdict
 * is what ends a case. But trial emits `verdict-written` before the stage's final `stage-exited`
 * and the terminal `stage-entered`, so the verdict alone is not the end of the record. The stream
 * is finished once a verdict has been applied and either the terminal stage was entered (in any
 * order, or the verdict itself was written in a terminal stage), or the server closes the
 * connection cleanly. A clean close before any verdict is a drop, not completion.
 */
function finished(events: readonly TrialEvent[]): boolean {
  const verdict = events.find((e) => e.type === 'verdict-written');
  if (!verdict) return false;
  return (
    TERMINAL_STAGES.includes(verdict.stage) ||
    events.some((e) => e.type === 'stage-entered' && TERMINAL_STAGES.includes(e.stage))
  );
}

const hasVerdict = (events: readonly TrialEvent[]) =>
  events.some((e) => e.type === 'verdict-written');

/** No case in the corpus comes near this; a longer record is refused rather than rendered. */
export const DEFAULT_MAX_EVENTS = 5000;

function realSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}

/** Thrown inside the read loop to drop the connection and reconnect from the last good seq. */
class GapDetected extends Error {}
class RecordTooLong extends Error {}

export interface TrialStream {
  getSnapshot: () => StreamSnapshot;
  subscribe: (listener: () => void) => () => void;
  start: () => void;
  stop: () => void;
  /** Starts over after `disconnected`, keeping everything already applied. */
  retry: () => void;
}

/**
 * Applies a TrialEvent stream idempotently: every message is parsed with the contract schema
 * (invalid ones are dropped and counted), seqs already seen are ignored, a jump in seq drops the
 * connection and reconnects from the last applied seq, and failures back off with a cap.
 */
export function createTrialStream(options: TrialStreamOptions): TrialStream {
  const policy = options.backoff ?? DEFAULT_BACKOFF;
  const sleep = options.sleep ?? realSleep;
  const listeners = new Set<() => void>();
  let snapshot: StreamSnapshot = {
    events: [],
    status: 'connecting',
    invalidCount: 0,
    gapCount: 0,
    tooLong: false,
  };
  let lastSeq: number | undefined;
  let controller: AbortController | undefined;
  let runId = 0;

  const set = (patch: Partial<StreamSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const l of [...listeners]) l();
  };

  function accept(raw: string, signal: AbortSignal): 'applied' | 'ignored' {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return invalid('not-json');
    }
    const parsed = TrialEvent.safeParse(json);
    if (!parsed.success) return invalid('schema');
    const event = parsed.data;
    if (event.caseId !== options.caseId) return invalid('wrong-case');
    if (lastSeq !== undefined && event.seq <= lastSeq) return 'ignored';
    const expected = lastSeq === undefined ? 0 : lastSeq + 1;
    if (event.seq !== expected) {
      if (!signal.aborted) set({ gapCount: snapshot.gapCount + 1 });
      throw new GapDetected();
    }
    if (snapshot.events.length >= (options.maxEvents ?? DEFAULT_MAX_EVENTS))
      throw new RecordTooLong();
    lastSeq = event.seq;
    set({ events: [...snapshot.events, event] });
    return 'applied';
  }

  function invalid(reason: InvalidEventReport['reason']): 'ignored' {
    set({ invalidCount: snapshot.invalidCount + 1 });
    options.onInvalid?.({ reason });
    return 'ignored';
  }

  async function run(id: number, signal: AbortSignal): Promise<void> {
    // Errors and gaps since the last progress, and clean closes that brought nothing new.
    let failures = 0;
    let idle = 0;
    const maxIdle = policy.maxIdleOpens ?? DEFAULT_MAX_IDLE_OPENS;
    let first = true;
    while (!signal.aborted && id === runId) {
      set({ status: first ? 'connecting' : 'reconnecting' });
      first = false;
      try {
        const messages = await options.transport.open(options.caseId, lastSeq, signal);
        if (signal.aborted) return;
        set({ status: 'live' });
        let progressed = false;
        for await (const raw of messages) {
          if (signal.aborted) return;
          if (accept(raw, signal) === 'applied') {
            progressed = true;
            failures = 0;
            idle = 0;
            // Leaving the loop closes the connection, so a server that keeps it open is fine.
            if (finished(snapshot.events)) return void set({ status: 'complete' });
          }
        }
        if (signal.aborted) return;
        // The server closed the connection cleanly.
        if (hasVerdict(snapshot.events)) return void set({ status: 'complete' });
        if (!progressed) idle += 1;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof RecordTooLong)
          return void set({ status: 'disconnected', tooLong: true });
        if (error instanceof NonRetryableStreamError) return void set({ status: 'not-found' });
        // A dropped connection and a gap are recovered the same way: reconnect from lastSeq.
        failures += 1;
      }
      if (failures >= policy.maxAttempts || idle >= maxIdle)
        return void set({ status: 'disconnected' });
      set({ status: 'reconnecting' });
      await sleep(backoffDelay(Math.max(failures, idle, 1), policy), signal);
    }
  }

  function begin() {
    controller?.abort();
    const c = new AbortController();
    controller = c;
    runId += 1;
    void run(runId, c.signal);
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: begin,
    stop() {
      controller?.abort();
      controller = undefined;
      runId += 1;
    },
    retry() {
      if (snapshot.status === 'disconnected' && !snapshot.tooLong) begin();
    },
  };
}
