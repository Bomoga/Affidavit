import { Verdict, samples } from '@affidavit/contracts';
import { beforeAll, expect, it } from 'vitest';
import { PgCaseStore } from './case-store.js';
import { BUDGET, describePg, sampleCase, useTestDatabase } from './test-support.js';

const T = 'tenant-v';

describePg('verdicts are append-only', () => {
  const db = useTestDatabase();
  const file = sampleCase(T);

  beforeAll(async () => {
    const store = new PgCaseStore(db().app, T);
    await store.open(file, BUDGET);
    await store.appendVerdict(Verdict.parse({ ...(samples.Verdict as object), caseId: file.id }));
  }, 60_000);

  async function asTenant(sqlText: string): Promise<void> {
    const c = await db().app.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [T]);
      await c.query(sqlText);
    } finally {
      await c.query('rollback');
      c.release();
    }
  }

  it('the application role cannot UPDATE a verdict', async () => {
    await expect(asTenant(`update verdicts set outcome = 'dismissed'`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('the application role cannot DELETE a verdict', async () => {
    await expect(asTenant(`delete from verdicts`)).rejects.toThrow(/permission denied/);
  });

  it('the application role cannot TRUNCATE verdicts', async () => {
    await expect(asTenant(`truncate verdicts`)).rejects.toThrow(/permission denied/);
  });

  it('even the owner or superuser is stopped by the trigger', async () => {
    await expect(db().admin.query(`update verdicts set outcome = 'dismissed'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(db().admin.query(`delete from verdicts`)).rejects.toThrow(/append-only/);
    await expect(db().admin.query(`truncate verdicts`)).rejects.toThrow(/append-only/);
  });

  it('the verdict is unchanged afterwards', async () => {
    const { rows } = await db().admin.query<{ outcome: string }>('select outcome from verdicts');
    expect(rows).toEqual([{ outcome: 'proven-fixed' }]);
  });
});
