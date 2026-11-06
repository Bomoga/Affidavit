import { describe, expect, it } from 'vitest';
import { buildCaseView } from './caseView.js';
import { ESCALATED_CASE_EVENTS, GATE_CASE_EVENTS } from './fixtures.js';
import { createFakeEventSource } from './source.js';
import type { TrialEvent } from './types.js';

const EM_DASH = '—';

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out));
  return out;
}

describe('gate case view', () => {
  const view = buildCaseView(GATE_CASE_EVENTS);

  it('renders end to end as verified, with the stamp', () => {
    expect(view.caseId).toBe('nodegoat-sqli-001');
    expect(view.status).toBe('verified');
    expect(view.stamp).toBe('VERIFIED');
    expect(view.humanReview).toBeUndefined();
  });

  it('puts the plain-language summary first', () => {
    expect(view.sections[0]?.id).toBe('summary');
    expect(view.sections[0]?.body).toBe(view.summary);
    expect(view.summary).toContain('fix was shown to stop it');
  });

  it('keeps technical exhibits one level deeper than the summary', () => {
    const ids = view.sections.map((s) => s.id);
    expect(ids.indexOf('summary')).toBeLessThan(ids.indexOf('exhibits'));
    expect(view.exhibits.map((e) => e.id)).toEqual(['ex_w1', 'ex_p1']);
    const witness = view.exhibits.find((e) => e.id === 'ex_w1');
    expect(witness?.runs).toHaveLength(2);
  });

  it('shows a docket in event order', () => {
    expect(view.docket.length).toBe(GATE_CASE_EVENTS.length);
    const seqs = view.docket.map((d) => d.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});

describe('escalated case view', () => {
  const view = buildCaseView(ESCALATED_CASE_EVENTS);

  it('shows a clear human-review state and no stamp', () => {
    expect(view.status).toBe('human-review');
    expect(view.stamp).toBeNull();
    expect(view.headline).toMatch(/human review/i);
    expect(view.humanReview?.reason).toBe('no-admissible-witness-above-floor');
    expect(view.humanReview?.nextSteps.length).toBeGreaterThan(0);
  });

  it('does not describe the case as safe or closed', () => {
    const text = strings(view).join(' ').toLowerCase();
    expect(text).not.toMatch(/\bis safe\b|no vulnerabilit|all clear|dismissed/);
  });
});

describe('stamp honesty', () => {
  it('withholds the stamp when the verdict claims a fix but the Judge never accepted one', () => {
    const forged = GATE_CASE_EVENTS.filter((e) => e.type !== 'patch-verified');
    expect(buildCaseView(forged).stamp).toBeNull();
  });

  it('withholds the stamp when the verdict cites an exhibit the events never produced', () => {
    const forged = GATE_CASE_EVENTS.map((e) =>
      e.type === 'verdict-written'
        ? {
            ...e,
            payload: {
              ...e.payload,
              verdict: { ...(e.payload.verdict as object), exhibits: ['ex_w1', 'ex_ghost'] },
            },
          }
        : e,
    );
    expect(buildCaseView(forged).stamp).toBeNull();
  });

  it('is in progress, with no stamp, before a verdict exists', () => {
    const partial = GATE_CASE_EVENTS.slice(0, 3);
    const view = buildCaseView(partial);
    expect(view.status).toBe('in-progress');
    expect(view.stamp).toBeNull();
  });

  it('does not trust a proven-unfixed verdict with a stamp', () => {
    const unfixed = GATE_CASE_EVENTS.map((e) =>
      e.type === 'verdict-written'
        ? {
            ...e,
            payload: {
              outcome: 'proven-unfixed',
              verdict: { ...(e.payload.verdict as object), outcome: 'proven-unfixed' },
            },
          }
        : e,
    );
    const view = buildCaseView(unfixed);
    expect(view.stamp).toBeNull();
    expect(view.status).toBe('unfixed');
  });
});

describe('event handling', () => {
  it('ignores duplicate sequence numbers and sorts by seq', () => {
    const shuffled: TrialEvent[] = [...GATE_CASE_EVENTS].reverse();
    shuffled.push(GATE_CASE_EVENTS[0] as TrialEvent);
    const view = buildCaseView(shuffled);
    expect(view.docket.map((d) => d.seq)).toEqual(GATE_CASE_EVENTS.map((e) => e.seq));
  });

  it('writes no em dashes anywhere in the rendered copy', () => {
    for (const events of [GATE_CASE_EVENTS, ESCALATED_CASE_EVENTS, GATE_CASE_EVENTS.slice(0, 2)]) {
      expect(strings(buildCaseView(events)).join('\n')).not.toContain(EM_DASH);
    }
  });
});

describe('fake event source', () => {
  async function collect(it: AsyncIterable<TrialEvent>): Promise<TrialEvent[]> {
    const out: TrialEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
  }

  it('streams every event in order', async () => {
    const source = createFakeEventSource(GATE_CASE_EVENTS);
    expect((await collect(source.subscribe())).map((e) => e.seq)).toEqual(
      GATE_CASE_EVENTS.map((e) => e.seq),
    );
  });

  it('resumes after the last seq seen, with no gap and no repeat', async () => {
    const source = createFakeEventSource(GATE_CASE_EVENTS);
    const resumed = await collect(source.subscribe(3));
    expect(resumed.map((e) => e.seq)).toEqual(
      GATE_CASE_EVENTS.filter((e) => e.seq > 3).map((e) => e.seq),
    );
  });
});
