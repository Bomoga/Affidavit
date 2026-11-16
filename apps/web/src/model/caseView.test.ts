import { TrialEvent, type VerifyResult } from '@affidavit/contracts';
import { readFixtureJson } from '@affidavit/testing';
import { describe, expect, it } from 'vitest';
import { buildCaseView } from './caseView.js';
import { createFakeEventSource } from './source.js';

const EM_DASH = '—';

function loadTrial(name: string): TrialEvent[] {
  return TrialEvent.array().parse(readFixtureJson(`trials/${name}.events.json`));
}

const GATE = loadTrial('nodegoat-sqli-001');
const ESCALATED = loadTrial('escalated-001');
const WITNESS_ID = 'exhibit-witness-001';
const PATCH_ID = 'exhibit-patch-001';

function verifyResult(patchExhibitId: string, overrides: Partial<VerifyResult> = {}): VerifyResult {
  return {
    schemaVersion: 1,
    patchExhibitId: patchExhibitId as VerifyResult['patchExhibitId'],
    familyFlipped: true,
    suitePassed: true,
    rescanClean: true,
    counterexamples: [],
    ...overrides,
  };
}

function withVerdictExhibits(events: readonly TrialEvent[], exhibits: string[]): TrialEvent[] {
  return events.map((e) =>
    e.type === 'verdict-written'
      ? {
          ...e,
          payload: {
            verdict: {
              ...e.payload.verdict,
              exhibits: exhibits as (typeof e.payload.verdict.exhibits)[number][],
            },
          },
        }
      : e,
  );
}

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out));
  return out;
}

describe('gate case view from the contracts fixture', () => {
  const view = buildCaseView(GATE);

  it('reads the case id, exhibits and Judge runs from contract shapes', () => {
    expect(view.caseId).toBe('case-nodegoat-sqli-001');
    expect(view.exhibits.map((e) => [e.id, e.kind])).toEqual([
      [WITNESS_ID, 'witness'],
      [PATCH_ID, 'patch'],
    ]);
    const witness = view.exhibits.find((e) => e.id === WITNESS_ID);
    expect(witness?.admitted).toBe(true);
    expect(witness?.runs).toHaveLength(3);
    expect(witness?.runs.every((r) => r.variant === 'vulnerable' && r.passed)).toBe(true);
  });

  it('degrades honestly: no stamp, because the stream carries no patch verification', () => {
    expect(view.status).toBe('unverified');
    expect(view.stamp).toBeNull();
    expect(view.stampWithheld).toContain(
      'The record has no Judge result accepting a patch for this case.',
    );
    expect(view.headline).not.toMatch(/verified:/i);
  });

  it('puts the plain-language summary first', () => {
    expect(view.sections[0]?.id).toBe('summary');
    expect(view.sections[0]?.body).toBe(view.summary);
    const ids = view.sections.map((s) => s.id);
    expect(ids.indexOf('summary')).toBeLessThan(ids.indexOf('exhibits'));
  });

  it('shows a docket entry per event in seq order', () => {
    expect(view.docket.map((d) => d.seq)).toEqual(GATE.map((e) => e.seq));
  });
});

describe('stamp rule', () => {
  it('shows VERIFIED when every cited witness was admitted and the accepted patch is cited', () => {
    const view = buildCaseView(GATE, { verifyResults: [verifyResult(PATCH_ID)] });
    expect(view.stamp).toBe('VERIFIED');
    expect(view.status).toBe('verified');
    expect(view.stampWithheld).toEqual([]);
  });

  it('withholds the stamp when a cited witness was not admitted', () => {
    const rejected = GATE.map((e) =>
      e.type === 'exhibit-result'
        ? {
            ...e,
            payload: {
              result: {
                ...e.payload.result,
                admissible: false,
                rejectedBy: 'differential' as const,
              },
            },
          }
        : e,
    );
    const view = buildCaseView(rejected, { verifyResults: [verifyResult(PATCH_ID)] });
    expect(view.stamp).toBeNull();
    expect(view.stampWithheld.join(' ')).toMatch(/did not admit/);
    expect(view.exhibits.find((x) => x.id === WITNESS_ID)?.rejectedBy).toBe('differential');
  });

  it('withholds the stamp when the verdict does not cite the accepted patch', () => {
    const view = buildCaseView(withVerdictExhibits(GATE, [WITNESS_ID]), {
      verifyResults: [verifyResult(PATCH_ID)],
    });
    expect(view.stamp).toBeNull();
    expect(view.stampWithheld).toContain('The verdict does not cite the patch the Judge accepted.');
  });

  it('withholds the stamp when the Judge result does not accept the patch', () => {
    for (const bad of [
      { familyFlipped: false },
      { suitePassed: false },
      { rescanClean: false },
      { rejectedBy: 'literal-only-patch' as const },
      { counterexamples: [{ exhibitId: 'exhibit-ce-1' as never, survived: true }] },
    ]) {
      expect(
        buildCaseView(GATE, { verifyResults: [verifyResult(PATCH_ID, bad)] }).stamp,
      ).toBeNull();
    }
  });

  it('withholds the stamp when the verdict cites an exhibit the events never produced', () => {
    const view = buildCaseView(withVerdictExhibits(GATE, [WITNESS_ID, PATCH_ID, 'exhibit-ghost']), {
      verifyResults: [verifyResult(PATCH_ID)],
    });
    expect(view.stamp).toBeNull();
  });

  it('ignores a verify result for an exhibit that was never submitted as a patch', () => {
    const view = buildCaseView(GATE, { verifyResults: [verifyResult(WITNESS_ID)] });
    expect(view.stamp).toBeNull();
  });

  it('is in progress, with no stamp, before a verdict exists', () => {
    const view = buildCaseView(GATE.slice(0, 9), { verifyResults: [verifyResult(PATCH_ID)] });
    expect(view.status).toBe('in-progress');
    expect(view.stamp).toBeNull();
  });

  it('never stamps a proven-unfixed verdict', () => {
    const unfixed = GATE.map((e) =>
      e.type === 'verdict-written'
        ? {
            ...e,
            payload: { verdict: { ...e.payload.verdict, outcome: 'proven-unfixed' as const } },
          }
        : e,
    );
    const view = buildCaseView(unfixed, { verifyResults: [verifyResult(PATCH_ID)] });
    expect(view.stamp).toBeNull();
    expect(view.status).toBe('unfixed');
  });
});

describe('escalated case view', () => {
  const view = buildCaseView(ESCALATED);

  it('shows a clear human-review state and no stamp', () => {
    expect(view.status).toBe('human-review');
    expect(view.stamp).toBeNull();
    expect(view.headline).toMatch(/human review/i);
    expect(view.humanReview?.reason).toBe('no-admissible-witness-above-floor');
    expect(view.humanReview?.detail).toBe('second Defense attempt produced no admissible witness');
    expect(view.humanReview?.nextSteps.length).toBeGreaterThan(0);
  });

  it('records which rule rejected each witness', () => {
    expect(view.exhibits.every((x) => !x.admitted && x.rejectedBy !== undefined)).toBe(true);
  });

  it('does not describe the case as safe or closed', () => {
    const text = strings(view).join(' ').toLowerCase();
    expect(text).not.toMatch(/\bis safe\b|no vulnerabilit|all clear|dismissed/);
  });
});

describe('event handling', () => {
  it('ignores duplicate sequence numbers and sorts by seq', () => {
    const shuffled = [...GATE].reverse();
    shuffled.push(GATE[0] as TrialEvent);
    expect(buildCaseView(shuffled).docket.map((d) => d.seq)).toEqual(GATE.map((e) => e.seq));
  });

  it('writes no em dashes anywhere in the rendered copy', () => {
    for (const events of [GATE, ESCALATED, GATE.slice(0, 2)]) {
      expect(strings(buildCaseView(events)).join('\n')).not.toContain(EM_DASH);
      expect(
        strings(buildCaseView(events, { verifyResults: [verifyResult(PATCH_ID)] })).join('\n'),
      ).not.toContain(EM_DASH);
    }
  });
});

describe('fake event source', () => {
  async function collect(it: AsyncIterable<TrialEvent>): Promise<TrialEvent[]> {
    const out: TrialEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
  }

  it('streams from the start by default, including seq 0', async () => {
    expect(GATE[0]?.seq).toBe(0);
    const all = await collect(createFakeEventSource(GATE).subscribe());
    expect(all.map((e) => e.seq)).toEqual(GATE.map((e) => e.seq));
    expect(all[0]?.seq).toBe(0);
  });

  it('resumes after the last seq seen, with no gap and no repeat', async () => {
    const resumed = await collect(createFakeEventSource(GATE).subscribe(3));
    expect(resumed.map((e) => e.seq)).toEqual(GATE.filter((e) => e.seq > 3).map((e) => e.seq));
  });

  it('resuming after seq 0 skips only seq 0', async () => {
    const resumed = await collect(createFakeEventSource(GATE).subscribe(0));
    expect(resumed.map((e) => e.seq)).toEqual(GATE.slice(1).map((e) => e.seq));
  });
});
