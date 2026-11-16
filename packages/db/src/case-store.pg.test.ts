import {
  Exhibit,
  ExhibitResult,
  IllegalTransitionError,
  Verdict,
  VerdictAlreadyWrittenError,
  samples,
  type CaseStage,
} from '@affidavit/contracts';
import { describe, expect, it } from 'vitest';
import { PgCaseStore } from './case-store.js';
import { transitionCases } from './transition-cases.js';
import { BUDGET, describePg, sampleCase, uniqueId, useTestDatabase } from './test-support.js';

const TENANT = 'tenant-a';

describePg('PgCaseStore', () => {
  const db = useTestDatabase();

  function store(juryEnabled = true): PgCaseStore {
    return new PgCaseStore(db().app, TENANT, { juryEnabled });
  }

  async function walk(s: PgCaseStore, caseId: string, path: readonly CaseStage[]): Promise<void> {
    for (const to of path) await s.transition(caseId as never, to);
  }

  describe('illegal stage transitions are rejected by the store', () => {
    for (const tc of transitionCases) {
      it(tc.name, async () => {
        const s = store(tc.juryEnabled ?? true);
        const file = sampleCase(TENANT, { score: tc.score, floor: tc.floor });
        await s.open(file, BUDGET);
        await walk(s, file.id, tc.path);
        const before = await s.stage(file.id);
        if (tc.ok) {
          await s.transition(file.id, tc.to);
          expect(await s.stage(file.id)).toBe(tc.to);
        } else {
          await expect(s.transition(file.id, tc.to)).rejects.toBeInstanceOf(IllegalTransitionError);
          expect(await s.stage(file.id)).toBe(before);
        }
      });
    }
  });

  it('opens at intake and rejects a second open of the same case', async () => {
    const s = store();
    const file = sampleCase(TENANT);
    await s.open(file, BUDGET);
    expect(await s.stage(file.id)).toBe('intake');
    await expect(s.open(file, BUDGET)).rejects.toThrow(/already open/);
  });

  it('refuses a case file that names another tenant', async () => {
    await expect(store().open(sampleCase('tenant-b'), BUDGET)).rejects.toThrow(/tenant/);
  });

  it('throws on an unknown case', async () => {
    const s = store();
    await expect(s.stage('nope' as never)).rejects.toThrow(/unknown case/);
    await expect(s.transition('nope' as never, 'map')).rejects.toThrow(/unknown case/);
    await expect(s.getVerdict('nope' as never)).rejects.toThrow(/unknown case/);
    await expect(s.nextSeq('nope' as never)).rejects.toThrow(/unknown case/);
  });

  it('lets exactly one of two concurrent identical transitions win', async () => {
    const s = store();
    const file = sampleCase(TENANT);
    await s.open(file, BUDGET);
    await s.transition(file.id, 'map');
    const results = await Promise.allSettled([
      s.transition(file.id, 'arraign'),
      s.transition(file.id, 'arraign'),
      s.transition(file.id, 'arraign'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(IllegalTransitionError);
    }
    expect(await s.stage(file.id)).toBe('arraign');
  });

  it('charges budget atomically and reports exhaustion without throwing', async () => {
    const s = store();
    const file = sampleCase(TENANT);
    await s.open(file, { maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: 1 });
    const cost = {
      stage: 'defense' as const,
      inputTokens: 100,
      outputTokens: 50,
      usd: 0.1,
      wallMs: 5,
      attempt: 1,
    };
    const after = await Promise.all(Array.from({ length: 5 }, () => s.chargeBudget(file.id, cost)));
    const last = after.map((b) => b.remainingInputTokens).sort((a, b) => a - b)[0];
    expect(last).toBe(500);
    const final = await s.chargeBudget(file.id, { ...cost, inputTokens: 600, usd: 0.5 });
    expect(final.remainingInputTokens).toBe(-100);
    expect(final.remainingUsd).toBeCloseTo(0, 6);
    expect(final.exhausted).toBe(true);
    const fresh = sampleCase(TENANT);
    await s.open(fresh, BUDGET);
    const one = await s.chargeBudget(fresh.id, cost);
    expect(one.exhausted).toBe(false);
    expect(one.remainingUsd).toBeCloseTo(4.9, 6);
  });

  it('assigns a monotonic seq per case with no duplicates under concurrency', async () => {
    const s = store();
    const file = sampleCase(TENANT);
    await s.open(file, BUDGET);
    const seqs = await Promise.all(Array.from({ length: 10 }, () => s.nextSeq(file.id)));
    expect([...seqs].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('round-trips a verdict and refuses a second one', async () => {
    const s = store();
    const file = sampleCase(TENANT);
    await s.open(file, BUDGET);
    expect(await s.getVerdict(file.id)).toBeNull();
    const verdict = Verdict.parse({ ...(samples.Verdict as object), caseId: file.id });
    await s.appendVerdict(verdict);
    expect(await s.getVerdict(file.id)).toEqual(verdict);
    await expect(s.appendVerdict(verdict)).rejects.toBeInstanceOf(VerdictAlreadyWrittenError);
  });

  it('stores an exhibit once and attaches its result', async () => {
    const s = store();
    const file = sampleCase(TENANT);
    await s.open(file, BUDGET);
    const exhibit = Exhibit.parse({ ...(samples.Exhibit as object), caseId: file.id });
    await s.putExhibit(exhibit);
    await s.putExhibit(exhibit);
    const result = ExhibitResult.parse({
      ...(samples.ExhibitResult as object),
      exhibitId: exhibit.id,
    });
    await s.recordExhibitResult(file.id, result);
    expect(await s.getExhibits(file.id)).toEqual([{ exhibit, result }]);
  });

  it('records a stage history', async () => {
    const s = store();
    const file = sampleCase(TENANT, { id: uniqueId('hist') });
    await s.open(file, BUDGET);
    await s.transition(file.id, 'map');
    const { rows } = await db().admin.query<{ stage: string }>(
      'select stage from stages where case_id = $1 order by ordinal',
      [file.id],
    );
    expect(rows.map((r) => r.stage)).toEqual(['intake', 'map']);
  });
});
