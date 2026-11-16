import { Exhibit, Verdict, samples, TrialEvent, type CaseFile } from '@affidavit/contracts';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { beforeAll, expect, it } from 'vitest';
import { PgCaseStore } from './case-store.js';
import { PgEventSink } from './event-sink.js';
import { claimStageRun } from './stage-runs.js';
import { withTenant } from './tenant.js';
import { BUDGET, describePg, sampleCase, useTestDatabase } from './test-support.js';

const A = 'tenant-a';
const B = 'tenant-b';

const TABLES = [
  'tenants',
  'repos',
  'cases',
  'stages',
  'stage_runs',
  'exhibits',
  'ballots',
  'verdicts',
  'cost_rows',
  'escalations',
  'events',
] as const;

async function seed(pool: pg.Pool, tenant: string, caseFile: CaseFile): Promise<void> {
  const store = new PgCaseStore(pool, tenant);
  const sink = new PgEventSink(pool, tenant);
  await store.open(caseFile, BUDGET);
  await store.transition(caseFile.id, 'map');
  await store.chargeBudget(caseFile.id, {
    stage: 'map',
    inputTokens: 1,
    outputTokens: 1,
    usd: 0.01,
    wallMs: 1,
    attempt: 1,
  });
  await store.appendVerdict(Verdict.parse({ ...(samples.Verdict as object), caseId: caseFile.id }));
  await store.putExhibit(Exhibit.parse({ ...(samples.Exhibit as object), caseId: caseFile.id }));
  await claimStageRun(pool, { tenantId: tenant, caseId: caseFile.id, stage: 'map', attempt: 1 });
  const base = {
    schemaVersion: 1,
    caseId: caseFile.id,
    at: '2026-11-05T12:00:00.000Z',
  };
  await sink.emit(
    TrialEvent.parse({
      ...base,
      seq: 0,
      stage: 'jury',
      actor: 'juror',
      type: 'ballot-cast',
      payload: { ballot: samples.Ballot },
    }),
  );
  await sink.emit(
    TrialEvent.parse({
      ...base,
      seq: 1,
      stage: 'defense',
      actor: 'judge',
      type: 'escalated',
      payload: { escalation: { ...(samples.Escalation as object), caseId: caseFile.id } },
    }),
  );
}

describePg('cross-tenant isolation (tenant A against tenant B data)', () => {
  const db = useTestDatabase([A, B]);
  const caseA = sampleCase(A);
  const caseB = sampleCase(B);
  let storeA: PgCaseStore;
  let storeB: PgCaseStore;
  let sinkB: PgEventSink;

  /**
   * Runs statements as the application role with tenant A set, in a transaction that is always
   * rolled back. Grants are widened and user triggers disabled inside it, so what is tested is
   * the row-level security policy itself and not a missing grant or an earlier trigger.
   */
  async function asAWithPolicyOnly(text: string, params: unknown[]): Promise<string> {
    const c = await db().admin.connect();
    try {
      await c.query('begin');
      for (const t of TABLES) {
        await c.query(`alter table public.${t} disable trigger user`);
        await c.query(`grant select, insert, update on public.${t} to affidavit_app`);
      }
      await c.query('set local role affidavit_app');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [A]);
      try {
        await c.query(text, params);
        return 'no error';
      } catch (err) {
        return (err as Error).message;
      }
    } finally {
      await c.query('rollback');
      c.release();
    }
  }

  beforeAll(async () => {
    storeA = new PgCaseStore(db().app, A);
    storeB = new PgCaseStore(db().app, B);
    sinkB = new PgEventSink(db().app, B);
    await seed(db().app, A, caseA);
    await seed(db().app, B, caseB);
  }, 60_000);

  it('seeded tenant A and tenant B data in every table', async () => {
    for (const t of TABLES) {
      for (const tenant of [A, B]) {
        const { rows } = await db().admin.query<{ n: string }>(
          `select count(*)::text as n from ${t} where tenant_id = $1`,
          [tenant],
        );
        expect(Number(rows[0]!.n), `${t} ${tenant}`).toBeGreaterThan(0);
      }
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
    await expect(
      storeA.putExhibit(Exhibit.parse({ ...(samples.Exhibit as object), caseId: caseB.id })),
    ).rejects.toThrow(/unknown case/);
    expect(await storeA.getExhibits(caseB.id)).toEqual([]);
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
    await expect(sinkA.emit(ev)).rejects.toThrow(/unknown case/);
    expect(await sinkA.events(caseB.id)).toEqual([]);
    expect((await sinkB.events(caseB.id)).length).toBe(2);
  });

  for (const table of TABLES) {
    it(`raw select on ${table} as tenant A returns no tenant B row`, async () => {
      const rows = await withTenant(db().app, A, async (tx) => {
        const r = await tx.execute(sql.raw(`select tenant_id from ${table}`));
        return r.rows as { tenant_id: string }[];
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.tenant_id === A)).toBe(true);
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
        `select * from stage_runs where tenant_id = '${B}'`,
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

  // WITH CHECK: asserted on the policy itself (see asAWithPolicyOnly), table by table.
  const insertB: Record<(typeof TABLES)[number], { text: string; params: () => unknown[] }> = {
    tenants: { text: `insert into tenants (tenant_id) values ($1)`, params: () => [B] },
    repos: { text: `insert into repos (tenant_id, id) values ($1, 'r-x')`, params: () => [B] },
    cases: {
      text: `insert into cases (tenant_id, id, repo_id, case_file, candidate_score, escalation_floor,
        remaining_input_tokens, remaining_output_tokens, remaining_usd)
        values ($1, 'forged', $2, '{}', 0.5, 0.5, 1, 1, 1)`,
      params: () => [B, caseB.target.repo],
    },
    stages: {
      text: `insert into stages (tenant_id, case_id, ordinal, stage) values ($1, $2, 99, 'map')`,
      params: () => [B, caseB.id],
    },
    stage_runs: {
      text: `insert into stage_runs (tenant_id, case_id, stage, attempt) values ($1, $2, 'map', 9)`,
      params: () => [B, caseB.id],
    },
    exhibits: {
      text: `insert into exhibits (tenant_id, case_id, id, kind, author, sha256, exhibit)
        values ($1, $2, 'x', 'witness', 'defense', 'a', '{}')`,
      params: () => [B, caseB.id],
    },
    ballots: {
      text: `insert into ballots (tenant_id, case_id, seq, juror_id, question, ballot)
        values ($1, $2, 99, 'j', 'severity', '{}')`,
      params: () => [B, caseB.id],
    },
    verdicts: {
      text: `insert into verdicts (tenant_id, case_id, outcome, verdict) values ($1, $2, 'dismissed', '{}')`,
      params: () => [B, caseB.id],
    },
    cost_rows: {
      text: `insert into cost_rows (tenant_id, case_id, stage, attempt, input_tokens, output_tokens, usd, wall_ms)
        values ($1, $2, 'map', 1, 1, 1, 1, 1)`,
      params: () => [B, caseB.id],
    },
    escalations: {
      text: `insert into escalations (tenant_id, case_id, seq, reason, detail, escalation)
        values ($1, $2, 99, 'split-jury', 'd', '{}')`,
      params: () => [B, caseB.id],
    },
    events: {
      text: `insert into events (tenant_id, case_id, seq, type, event) values ($1, $2, 99, 'stage-entered', '{}')`,
      params: () => [B, caseB.id],
    },
  };

  for (const table of TABLES) {
    it(`WITH CHECK: inserting a row tagged tenant B into ${table} fails on row-level security`, async () => {
      const msg = await asAWithPolicyOnly(insertB[table].text, insertB[table].params());
      expect(msg).toMatch(/violates row-level security policy/);
    });

    it(`WITH CHECK: moving a tenant A row in ${table} to tenant B fails on row-level security`, async () => {
      const msg = await asAWithPolicyOnly(`update ${table} set tenant_id = $1`, [B]);
      expect(msg).toMatch(/violates row-level security policy/);
    });
  }

  it('the harness itself lets a tenant A insert through (so the tests above can fail)', async () => {
    const msg = await asAWithPolicyOnly(`insert into repos (tenant_id, id) values ($1, 'r-ok')`, [
      A,
    ]);
    expect(msg).toBe('no error');
  });

  it('A cannot update or delete B rows', async () => {
    const touched = await withTenant(db().app, A, async (tx) => {
      const r = await tx.execute(
        sql.raw(`update cases set stage = 'escalated' where id = '${caseB.id}'`),
      );
      return r.rowCount;
    });
    expect(touched).toBe(0);
    // Drizzle wraps driver errors; the Postgres message is on `cause`.
    const err = await withTenant(db().app, A, (tx) =>
      tx.execute(sql.raw(`delete from cases where id = '${caseB.id}'`)),
    ).catch((e: Error) => (e.cause as Error | undefined)?.message ?? e.message);
    expect(err).toMatch(/permission denied/);
    expect(await storeB.stage(caseB.id)).toBe('map');
  });
});
