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
});
