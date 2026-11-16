import {
  Exhibit,
  ExhibitResult,
  STAGE_TRANSITIONS,
  isLegalTransition,
  samples,
  type CaseStage,
} from '@affidavit/contracts';
import { describe, expect, it } from 'vitest';
import { PgCaseStore } from './case-store.js';
import { provisionTenant } from './migrate.js';
import { enqueueStage } from './queue.js';
import { claimStageRun } from './stage-runs.js';
import { BUDGET, describePg, sampleCase, useTestDatabase } from './test-support.js';

const T = 'tenant-g';

describePg('database guards behind the store', () => {
  const db = useTestDatabase([T]);

  async function openCase(opts: { score?: number; floor?: number } = {}) {
    const store = new PgCaseStore(db().app, T);
    const file = sampleCase(T, opts);
    await store.open(file, BUDGET);
    return { store, file };
  }

  /** Runs one statement as the application role with the tenant set, in a rolled-back tx. */
  async function asApp(text: string, params: unknown[] = []): Promise<string> {
    const c = await db().app.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [T]);
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

  it('tenants are provisioned by the owner; the application role cannot create one', async () => {
    expect(await asApp(`insert into tenants (tenant_id) values ('tenant-new')`)).toMatch(
      /permission denied for table tenants/,
    );
    const store = new PgCaseStore(db().app, 'tenant-unprovisioned');
    await expect(store.open(sampleCase('tenant-unprovisioned'), BUDGET)).rejects.toThrow(
      /unknown tenant/,
    );
    await provisionTenant(db().ownerUrl, 'tenant-unprovisioned');
    await expect(store.open(sampleCase('tenant-unprovisioned'), BUDGET)).resolves.toBeUndefined();
  });

  describe('cases', () => {
    it('case file, score, floor and identity are not updatable by the application role', async () => {
      const { file } = await openCase();
      for (const col of [
        'case_file',
        'candidate_score',
        'escalation_floor',
        'repo_id',
        'tenant_id',
        'id',
      ]) {
        const set =
          col === 'case_file'
            ? `case_file = '{}'`
            : col.endsWith('_score') || col.endsWith('floor')
              ? `${col} = 0`
              : `${col} = 'x'`;
        expect(await asApp(`update cases set ${set} where id = $1`, [file.id]), col).toMatch(
          /permission denied/,
        );
      }
    });

    it('the trigger also holds for the owner: immutable columns, counters and budget', async () => {
      const { file } = await openCase();
      const admin = (q: string) => db().admin.query(q, [file.id]);
      await expect(admin(`update cases set case_file = '{}' where id = $1`)).rejects.toThrow(
        /immutable/,
      );
      await expect(admin(`update cases set candidate_score = 0 where id = $1`)).rejects.toThrow(
        /immutable/,
      );
      await expect(admin(`update cases set seq = seq - 1 where id = $1`)).rejects.toThrow(
        /only increase/,
      );
      await expect(
        admin(`update cases set remaining_usd = remaining_usd + 1 where id = $1`),
      ).rejects.toThrow(/only decreases/);
      await expect(admin(`update cases set appeals = appeals + 1 where id = $1`)).rejects.toThrow(
        /appeal/,
      );
    });

    it('the application role cannot skip a stage or break F3 with raw SQL', async () => {
      const { file } = await openCase();
      expect(await asApp(`update cases set stage = 'verdict' where id = $1`, [file.id])).toMatch(
        /illegal stage transition/,
      );
    });

    it('F3 holds in SQL: defense to dismissed at or above the floor is rejected', async () => {
      const { store, file } = await openCase({ score: 0.9, floor: 0.7 });
      for (const s of ['map', 'arraign', 'defense'] as const) await store.transition(file.id, s);
      expect(await asApp(`update cases set stage = 'dismissed' where id = $1`, [file.id])).toMatch(
        /escalation floor/,
      );
    });

    it('the SQL transition table is exactly STAGE_TRANSITIONS', async () => {
      const { file } = await openCase({ score: 0.1, floor: 0.7 });
      const c = await db().admin.connect();
      try {
        await c.query('begin');
        const stages = Object.keys(STAGE_TRANSITIONS) as CaseStage[];
        for (const from of stages) {
          for (const to of stages) {
            if (from === to) continue;
            await c.query('savepoint s');
            // Put the row at `from` with the guard off, then switch it on and try the move.
            await c.query(`alter table cases disable trigger cases_guard`);
            await c.query(`update cases set stage = $2, appeals = 0 where id = $1`, [
              file.id,
              from,
            ]);
            await c.query(`alter table cases enable trigger cases_guard`);
            const appeals = from === 'verify' && to === 'remedy' ? 1 : 0;
            let ok = true;
            try {
              await c.query(`update cases set stage = $2, appeals = $3 where id = $1`, [
                file.id,
                to,
                appeals,
              ]);
            } catch {
              ok = false;
            }
            expect(ok, `${from} -> ${to}`).toBe(isLegalTransition(from, to));
            await c.query('rollback to savepoint s');
          }
        }
      } finally {
        await c.query('rollback');
        c.release();
      }
    });
  });

  describe('inserts cannot start in a forged state', () => {
    const insertCase = (over: Record<string, string>, id: string, repo: string) => {
      const v = {
        stage: `'intake'`,
        appeals: '0',
        seq: '0',
        exhausted: 'false',
        input: '1',
        usd: '1',
        score: '0.5',
        ...over,
      };
      return {
        text: `insert into cases (tenant_id, id, repo_id, case_file, candidate_score, escalation_floor,
          remaining_input_tokens, remaining_output_tokens, remaining_usd, stage, appeals, seq, exhausted)
          values ($1, $2, $3, $4::jsonb, ${v.score}, 0.1, ${v.input}, 1, ${v.usd}, ${v.stage}, ${v.appeals}, ${v.seq}, ${v.exhausted})`,
        // A case file that agrees with the columns, so only the guard under test can object.
        params: [
          T,
          id,
          repo,
          JSON.stringify({
            id,
            tenantId: T,
            candidate: { score: Number(v.score) },
            escalationFloor: 0.1,
          }),
        ],
      };
    };

    it('a case must start at intake with no appeals, seq 0, not exhausted, a sane budget and score', async () => {
      const { file } = await openCase();
      const forged: Record<string, string>[] = [
        { stage: `'dismissed'`, score: '0.99', appeals: '7', seq: '-5' },
        { stage: `'verdict'` },
        { appeals: '7' },
        { seq: '-5' },
        { exhausted: 'true' },
        { input: '-1' },
        { usd: '-1' },
        { score: '1.5' },
      ];
      for (const [i, over] of forged.entries()) {
        const q = insertCase(over, `forged-${i}`, file.target.repo);
        expect(await asApp(q.text, q.params), JSON.stringify(over)).toMatch(
          /inserted at intake|non-negative budget|between 0 and 1/,
        );
      }
      const ok = insertCase({}, 'not-forged', file.target.repo);
      expect(await asApp(ok.text, ok.params)).toBe('no error');
    });

    it('an exhibit cannot be inserted with a result already set', async () => {
      const { file } = await openCase();
      const exhibit = Exhibit.parse({ ...(samples.Exhibit as object), caseId: file.id });
      const text = `insert into exhibits (tenant_id, case_id, id, kind, author, sha256, exhibit, result)
        values ($1, $2, 'forged-ex', 'witness', 'defense', 'a', $3, '{"passed": true}')`;
      expect(await asApp(text, [T, file.id, JSON.stringify(exhibit)])).toMatch(/without a result/);
      await expect(db().admin.query(text, [T, file.id, JSON.stringify(exhibit)])).rejects.toThrow(
        /without a result/,
      );
    });

    it('a stage run cannot be inserted finished, and its lease and outcome rules hold', async () => {
      const { file } = await openCase();
      const base = `insert into stage_runs (tenant_id, case_id, stage, attempt, visit, worker_id, lease_expires_at`;
      for (const [cols, vals] of [
        [', completed_at', `, now()`],
        [', failed_at', `, now()`],
        [', error', `, 'x'`],
      ] as const) {
        await expect(
          db().admin.query(`${base}${cols}) values ($1, $2, 'map', 1, 1, 'w', now()${vals})`, [
            T,
            file.id,
          ]),
        ).rejects.toThrow(/inserted open/);
      }
      const run = { tenantId: T, caseId: file.id, stage: 'intake' as const, attempt: 2 };
      await enqueueStage(db().app, run);
      await claimStageRun(db().worker, run, 'w', 60);
      const upd = (set: string) =>
        db().admin.query(`update stage_runs set ${set} where case_id = $1 and attempt = 2`, [
          file.id,
        ]);
      await expect(
        upd(`lease_expires_at = lease_expires_at - interval '1 minute'`),
      ).rejects.toThrow(/lease only moves forward/);
      await expect(upd(`worker_id = 'other'`)).rejects.toThrow(/identity/);
      await expect(upd(`completed_at = now(), failed_at = now(), error = 'x'`)).rejects.toThrow(
        /not both/,
      );
      await expect(upd(`error = 'x'`)).rejects.toThrow(/only with failed_at/);
      await upd(`failed_at = now(), error = 'x'`);
      await expect(upd(`completed_at = now()`)).rejects.toThrow(/finished stage run is immutable/);
    });

    it('cost rows reject negative amounts and a zero attempt', async () => {
      const { store, file } = await openCase();
      await store.transition(file.id, 'map');
      for (const [col, val] of [
        ['input_tokens', '-1'],
        ['output_tokens', '-1'],
        ['usd', '-0.5'],
        ['wall_ms', '-1'],
        ['attempt', '0'],
      ] as const) {
        const row = {
          input_tokens: '1',
          output_tokens: '1',
          usd: '1',
          wall_ms: '1',
          attempt: '1',
          [col]: val,
        };
        const text = `insert into cost_rows (tenant_id, case_id, stage, attempt, input_tokens, output_tokens, usd, wall_ms)
          values ($1, $2, 'map', ${row.attempt}, ${row.input_tokens}, ${row.output_tokens}, ${row.usd}, ${row.wall_ms})`;
        expect(await asApp(text, [T, file.id]), col).toMatch(/cost_rows_values_valid/);
      }
    });

    it('the case file must agree with the tenant, id, score and floor columns (F3 cannot be dodged)', async () => {
      const { file } = await openCase();
      const text = `insert into cases (tenant_id, id, repo_id, case_file, candidate_score, escalation_floor,
        remaining_input_tokens, remaining_output_tokens, remaining_usd)
        values ($1, $2, $3, $4::jsonb, $5, $6, 1, 1, 1)`;
      const good = { id: 'cf-ok', tenantId: T, candidate: { score: 0.9 }, escalationFloor: 0.7 };
      const attempt = (id: string, over: object, score = 0.9, floor = 0.7) =>
        asApp(text, [
          T,
          id,
          file.target.repo,
          JSON.stringify({ ...good, id, ...over }),
          score,
          floor,
        ]);
      expect(await attempt('cf-ok', {})).toBe('no error');
      expect(await attempt('cf-1', { tenantId: 'other' })).toMatch(/cases_file_matches/);
      expect(await attempt('cf-2', {}, 0.1)).toMatch(/cases_file_matches/); // score column lowered
      expect(await attempt('cf-3', {}, 0.9, 0.99)).toMatch(/cases_file_matches/); // floor raised
      expect(await attempt('cf-4', { id: 'different' })).toMatch(/cases_file_matches/);
    });

    it('the budget must be a number and seq advances by one', async () => {
      const { store, file } = await openCase();
      await expect(
        db().admin.query(`update cases set remaining_usd = 'NaN' where id = $1`, [file.id]),
      ).rejects.toThrow(/budget|cases_budget_finite/);
      await store.nextSeq(file.id);
      await expect(
        db().admin.query(`update cases set seq = seq + 5 where id = $1`, [file.id]),
      ).rejects.toThrow(/advances by one/);
    });

    it('stage history cannot be forged even by the owner, and changes always leave a row', async () => {
      const { store, file } = await openCase();
      await store.transition(file.id, 'map');
      await expect(
        db().admin.query(
          `insert into stages (tenant_id, case_id, ordinal, stage) values ($1, $2, 3, 'arraign')`,
          [T, file.id],
        ),
      ).rejects.toThrow(/stage history must record/);
      const { rows } = await db().admin.query<{ n: string }>(
        `select count(*)::text as n from stages where case_id = $1`,
        [file.id],
      );
      expect(Number(rows[0]!.n)).toBe(2);
    });

    it('even the owner cannot change a lease token, and JSON blobs must agree with their columns', async () => {
      const { store, file } = await openCase();
      const run = { tenantId: T, caseId: file.id, stage: 'intake' as const, attempt: 1 };
      await enqueueStage(db().app, run);
      await claimStageRun(db().worker, run, 'w', 60);
      await expect(
        db().admin.query(`update stage_runs set lease_token = 'mine' where case_id = $1`, [
          file.id,
        ]),
      ).rejects.toThrow(/identity is immutable/);
      // exhibits.result: a JSON null (which would freeze the write-once column) or an object about
      // another exhibit is rejected; a real result is accepted once.
      const exhibit = Exhibit.parse({ ...(samples.Exhibit as object), caseId: file.id });
      await store.putExhibit(exhibit);
      for (const bad of [`'null'::jsonb`, `'{"exhibitId": "other"}'::jsonb`, `'[]'::jsonb`]) {
        await expect(
          db().admin.query(`update exhibits set result = ${bad} where case_id = $1`, [file.id]),
          bad,
        ).rejects.toThrow(/exhibits_result_valid/);
      }
      // Blobs: the verdict, event and exhibit JSON must say what the columns say.
      await expect(
        db().admin.query(
          `insert into verdicts (tenant_id, case_id, outcome, verdict)
           values ($1, $2, 'proven-fixed', '{"caseId": "x", "outcome": "proven-fixed"}')`,
          [T, file.id],
        ),
      ).rejects.toThrow(/verdicts_blob_matches/);
      await store.nextSeq(file.id);
      await expect(
        db().admin.query(
          `insert into events (tenant_id, case_id, seq, type, event)
           values ($1, $2, 0, 'stage-entered', $3::jsonb)`,
          [T, file.id, JSON.stringify({ type: 'objection', caseId: file.id, seq: 0 })],
        ),
      ).rejects.toThrow(/events_blob_matches/);
      await expect(
        db().admin.query(
          `insert into exhibits (tenant_id, case_id, id, kind, author, sha256, exhibit)
           values ($1, $2, 'ex-2', 'witness', 'defense', 'a', $3::jsonb)`,
          [T, file.id, JSON.stringify({ ...exhibit, kind: 'patch' })],
        ),
      ).rejects.toThrow(/exhibits_blob_matches/);
    });

    it('cost rows reject NaN', async () => {
      const { store, file } = await openCase();
      await store.transition(file.id, 'map');
      await expect(
        db().admin.query(
          `insert into cost_rows (tenant_id, case_id, stage, attempt, input_tokens, output_tokens, usd, wall_ms)
           values ($1, $2, 'map', 1, 1, 1, 'NaN', 1)`,
          [T, file.id],
        ),
      ).rejects.toThrow(/cost_rows_values_valid/);
    });

    it('a JSON blob that lacks a key is rejected (a NULL comparison must not pass the check)', async () => {
      const { store, file } = await openCase();
      await store.nextSeq(file.id);
      await store.nextSeq(file.id);
      await store.putExhibit(Exhibit.parse({ ...(samples.Exhibit as object), caseId: file.id }));
      const rejected = async (text: string, params: unknown[], re: RegExp) => {
        const c = await db().admin.connect();
        try {
          await c.query('begin');
          // The projection triggers would object first; this isolates the CHECK constraints.
          await c.query('alter table ballots disable trigger user');
          await c.query('alter table escalations disable trigger user');
          await expect(c.query(text, params), text).rejects.toThrow(re);
        } finally {
          await c.query('rollback');
          c.release();
        }
      };
      await rejected(
        `insert into events (tenant_id, case_id, seq, type, event) values ($1, $2, 0, 'stage-entered', '{}')`,
        [T, file.id],
        /events_blob_matches/,
      );
      await rejected(
        `insert into verdicts (tenant_id, case_id, outcome, verdict) values ($1, $2, 'proven-fixed', '{}')`,
        [T, file.id],
        /verdicts_blob_matches/,
      );
      await rejected(
        `insert into ballots (tenant_id, case_id, seq, juror_id, question, ballot) values ($1, $2, 0, 'j', 'severity', '{}')`,
        [T, file.id],
        /ballots_blob_matches/,
      );
      await rejected(
        `insert into escalations (tenant_id, case_id, seq, reason, detail, escalation) values ($1, $2, 0, 'split-jury', 'd', '{}')`,
        [T, file.id],
        /escalations_blob_matches/,
      );
      await rejected(
        `insert into exhibits (tenant_id, case_id, id, kind, author, sha256, exhibit) values ($1, $2, 'ex-3', 'witness', 'defense', 'a', '{}')`,
        [T, file.id],
        /exhibits_blob_matches/,
      );
      await rejected(
        `update exhibits set result = '{"passed": true}'::jsonb where case_id = $1`,
        [file.id],
        /exhibits_result_valid/,
      );
      await rejected(
        `insert into cases (tenant_id, id, repo_id, case_file, candidate_score, escalation_floor,
           remaining_input_tokens, remaining_output_tokens, remaining_usd)
         values ($1, 'cf-nokeys', $2, '{"note": "no keys"}'::jsonb, 0.5, 0.1, 1, 1, 1)`,
        [T, file.target.repo],
        /cases_file_matches/,
      );
    });

    it('functions are not executable by PUBLIC, and the app role cannot ALTER ROLE its own settings', async () => {
      const { rows } = await db().admin.query<{ proname: string }>(`
        select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and (p.proacl is null
               or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))`);
      expect(rows).toEqual([]);
      expect(await asApp(`alter role affidavit_app set app.tenant_id = 'tenant-evil'`)).toMatch(
        /permission denied|must have/,
      );
    });

    it('case exhaustion never clears', async () => {
      const { store, file } = await openCase();
      await store.chargeBudget(file.id, {
        stage: 'map',
        inputTokens: 5_000_000,
        outputTokens: 0,
        usd: 0,
        wallMs: 0,
        attempt: 1,
      });
      await expect(
        db().admin.query(`update cases set exhausted = false where id = $1`, [file.id]),
      ).rejects.toThrow(/exhaustion never clears/);
    });
  });

  describe('stage history', () => {
    it('cannot be forged: wrong stage, wrong ordinal, or a repeat', async () => {
      const { file } = await openCase();
      for (const [stage, ordinal] of [
        ['map', 2],
        ['intake', 2],
        ['intake', 1],
        ['intake', 5],
      ] as const) {
        expect(
          await asApp(
            `insert into stages (tenant_id, case_id, ordinal, stage) values ($1, $2, $3, $4)`,
            [T, file.id, ordinal, stage],
          ),
          `${stage} ${ordinal}`,
        ).toMatch(/permission denied/);
      }
    });
  });

  describe('exhibit result is write-once', () => {
    it('second result, and any change to the exhibit, are rejected by the store, the app role and the owner', async () => {
      const { store, file } = await openCase();
      const exhibit = Exhibit.parse({ ...(samples.Exhibit as object), caseId: file.id });
      await store.putExhibit(exhibit);
      const first = ExhibitResult.parse({
        ...(samples.ExhibitResult as object),
        exhibitId: exhibit.id,
      });
      await store.recordExhibitResult(file.id, first);
      const second = ExhibitResult.parse({ ...first, passed: false, durationMs: 1 });
      await expect(store.recordExhibitResult(file.id, second)).rejects.toThrow(/already recorded/);
      // Even after a verdict exists.
      await store.appendVerdict({ ...(samples.Verdict as object), caseId: file.id } as never);
      await expect(store.recordExhibitResult(file.id, second)).rejects.toThrow(/already recorded/);
      // Raw SQL, bypassing the `where result is null` in the store.
      expect(
        await asApp(`update exhibits set result = '{}' where case_id = $1`, [file.id]),
      ).toMatch(/write-once/);
      await expect(
        db().admin.query(`update exhibits set result = '{}' where case_id = $1`, [file.id]),
      ).rejects.toThrow(/write-once/);
      expect(
        await asApp(`update exhibits set exhibit = '{}' where case_id = $1`, [file.id]),
      ).toMatch(/permission denied/);
      await expect(
        db().admin.query(`update exhibits set exhibit = '{}' where case_id = $1`, [file.id]),
      ).rejects.toThrow(/immutable|write-once/);
      expect((await store.getExhibits(file.id))[0]!.result).toEqual(first);
    });

    it('exhibits and stage runs can never be deleted', async () => {
      const { store, file } = await openCase();
      await store.putExhibit(Exhibit.parse({ ...(samples.Exhibit as object), caseId: file.id }));
      const run = { tenantId: T, caseId: file.id, stage: 'intake' as const, attempt: 1 };
      await enqueueStage(db().app, run);
      await claimStageRun(db().worker, run, 'w', 60);
      await expect(db().admin.query(`delete from exhibits`)).rejects.toThrow(/never deleted/);
      await expect(db().admin.query(`truncate exhibits`)).rejects.toThrow(/never deleted/);
      await expect(db().admin.query(`delete from stage_runs`)).rejects.toThrow(/never deleted/);
    });
  });

  it('ballots, stages, cost rows and escalations are append-only for the owner too', async () => {
    const { store, file } = await openCase();
    await store.transition(file.id, 'map');
    await store.chargeBudget(file.id, {
      stage: 'map',
      inputTokens: 1,
      outputTokens: 1,
      usd: 0.1,
      wallMs: 1,
      attempt: 1,
    });
    for (const t of ['stages', 'cost_rows']) {
      await expect(db().admin.query(`update ${t} set tenant_id = tenant_id`)).rejects.toThrow(
        /append-only/,
      );
      await expect(db().admin.query(`delete from ${t}`)).rejects.toThrow(/append-only/);
      await expect(db().admin.query(`truncate ${t}`)).rejects.toThrow(/append-only/);
    }
    for (const t of ['ballots', 'escalations']) {
      await expect(db().admin.query(`truncate ${t}`)).rejects.toThrow(/append-only/);
    }
  });
});
