import { Exhibit, Verdict, samples, TrialEvent } from '@affidavit/contracts';
import { sql } from 'drizzle-orm';
import { beforeAll, expect, it } from 'vitest';
import { PgCaseStore } from './case-store.js';
import { PgEventSink } from './event-sink.js';
import { withTenant } from './tenant.js';
import { BUDGET, describePg, sampleCase, useTestDatabase } from './test-support.js';

const A = 'tenant-a';
const B = 'tenant-b';

const TABLES = [
  'tenants',
  'repos',
  'cases',
  'stages',
  'exhibits',
  'ballots',
  'verdicts',
  'cost_rows',
  'escalations',
  'events',
] as const;

describePg('cross-tenant isolation (tenant A against tenant B data)', () => {
  const db = useTestDatabase();
  const caseB = sampleCase(B);
  let storeA: PgCaseStore;
  let storeB: PgCaseStore;
  let sinkB: PgEventSink;

  beforeAll(async () => {
    storeA = new PgCaseStore(db().app, A);
    storeB = new PgCaseStore(db().app, B);
    sinkB = new PgEventSink(db().app, B);
    await storeA.open(sampleCase(A), BUDGET);
    await storeB.open(caseB, BUDGET);
    await storeB.transition(caseB.id, 'map');
    await storeB.chargeBudget(caseB.id, {
      stage: 'map',
      inputTokens: 1,
      outputTokens: 1,
      usd: 0.01,
      wallMs: 1,
      attempt: 1,
    });
    await storeB.appendVerdict(Verdict.parse({ ...(samples.Verdict as object), caseId: caseB.id }));
    await storeB.putExhibit(Exhibit.parse({ ...(samples.Exhibit as object), caseId: caseB.id }));
    const ballot = samples.Ballot;
    await sinkB.emit(
      TrialEvent.parse({
        schemaVersion: 1,
        caseId: caseB.id,
        seq: 0,
        stage: 'jury',
        at: '2026-11-05T12:00:00.000Z',
        actor: 'juror',
        type: 'ballot-cast',
        payload: { ballot },
      }),
    );
    await sinkB.emit(
      TrialEvent.parse({
        schemaVersion: 1,
        caseId: caseB.id,
        seq: 1,
        stage: 'defense',
        at: '2026-11-05T12:00:00.000Z',
        actor: 'judge',
        type: 'escalated',
        payload: { escalation: { ...(samples.Escalation as object), caseId: caseB.id } },
      }),
    );
  }, 60_000);

  it('seeded tenant B data in every table', async () => {
    for (const t of TABLES) {
      const { rows } = await db().admin.query<{ n: string }>(
        `select count(*)::text as n from ${t} where tenant_id = $1`,
        [B],
      );
      expect(Number(rows[0]!.n), t).toBeGreaterThan(0);
    }
  });

  it('store methods cannot see, change, or write B case', async () => {
    await expect(storeA.stage(caseB.id)).rejects.toThrow(/unknown case/);
    await expect(storeA.transition(caseB.id, 'arraign')).rejects.toThrow(/unknown case/);
    await expect(storeA.getVerdict(caseB.id)).rejects.toThrow(/unknown case/);
    await expect(storeA.nextSeq(caseB.id)).rejects.toThrow(/unknown case/);
    await expect(
      storeA.chargeBudget(caseB.id, {
        stage: 'map',
        inputTokens: 1,
        outputTokens: 1,
        usd: 1,
        wallMs: 1,
        attempt: 1,
      }),
    ).rejects.toThrow(/unknown case/);
    await expect(
      storeA.appendVerdict(Verdict.parse({ ...(samples.Verdict as object), caseId: caseB.id })),
    ).rejects.toThrow(/unknown case/);
    expect(await storeB.stage(caseB.id)).toBe('map');
  });

  it('event sink cannot emit into or read B case', async () => {
    const sinkA = new PgEventSink(db().app, A);
    const ev = TrialEvent.parse({
      schemaVersion: 1,
      caseId: caseB.id,
      seq: 99,
      stage: 'map',
      at: '2026-11-05T12:00:00.000Z',
      actor: 'judge',
      type: 'stage-entered',
      payload: {},
    });
    await expect(sinkA.emit(ev)).rejects.toThrow();
    expect(await sinkA.events(caseB.id)).toEqual([]);
    expect((await sinkB.events(caseB.id)).length).toBe(2);
  });

  for (const table of TABLES) {
    it(`raw select on ${table} as tenant A returns no tenant B row`, async () => {
      const rows = await withTenant(db().app, A, async (tx) => {
        const r = await tx.execute(sql.raw(`select tenant_id from ${table}`));
        return r.rows as { tenant_id: string }[];
      });
      expect(rows.every((r) => r.tenant_id === A)).toBe(true);
      expect(rows.some((r) => r.tenant_id === B)).toBe(false);
    });

    it(`select on ${table} with no tenant set returns no rows`, async () => {
      const { rows } = await db().app.query(`select * from ${table}`);
      expect(rows).toHaveLength(0);
    });

    it(`select on ${table} with an empty tenant returns no rows`, async () => {
      const client = await db().app.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.tenant_id', '', true)`);
        const { rows } = await client.query(`select * from ${table}`);
        await client.query('rollback');
        expect(rows).toHaveLength(0);
      } finally {
        client.release();
      }
    });
  }

  it('joins and subqueries as tenant A cannot reach B rows', async () => {
    const client = await db().app.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [A]);
      const queries = [
        `select c.id from cases c join verdicts v on v.case_id = c.id`,
        `select c.id from cases c join events e on e.case_id = c.id and e.tenant_id = c.tenant_id`,
        `select c.id from cases c left join cost_rows r on r.case_id = c.id where c.id = '${caseB.id}'`,
        `select case_id from verdicts union all select case_id from events union all select id from cases`,
        `select id from cases where id in (select case_id from escalations)`,
        `select * from cases where tenant_id <> current_setting('app.tenant_id')`,
        `select * from cases where tenant_id = '${B}'`,
      ];
      for (const q of queries) {
        const { rows } = await client.query<Record<string, unknown>>(q);
        expect(
          rows.some((r) => Object.values(r).includes(caseB.id)),
          q,
        ).toBe(false);
      }
      await client.query('rollback');
    } finally {
      client.release();
    }
  });

  it('A cannot insert a row for B, or move its own row to B', async () => {
    const client = await db().app.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [A]);
      await expect(
        client.query(`insert into tenants (tenant_id) values ($1)`, [B]),
      ).rejects.toThrow(/row-level security/);
      await client.query('rollback');
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [A]);
      await expect(client.query(`update cases set tenant_id = $1`, [B])).rejects.toThrow(
        /row-level security|foreign key/,
      );
      await client.query('rollback');
    } finally {
      client.release();
    }
  });

  it('A cannot update or delete B rows (zero rows touched or denied)', async () => {
    const touched = await withTenant(db().app, A, async (tx) => {
      const r = await tx.execute(
        sql.raw(`update cases set stage = 'escalated' where id = '${caseB.id}'`),
      );
      return r.rowCount;
    });
    expect(touched).toBe(0);
    await expect(
      withTenant(db().app, A, (tx) =>
        tx.execute(sql.raw(`delete from cases where id = '${caseB.id}'`)),
      ),
    ).rejects.toThrow();
    expect(await storeB.stage(caseB.id)).toBe('map');
  });
});
