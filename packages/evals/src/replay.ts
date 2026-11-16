import {
  TrialEvent,
  isLegalTransition,
  type Ballot,
  type CaseId,
  type Dismissal,
  type Escalation,
  type ExhibitId,
  type StageCost,
  type Verdict,
} from '@affidavit/contracts';

export type ReplayErrorCode =
  | 'empty-stream'
  | 'unparsable-event'
  | 'case-mismatch'
  | 'seq-gap'
  | 'seq-not-monotonic'
  | 'illegal-transition'
  | 'stage-mismatch'
  | 'event-after-terminal'
  | 'no-terminal-event';

export class ReplayError extends Error {
  constructor(
    readonly code: ReplayErrorCode,
    /** Index into the input array, or -1 when the problem is the stream as a whole. */
    readonly index: number,
    message: string,
  ) {
    super(message);
    this.name = 'ReplayError';
  }
}

export type TrialOutcome = Verdict['outcome'];

export interface CostTotals {
  inputTokens: number;
  outputTokens: number;
  usd: number;
  wallMs: number;
}

export interface ReplayResult {
  caseId: CaseId;
  outcome: TrialOutcome;
  verdict?: Verdict;
  /** Exhibits cited by the verdict when there is one, else every exhibit submitted in the stream. */
  exhibits: ExhibitId[];
  ballots: Ballot[];
  /** Every cost-charged row, in order. */
  costRows: StageCost[];
  /** Sum of `costRows`. */
  cost: CostTotals;
  escalation?: Escalation;
  dismissal?: Dismissal;
  eventCount: number;
}

type Parsed = ReturnType<typeof TrialEvent.parse>;

function isTerminal(e: Parsed): boolean {
  return e.type === 'verdict-written' || e.type === 'escalated' || e.type === 'dismissed';
}

function checkStages(prev: Parsed, cur: Parsed, index: number): void {
  if (prev.type === 'stage-exited') {
    if (cur.stage !== prev.payload.to) {
      throw new ReplayError(
        'stage-mismatch',
        index,
        `event ${index} is in stage ${cur.stage} but the previous event exited to ${prev.payload.to}`,
      );
    }
  } else if (cur.stage !== prev.stage && !isLegalTransition(prev.stage, cur.stage)) {
    throw new ReplayError(
      'illegal-transition',
      index,
      `event ${index} moves stage ${prev.stage} to ${cur.stage} without a legal transition`,
    );
  }
  if (cur.type === 'stage-entered' && cur.payload.from !== undefined) {
    if (cur.payload.from !== prev.stage) {
      throw new ReplayError(
        'stage-mismatch',
        index,
        `event ${index} enters from ${cur.payload.from} but the previous event was in ${prev.stage}`,
      );
    }
  }
}

/**
 * Validates a recorded trial stream and extracts a structured result. Pure: no I/O, no model
 * calls. Throws `ReplayError` on the first structural problem.
 */
export function replayEvents(raw: readonly unknown[]): ReplayResult {
  const events: Parsed[] = raw.map((item, index) => {
    const parsed = TrialEvent.safeParse(item);
    if (!parsed.success) {
      throw new ReplayError(
        'unparsable-event',
        index,
        `event ${index} does not satisfy TrialEvent: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  });

  const first = events[0];
  if (first === undefined) throw new ReplayError('empty-stream', -1, 'event stream is empty');

  let prev: Parsed | undefined;
  let expectedSeq = 0;
  for (const [index, cur] of events.entries()) {
    if (cur.caseId !== first.caseId) {
      throw new ReplayError('case-mismatch', index, `event ${index} belongs to another case`);
    }
    if (prev !== undefined && cur.seq <= prev.seq) {
      throw new ReplayError(
        'seq-not-monotonic',
        index,
        `event ${index} has seq ${cur.seq} after seq ${prev.seq}`,
      );
    }
    if (cur.seq !== expectedSeq) {
      throw new ReplayError(
        'seq-gap',
        index,
        `event ${index} has seq ${cur.seq}, expected ${expectedSeq}`,
      );
    }
    expectedSeq += 1;

    if (cur.type === 'stage-exited' && !isLegalTransition(cur.stage, cur.payload.to)) {
      throw new ReplayError(
        'illegal-transition',
        index,
        `event ${index} exits ${cur.stage} to ${cur.payload.to}, which is not a legal transition`,
      );
    }
    if (prev !== undefined) {
      if (isTerminal(prev)) {
        throw new ReplayError(
          'event-after-terminal',
          index,
          `event ${index} follows a terminal event`,
        );
      }
      checkStages(prev, cur, index);
    }
    prev = cur;
  }

  const last = events[events.length - 1];
  if (last === undefined || !isTerminal(last)) {
    throw new ReplayError(
      'no-terminal-event',
      events.length - 1,
      'stream does not end in a terminal event',
    );
  }

  const costRows: StageCost[] = [];
  const ballotEvents: Ballot[] = [];
  const submitted: ExhibitId[] = [];
  let escalation: Escalation | undefined;
  for (const e of events) {
    if (e.type === 'cost-charged') costRows.push(e.payload.cost);
    else if (e.type === 'ballot-cast') ballotEvents.push(e.payload.ballot);
    else if (e.type === 'exhibit-submitted') submitted.push(e.payload.exhibitId);
    else if (e.type === 'escalated' || e.type === 'budget-exhausted') {
      escalation = e.payload.escalation;
    }
  }
  const cost = costRows.reduce<CostTotals>(
    (t, c) => ({
      inputTokens: t.inputTokens + c.inputTokens,
      outputTokens: t.outputTokens + c.outputTokens,
      usd: t.usd + c.usd,
      wallMs: t.wallMs + c.wallMs,
    }),
    { inputTokens: 0, outputTokens: 0, usd: 0, wallMs: 0 },
  );

  const base = { caseId: last.caseId, costRows, cost, eventCount: events.length };
  if (last.type === 'verdict-written') {
    const verdict = last.payload.verdict;
    return {
      ...base,
      outcome: verdict.outcome,
      verdict,
      exhibits: [...verdict.exhibits],
      ballots: [...verdict.ballots],
      ...(escalation !== undefined ? { escalation } : {}),
    };
  }
  if (last.type === 'dismissed') {
    return {
      ...base,
      outcome: 'dismissed',
      exhibits: submitted,
      ballots: ballotEvents,
      dismissal: last.payload.dismissal,
    };
  }
  return {
    ...base,
    outcome: 'escalated',
    exhibits: submitted,
    ballots: ballotEvents,
    ...(escalation !== undefined ? { escalation } : {}),
  };
}
