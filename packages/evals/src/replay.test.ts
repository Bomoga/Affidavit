import { readFixtureJson } from '@affidavit/testing';
import { describe, expect, it } from 'vitest';
import { ReplayError, replayEvents, type ReplayErrorCode } from './replay.js';

function load(name: string): Record<string, unknown>[] {
  return readFixtureJson(`trials/${name}.events.json`) as Record<string, unknown>[];
}

function codeOf(fn: () => unknown): ReplayErrorCode | 'no-throw' {
  try {
    fn();
  } catch (e) {
    if (e instanceof ReplayError) return e.code;
    throw e;
  }
  return 'no-throw';
}

function failOf(fn: () => unknown): { code: ReplayErrorCode; index: number } | 'no-throw' {
  try {
    fn();
  } catch (e) {
    if (e instanceof ReplayError) return { code: e.code, index: e.index };
    throw e;
  }
  return 'no-throw';
}

describe('replayEvents over fixtures', () => {
  it('extracts the verdict stream', () => {
    const events = load('nodegoat-sqli-001');
    const r = replayEvents(events);
    expect(r.caseId).toBe('case-nodegoat-sqli-001');
    expect(r.outcome).toBe('proven-fixed');
    expect(r.verdict?.outcome).toBe('proven-fixed');
    expect(r.exhibits).toEqual(['exhibit-witness-001', 'exhibit-patch-001']);
    expect(r.ballots).toHaveLength(1);
    expect(r.costRows).toHaveLength(1);
    expect(r.cost.usd).toBe(0);
    expect(r.escalation).toBeUndefined();
    expect(r.eventCount).toBe(events.length);
  });

  it('extracts the escalated stream', () => {
    const r = replayEvents(load('escalated-001'));
    expect(r.outcome).toBe('escalated');
    expect(r.verdict).toBeUndefined();
    expect(r.escalation?.reason).toBe('no-admissible-witness-above-floor');
    expect(r.exhibits).toEqual(['exhibit-witness-001', 'exhibit-witness-002']);
  });

  it('sums StageCost rows', () => {
    const events = load('nodegoat-sqli-001').map((e) => structuredClone(e));
    const costEvent = events.find((e) => e['type'] === 'cost-charged') as {
      payload: { cost: { inputTokens: number; outputTokens: number; usd: number; wallMs: number } };
    };
    costEvent.payload.cost = {
      ...costEvent.payload.cost,
      inputTokens: 10,
      outputTokens: 5,
      usd: 0.25,
      wallMs: 40,
    };
    const r = replayEvents(events);
    expect(r.cost).toEqual({ inputTokens: 10, outputTokens: 5, usd: 0.25, wallMs: 40 });
  });
});

describe('replayEvents rejects bad streams', () => {
  it('rejects an empty stream', () => {
    expect(codeOf(() => replayEvents([]))).toBe('empty-stream');
  });

  it('rejects a gap in seq', () => {
    const events = load('nodegoat-sqli-001').filter((e) => e['seq'] !== 5);
    expect(codeOf(() => replayEvents(events))).toBe('seq-gap');
  });

  it('rejects a seq that goes backwards', () => {
    const events = load('nodegoat-sqli-001').map((e) => structuredClone(e));
    const e4 = events[4];
    if (e4 === undefined) throw new Error('fixture too short');
    e4['seq'] = 2;
    expect(codeOf(() => replayEvents(events))).toBe('seq-not-monotonic');
  });

  it('rejects an illegal stage transition', () => {
    const events = load('nodegoat-sqli-001').map((e) => structuredClone(e));
    const exit = events.find((e) => e['seq'] === 3) as { payload: { to: string } };
    exit.payload.to = 'verdict';
    expect(codeOf(() => replayEvents(events))).toBe('illegal-transition');
  });

  it('rejects a stage that disagrees with the previous exit', () => {
    const events = load('nodegoat-sqli-001').map((e) => structuredClone(e));
    const e4 = events[4];
    if (e4 === undefined) throw new Error('fixture too short');
    e4['stage'] = 'defense';
    expect(codeOf(() => replayEvents(events))).toBe('stage-mismatch');
  });

  it('rejects an unparsable event', () => {
    const events = load('nodegoat-sqli-001').map((e) => structuredClone(e));
    const e2 = events[2];
    if (e2 === undefined) throw new Error('fixture too short');
    e2['type'] = 'not-a-real-event';
    expect(codeOf(() => replayEvents(events))).toBe('unparsable-event');
  });

  it('rejects a stream with no terminal event', () => {
    const events = load('nodegoat-sqli-001').slice(0, -1);
    expect(codeOf(() => replayEvents(events))).toBe('no-terminal-event');
  });

  it('rejects events after a terminal event', () => {
    const events = load('escalated-001').map((e) => structuredClone(e));
    const extra = structuredClone(events[events.length - 1]);
    if (extra === undefined) throw new Error('fixture too short');
    extra['seq'] = events.length;
    events.push(extra);
    expect(codeOf(() => replayEvents(events))).toBe('event-after-terminal');
  });

  it('rejects mixed cases', () => {
    const events = load('nodegoat-sqli-001').map((e) => structuredClone(e));
    const e3 = events[3];
    if (e3 === undefined) throw new Error('fixture too short');
    e3['caseId'] = 'case-other';
    expect(codeOf(() => replayEvents(events))).toBe('case-mismatch');
  });

  it('reports the failing index', () => {
    const gap = load('nodegoat-sqli-001').filter((e) => e['seq'] !== 5);
    expect(failOf(() => replayEvents(gap))).toEqual({ code: 'seq-gap', index: 5 });
    const open = load('nodegoat-sqli-001').slice(0, -1);
    expect(failOf(() => replayEvents(open))).toEqual({
      code: 'no-terminal-event',
      index: open.length - 1,
    });
  });
});

const CASE = 'case-nodegoat-sqli-001';
const escalationPayload = (caseId = CASE) => ({
  escalation: {
    schemaVersion: 1,
    caseId,
    reason: 'budget-exhausted',
    detail: 'test',
  },
});

function reseq(events: Record<string, unknown>[]): Record<string, unknown>[] {
  return events.map((e, i) => ({ ...e, seq: i }));
}

function closingVerdict(outcome: string, caseId: string, stage: string, seq: number) {
  return {
    schemaVersion: 1,
    caseId,
    seq,
    stage,
    at: '2026-11-05T12:00:30.000Z',
    actor: 'stenographer',
    type: 'verdict-written',
    payload: {
      verdict: {
        schemaVersion: 1,
        caseId,
        outcome,
        exhibits: [],
        ballots: [],
        summary: 'Generated from the structured verdict.',
        promptVersions: {},
        modelIds: {},
        cost: [],
      },
    },
  };
}

function dismissedStream(): Record<string, unknown>[] {
  const common = { schemaVersion: 1, caseId: 'case-dismissed', actor: 'stenographer' };
  return [
    {
      ...common,
      seq: 0,
      stage: 'arraign',
      at: '2026-11-05T12:00:00.000Z',
      type: 'stage-entered',
      payload: { from: 'map' },
    },
    {
      ...common,
      seq: 1,
      stage: 'arraign',
      at: '2026-11-05T12:00:01.000Z',
      type: 'stage-exited',
      payload: { to: 'dismissed' },
    },
    {
      ...common,
      seq: 2,
      stage: 'dismissed',
      at: '2026-11-05T12:00:02.000Z',
      type: 'dismissed',
      payload: {
        dismissal: {
          schemaVersion: 1,
          candidateId: 'cand-1',
          reason: 'unreachable',
          detail: 'test',
        },
      },
    },
  ];
}

describe('replayEvents terminal handling', () => {
  it('replays a dismissed stream', () => {
    const r = replayEvents(dismissedStream());
    expect(r.outcome).toBe('dismissed');
    expect(r.dismissal?.reason).toBe('unreachable');
    expect(r.verdict).toBeUndefined();
  });

  it('accepts a closing verdict that matches the dismissed or escalated event', () => {
    const d = dismissedStream();
    const withVerdict = replayEvents([
      ...d,
      closingVerdict('dismissed', 'case-dismissed', 'dismissed', 3),
    ]);
    expect(withVerdict.outcome).toBe('dismissed');
    expect(withVerdict.verdict?.outcome).toBe('dismissed');
    expect(withVerdict.dismissal).toBeDefined();
    const esc = [...load('escalated-001'), closingVerdict('escalated', CASE, 'escalated', 7)];
    const r = replayEvents(esc);
    expect(r.outcome).toBe('escalated');
    expect(r.escalation?.reason).toBe('no-admissible-witness-above-floor');
  });

  it('rejects a closing verdict that disagrees with the terminal event', () => {
    const d = [
      ...dismissedStream(),
      closingVerdict('proven-fixed', 'case-dismissed', 'verdict', 3),
    ];
    expect(failOf(() => replayEvents(d))).toEqual({ code: 'verdict-outcome-mismatch', index: 3 });
    const e = [...load('escalated-001'), closingVerdict('dismissed', CASE, 'escalated', 7)];
    expect(codeOf(() => replayEvents(e))).toBe('verdict-outcome-mismatch');
  });

  it('rejects an escalated verdict with no preceding escalated event', () => {
    const events = load('nodegoat-sqli-001').map((e) => structuredClone(e));
    const last = events[events.length - 1] as { payload: { verdict: { outcome: string } } };
    last.payload.verdict.outcome = 'escalated';
    expect(codeOf(() => replayEvents(events))).toBe('verdict-outcome-mismatch');
  });

  it('rejects a verdict or escalation for another case', () => {
    const v = load('nodegoat-sqli-001').map((e) => structuredClone(e));
    const last = v[v.length - 1] as { payload: { verdict: { caseId: string } } };
    last.payload.verdict.caseId = 'case-other';
    expect(failOf(() => replayEvents(v))).toEqual({ code: 'case-mismatch', index: v.length - 1 });
    const e = load('escalated-001').map((x) => structuredClone(x));
    const esc = e[e.length - 1] as { payload: { escalation: { caseId: string } } };
    esc.payload.escalation.caseId = 'case-other';
    expect(codeOf(() => replayEvents(e))).toBe('case-mismatch');
  });

  it('keeps a mid-stream budget-exhausted event out of the escalation field', () => {
    const events = load('nodegoat-sqli-001').map((e) => structuredClone(e));
    events.splice(9, 0, {
      schemaVersion: 1,
      caseId: CASE,
      seq: 0,
      stage: 'defense',
      at: '2026-11-05T12:00:08.500Z',
      actor: 'judge',
      type: 'budget-exhausted',
      payload: escalationPayload(),
    });
    const r = replayEvents(reseq(events));
    expect(r.outcome).toBe('proven-fixed');
    expect(r.escalation).toBeUndefined();
    expect(r.budgetExhausted?.reason).toBe('budget-exhausted');
  });

  it('rejects events after a mid-stream escalated event', () => {
    const events = load('nodegoat-sqli-001').map((e) => structuredClone(e));
    events.splice(9, 0, {
      schemaVersion: 1,
      caseId: CASE,
      seq: 0,
      stage: 'defense',
      at: '2026-11-05T12:00:08.500Z',
      actor: 'stenographer',
      type: 'escalated',
      payload: escalationPayload(),
    });
    expect(failOf(() => replayEvents(reseq(events)))).toEqual({
      code: 'event-after-terminal',
      index: 10,
    });
  });
});
