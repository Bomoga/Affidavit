import { TERMINAL_STAGES, type CaseStage } from '@affidavit/contracts';
import { sql } from 'drizzle-orm';
import { run } from 'graphile-worker';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, it } from 'vitest';
import { PgCaseStore } from './case-store.js';
import { PgEventSink } from './event-sink.js';
import {
  ensureStageJob,
  reconcileOnce,
  recordOnce,
  stageHandler,
  type ReconcileCursors,
  type ReconcileOptions,
} from './orchestration.js';
import {
  enqueueStage,
  listFailedStageJobs,
  stageJobKey,
  stageJobState,
  stageTaskList,
  type StageContext,
  type StageHandler,
  type StagePayload,
} from './queue.js';
import { listOpenCases, stageAttemptState } from './stage-attempts.js';
import { claimStageRun, failStageRun, resumeDecision, stageRunState } from './stage-runs.js';
import { openPool, withTenant, type AppPool, type WorkerPool } from './tenant.js';
import { BUDGET, describePg, sampleCase, useTestDatabase } from './test-support.js';

const A = 'tenant-fa';
const B = 'tenant-fb';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describePg('review follow-ups: leases, recovery scaling, visits and concurrency', () => {
  const db = useTestDatabase([A, B]);
  let storeA: PgCaseStore;
  beforeAll(() => {
    storeA = new PgCaseStore(db().app, A);
  });

  const pay = (caseId: string, stage: CaseStage = 'intake', attempt = 1, tenantId = A) =>
    ({ tenantId, caseId, stage, attempt }) as StagePayload;
  const pools = () => ({ appPool: db().app, workerPool: db().worker });
  const opts = (over: Partial<ReconcileOptions> = {}): ReconcileOptions => ({
    appPool: db().app,
    workerPool: db().worker,
    staleLockSeconds: 3,
    maxStageAttempts: 3,
    cursors: { failedAfterId: null, openAfter: null },
    ...over,
  });
  const mine = (id: string) => (r: Awaited<ReturnType<typeof reconcileOnce>>) =>
    r.filter((a) => a.payload.caseId === id);

  async function newCase(tenant = A, over: { id?: string } = {}) {
    const file = sampleCase(tenant, over);
    await new PgCaseStore(db().app, tenant).open(file, BUDGET);
    return file;
  }

  async function until(cond: () => boolean | Promise<boolean>, ms = 20_000) {
    const deadline = Date.now() + ms;
    while (!(await cond()) && Date.now() < deadline) await wait(100);
  }

  async function count(query: string, params: unknown[] = []): Promise<number> {
    const r = await db().admin.query<{ n: string }>(query, params);
    return Number(r.rows[0]?.n);
  }

  /** Test-only: an open attempt's lease expired `secondsAgo` seconds ago. */
  async function expireLease(p: StagePayload, secondsAgo = 1): Promise<void> {
    const c = await db().admin.connect();
    try {
      await c.query('begin');
      await c.query(`alter table stage_runs disable trigger stage_runs_guard`);
      await c.query(
        `update stage_runs set lease_expires_at = now() - make_interval(secs => $4)
         where case_id = $1 and stage = $2 and attempt = $3`,
        [p.caseId, p.stage, p.attempt, secondsAgo],
      );
      await c.query(`alter table stage_runs enable trigger stage_runs_guard`);
      await c.query('commit');
    } finally {
      c.release();
    }
  }

  /** Test-only: the queue job looks locked (by a live or dead worker) since `secondsAgo`. */
  async function lockJob(p: StagePayload, secondsAgo: number): Promise<void> {
    await db().admin.query(
      `update graphile_worker._private_jobs
       set attempts = max_attempts, locked_at = now() - make_interval(secs => $2), locked_by = 'x'
       where key = $1`,
      [stageJobKey(p), secondsAgo],
    );
  }

  const fakeCtx = (pool: AppPool, tenant: string): StageContext => ({
    workerId: 'test',
    signal: new AbortController().signal,
    inTenantTx: (fn) => withTenant(pool, tenant, fn),
    complete: () => Promise.resolve(),
    heartbeat: () => Promise.resolve(true),
  });

  async function startRunner(
    handler: StageHandler,
    caseId: string,
    over: { leaseSeconds?: number; appPool?: AppPool; workerPool?: WorkerPool } = {},
  ) {
    return run({
      pgPool: db().worker,
      concurrency: 1,
      noHandleSignals: true,
      pollInterval: 100,
      taskList: stageTaskList(
        {
          intake: (j, c) => (j.caseId === caseId ? handler(j, c) : Promise.resolve()),
        },
        {
          appPool: over.appPool ?? db().app,
          workerPool: over.workerPool ?? db().worker,
          leaseSeconds: over.leaseSeconds ?? 3,
          log: () => undefined,
        },
      ),
    });
  }

  // -- 1. leases -------------------------------------------------------------------------------

  it('a paused lease holder is refused its port writes once its confirmed lease has run out', async () => {
    const file = await newCase();
    await enqueueStage(db().app, pay(file.id));
    const handler = stageHandler(
      async (env) => {
        // The process is frozen (no timer runs, no heartbeat goes out) for longer than the lease.
        const end = Date.now() + 2300;
        while (Date.now() < end) {
          /* paused */
        }
        await env.store.transition(env.job.caseId, 'map');
      },
      { appPool: db().app },
    );
    const runner = await startRunner(handler, file.id, { leaseSeconds: 1 });
    try {
      await until(async () => (await stageRunState(db().app, pay(file.id))) === 'failed');
    } finally {
      await runner.stop();
    }
    expect(await stageRunState(db().app, pay(file.id))).toBe('failed');
    const { rows } = await db().admin.query<{ error: string }>(
      `select error from stage_runs where case_id = $1`,
      [file.id],
    );
    expect(rows[0]?.error).toMatch(/lease lost/);
    expect(await storeA.stage(file.id)).toBe('intake');
  }, 60_000);

  it('the sweep does not retry an expired attempt while its job is fresh, and does once the margin passed or the job is dead', async () => {
    const file = await newCase();
    const p = pay(file.id);
    const id = mine(file.id);
    await enqueueStage(db().app, p);
    await claimStageRun(db().worker, p, 'w', 60);
    await expireLease(p, 1);
    await lockJob(p, 0); // locked just now: the holder may be winding down
    expect(await resumeDecision(pools(), p, { staleLockSeconds: 600 })).toBe('wait');
    expect(id(await reconcileOnce(opts({ staleLockSeconds: 600 })))).toEqual([]);
    expect(await stageRunState(db().app, p)).toBe('running');
    // Lease expired for longer than the margin, even though the lock is fresh.
    await expireLease(p, 30);
    await lockJob(p, 0);
    expect(await stageJobState(db().worker, p, 5)).toBe('running');
    expect(id(await reconcileOnce(opts({ staleLockSeconds: 5 })))).toMatchObject([
      { kind: 'retried', nextAttempt: 2 },
    ]);
    // A dead job (old lock) is retried as soon as the lease has expired.
    const file2 = await newCase();
    const q = pay(file2.id);
    await enqueueStage(db().app, q);
    await claimStageRun(db().worker, q, 'w', 60);
    await expireLease(q, 1);
    await lockJob(q, 7200);
    expect(mine(file2.id)(await reconcileOnce(opts({ staleLockSeconds: 600 })))).toMatchObject([
      { kind: 'retried', nextAttempt: 2 },
    ]);
  }, 60_000);

  it('lease checks use the wall clock, not the start of the transaction', async () => {
    const file = await newCase();
    const p = pay(file.id);
    await enqueueStage(db().app, p);
    const token = await claimStageRun(db().worker, p, 'w', 1);
    // A transaction that began before the lease expired keeps asking after it expired.
    const outcome = await withTenant(db().app, A, async (tx) => {
      await tx.execute(sql`select pg_sleep(1.4)`);
      const hb = await tx.execute(
        sql`select public.stage_run_heartbeat(${p.caseId}, ${p.stage}, ${p.attempt}, ${token}, 60) as ok`,
      );
      const done = await tx.execute(
        sql`select public.stage_run_complete(${p.caseId}, ${p.stage}, ${p.attempt}, ${token}) as ok`,
      );
      // The orchestrator may abandon an expired lease even from an older transaction.
      const abandon = await tx.execute(
        sql`select public.stage_run_fail(${p.caseId}, ${p.stage}, ${p.attempt}, 'x', null) as ok`,
      );
      return [hb.rows[0], done.rows[0], abandon.rows[0]];
    });
    expect(outcome).toEqual([{ ok: false }, { ok: false }, { ok: true }]);
    // The trigger too: an expired lease cannot be extended from a transaction older than its expiry.
    const file2 = await newCase();
    const q = pay(file2.id);
    await enqueueStage(db().app, q);
    await claimStageRun(db().worker, q, 'w', 1);
    const c = await db().admin.connect();
    try {
      await c.query('begin');
      await c.query(`select pg_sleep(1.4)`);
      await expect(
        c.query(
          `update stage_runs set lease_expires_at = lease_expires_at + interval '1 minute' where case_id = $1`,
          [file2.id],
        ),
      ).rejects.toThrow(/expired lease cannot be extended/);
    } finally {
      await c.query('rollback');
      c.release();
    }
  }, 30_000);

  it('the lease functions have a lock_timeout, and enqueue and claim take the same shared advisory lock key', async () => {
    const { rows } = await db().admin.query<{ proname: string; proconfig: string[] | null }>(
      `select proname, proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and proname in ('stage_run_heartbeat', 'stage_run_complete', 'stage_run_fail',
                         'enqueue_stage', 'claim_stage_run')`,
    );
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.proconfig, r.proname).toContain('lock_timeout=5s');
    const src = await db().admin.query<{ proname: string; prosrc: string }>(
      `select proname, prosrc from pg_proc where proname in ('enqueue_stage', 'claim_stage_run')`,
    );
    for (const r of src.rows) {
      expect(r.prosrc, r.proname).toContain('stage_lock_key(');
      expect(r.prosrc, r.proname).not.toContain('hashtextextended');
    }
    // Behaviour: both functions really take the lock the helper names.
    const file = await newCase();
    const p = pay(file.id);
    const key = (
      await db().admin.query<{ k: string }>(`select public.stage_lock_key($1, $2, $3)::text as k`, [
        A,
        file.id,
        'intake',
      ])
    ).rows[0]!.k;
    const heldAfter = async (
      pool: AppPool | WorkerPool,
      text: string,
      params: unknown[],
      tenant?: string,
    ) => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        if (tenant) await c.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
        await c.query(text, params);
        const r = await c.query<{ n: string }>(
          `select count(*)::text as n from pg_locks
           where locktype = 'advisory' and pid = pg_backend_pid()
             and ((classid::bigint << 32) | objid::bigint) = $1::bigint`,
          [key],
        );
        return Number(r.rows[0]!.n);
      } finally {
        await c.query('rollback');
        c.release();
      }
    };
    expect(
      await heldAfter(db().app, `select public.enqueue_stage($1, 'intake', 1)`, [file.id], A),
    ).toBe(1);
    await enqueueStage(db().app, p);
    expect(
      await heldAfter(db().worker, `select public.claim_stage_run($1, $2, 'intake', 1, 'w', 60)`, [
        A,
        file.id,
      ]),
    ).toBe(1);
    // And the TS job key equals the SQL one.
    const sqlKey = await db().admin.query<{ k: string }>(
      `select public.stage_job_key($1, $2, $3, $4) as k`,
      [A, file.id, 'intake', 1],
    );
    expect(sqlKey.rows[0]!.k).toBe(stageJobKey(p));
  });

  // -- 2. attempts per visit ---------------------------------------------------------------------

  it('maxStageAttempts counts the attempts of the current visit only', async () => {
    const file = await newCase();
    for (const s of ['map', 'arraign', 'defense', 'prosecution', 'remedy'] as const) {
      await storeA.transition(file.id, s);
    }
    const first = pay(file.id, 'remedy', 1);
    await enqueueStage(db().app, first);
    const t1 = await claimStageRun(db().worker, first, 'w', 60);
    await failStageRun(db().app, first, 'boom', t1!);
    await storeA.transition(file.id, 'verify');
    await storeA.transition(file.id, 'remedy'); // an appeal: a second visit to remedy
    expect(await ensureStageJob(db().app, A, file.id)).toMatchObject({ attempt: 2 });
    const second = pay(file.id, 'remedy', 2);
    const t2 = await claimStageRun(db().worker, second, 'w', 60);
    await failStageRun(db().app, second, 'boom', t2!);
    expect(await stageAttemptState(db().app, A, file.id)).toMatchObject({
      latestAttempt: 2,
      visitAttempts: 1,
    });
    // Two attempts exist for the case and stage, but only one in this visit: one retry is left.
    const actions = mine(file.id)(await reconcileOnce(opts({ maxStageAttempts: 2 })));
    expect(actions).toMatchObject([{ kind: 'retried', nextAttempt: 3 }]);
  }, 60_000);

  // -- 3. recovery scaling -----------------------------------------------------------------------

  it('failed jobs that are superseded or done are not listed again; the list pages', async () => {
    const file = await newCase();
    const a1 = pay(file.id, 'intake', 1);
    await enqueueStage(db().app, a1);
    await lockJob(a1, 7200); // dead
    const listed = async (extra = {}) =>
      (await listFailedStageJobs(db().worker, 60, extra)).map((j) => j.key);
    expect(await listed()).toContain(stageJobKey(a1));
    // A later attempt supersedes it.
    await enqueueStage(db().app, pay(file.id, 'intake', 2));
    expect(await listed()).not.toContain(stageJobKey(a1));
    expect(await listed({ includeHandled: true })).toContain(stageJobKey(a1));
    // Paging: one job per page, oldest first, and the cursor moves on.
    const all = await listFailedStageJobs(db().worker, 60, { includeHandled: true });
    expect(all.length).toBeGreaterThan(1);
    const page1 = await listFailedStageJobs(db().worker, 60, { includeHandled: true, limit: 1 });
    const page2 = await listFailedStageJobs(db().worker, 60, {
      includeHandled: true,
      limit: 1,
      afterId: page1[0]!.id,
    });
    expect(page1[0]!.key).toBe(all[0]!.key);
    expect(page2[0]!.key).toBe(all[1]!.key);
  });

  it('a retry needs two app-pool connections (the lock holder and its work): a pool of 2 suffices for one reconciler', async () => {
    const file = await newCase();
    const a1 = pay(file.id, 'intake', 1);
    await enqueueStage(db().app, a1);
    await lockJob(a1, 7200); // dead
    const small = await openPool(db().appUrl, 'affidavit_app', undefined, { max: 2 });
    try {
      const actions = mine(file.id)(await reconcileOnce(opts({ appPool: small })));
      expect(actions).toMatchObject([{ kind: 'retried', nextAttempt: 2 }]);
      expect(small.totalCount).toBeLessThanOrEqual(2);
    } finally {
      await small.end();
    }
  }, 60_000);

  it('a failed job whose key was rewritten is never counted as handled', async () => {
    const file = await newCase();
    const a1 = pay(file.id, 'intake', 1);
    await enqueueStage(db().app, a1);
    await lockJob(a1, 7200); // dead
    await enqueueStage(db().app, pay(file.id, 'intake', 2)); // supersedes attempt 1
    const handled = async (key: string | null) =>
      (
        await db().admin.query<{ h: boolean }>(
          `select public.stage_attempt_handled($1, $2, 'intake', 1, $3) as h`,
          [A, file.id, key],
        )
      ).rows[0]!.h;
    expect(await handled(stageJobKey(a1))).toBe(true);
    expect(await handled('[wrong]')).toBe(false);
    expect(await handled(null)).toBe(false);
    // Rewrite the job's key (its payload still names the superseded attempt 1): it is not hidden.
    await db().admin.query(`update graphile_worker._private_jobs set key = $2 where key = $1`, [
      stageJobKey(a1),
      `rewritten-${file.id}`,
    ]);
    const keys = (await listFailedStageJobs(db().worker, 60)).map((j) => j.key);
    expect(keys).toContain(`rewritten-${file.id}`);
  });

  it('a Graphile-reset job whose attempt holds a live lease is running, not failed', async () => {
    const file = await newCase();
    const p = pay(file.id);
    await enqueueStage(db().app, p);
    await claimStageRun(db().worker, p, 'w', 60);
    await db().admin.query(
      `update graphile_worker._private_jobs
       set attempts = max_attempts, locked_at = null, locked_by = null, last_error = null
       where key = $1`,
      [stageJobKey(p)],
    );
    expect(await stageJobState(db().worker, p)).toBe('running');
    expect((await listFailedStageJobs(db().worker)).some((j) => j.key === stageJobKey(p))).toBe(
      false,
    );
  });

  it('healthy cases do not crowd orphans out of the sweep, and the sweep pages across passes', async () => {
    // Tenant B: five healthy cases with queued jobs, then three orphans that sort after them.
    const healthy = [];
    for (let i = 0; i < 5; i++) {
      const f = await newCase(B, { id: `a-healthy-${i}-${Date.now()}` });
      await enqueueStage(db().app, pay(f.id, 'intake', 1, B));
      healthy.push(f.id);
    }
    const orphans = [];
    for (let i = 0; i < 3; i++) {
      orphans.push((await newCase(B, { id: `z-orphan-${i}-${Date.now()}` })).id);
    }
    const listed = (await listOpenCases(db().worker, 1000)).map((c) => c.caseId as string);
    for (const h of healthy) expect(listed).not.toContain(h);
    for (const o of orphans) expect(listed).toContain(o);
    // Keyset paging: pages of two, no repeats, nothing missed, and a short page ends the scan.
    const seen: string[] = [];
    let after: { tenantId: string; caseId: string } | null = null;
    for (let i = 0; i < 50; i++) {
      const page = await listOpenCases(db().worker, 2, { after });
      seen.push(...page.map((c) => c.caseId as string));
      const last = page[page.length - 1];
      if (!last || page.length < 2) break;
      after = { tenantId: last.tenantId, caseId: last.caseId };
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(listed);
    // Writes by the app role (updated_at) do not reorder or starve anything: the cursor is the key.
    const cursors: ReconcileCursors = { failedAfterId: null, openAfter: null };
    const enqueued = new Set<string>();
    for (let pass = 0; pass < 30 && enqueued.size < orphans.length; pass++) {
      for (const a of await reconcileOnce(opts({ sweepLimit: 2, cursors }))) {
        if (a.kind === 'enqueued' && orphans.includes(a.payload.caseId)) {
          enqueued.add(a.payload.caseId);
        }
      }
    }
    expect([...enqueued].sort()).toEqual([...orphans].sort());
  }, 60_000);

  // -- 4. recordOnce identity includes the visit -------------------------------------------------

  it('recordOnce emits again when a stage is revisited, and once per visit', async () => {
    const file = await newCase();
    for (const s of ['map', 'arraign', 'defense', 'prosecution', 'remedy'] as const) {
      await storeA.transition(file.id, s);
    }
    const emitted: boolean[] = [];
    const handler = stageHandler(
      async (env) => {
        const body = { type: 'stage-exited', payload: { to: 'verify' } } as const;
        emitted.push(await recordOnce(env, env.job.caseId, 'remedy', 'stenographer', body));
        // A retry within the same visit repeats nothing.
        emitted.push(await recordOnce(env, env.job.caseId, 'remedy', 'stenographer', body));
        await env.store.transition(env.job.caseId, 'verify');
      },
      { appPool: db().app },
    );
    await handler(pay(file.id, 'remedy', 1), fakeCtx(db().app, A));
    await storeA.transition(file.id, 'remedy'); // an appeal: remedy again, a new visit
    await handler(pay(file.id, 'remedy', 2), fakeCtx(db().app, A));
    expect(emitted).toEqual([true, false, true, false]);
    const events = await new PgEventSink(db().app, A).events(file.id);
    expect(events.filter((e) => e.type === 'stage-exited')).toHaveLength(2);
  });

  // -- 5. one retry, one charge, one event under concurrent reconcilers --------------------------

  it('several reconcilers at once enqueue one attempt, charge one cost row and emit one event per stage', async () => {
    const file = await newCase();
    await enqueueStage(db().app, pay(file.id));
    const handler = stageHandler(
      async (env) => {
        await recordOnce(env, env.job.caseId, 'intake', 'stenographer', {
          type: 'stage-entered',
          payload: {},
        });
        if (env.job.attempt === 1) throw new Error('first attempt dies');
        await env.store.transition(env.job.caseId, 'map');
      },
      { appPool: db().app },
    );
    let runner = await startRunner(handler, file.id);
    try {
      await until(async () => (await stageRunState(db().app, pay(file.id))) === 'failed');
    } finally {
      await runner.stop();
    }
    await Promise.all(
      Array.from({ length: 5 }, () => reconcileOnce(opts({ staleLockSeconds: 3 }))),
    );
    expect(await count(`select count(*) n from stage_jobs where case_id = $1`, [file.id])).toBe(2);
    expect(await count(`select count(*) n from cost_rows where case_id = $1`, [file.id])).toBe(1);
    runner = await startRunner(handler, file.id);
    try {
      await until(async () => (await storeA.stage(file.id)) === 'map');
    } finally {
      await runner.stop();
    }
    expect(await storeA.stage(file.id)).toBe('map');
    expect(
      await count(`select count(*) n from events where case_id = $1 and type = 'stage-entered'`, [
        file.id,
      ]),
    ).toBe(1);
  }, 60_000);

  // -- 6. review flags are per visit -------------------------------------------------------------

  it('a review flag blocks its own visit only: an appeal back to the stage starts afresh', async () => {
    const file = await newCase();
    for (const s of ['map', 'arraign', 'defense', 'prosecution', 'remedy'] as const) {
      await storeA.transition(file.id, s);
    }
    const first = pay(file.id, 'remedy', 1);
    await enqueueStage(db().app, first);
    const t1 = await claimStageRun(db().worker, first, 'w', 60);
    await failStageRun(db().app, first, 'boom', t1!);
    // maxStageAttempts 1: the first failure already exhausts this visit.
    expect(mine(file.id)(await reconcileOnce(opts({ maxStageAttempts: 1 })))).toMatchObject([
      { kind: 'needs-review', reason: 'attempts-exhausted' },
    ]);
    expect(await ensureStageJob(db().app, A, file.id)).toBeNull();
    await storeA.transition(file.id, 'verify');
    await storeA.transition(file.id, 'remedy');
    expect(await ensureStageJob(db().app, A, file.id)).toMatchObject({ stage: 'remedy' });
    const { rows } = await db().admin.query<{ visit: number }>(
      `select visit from review_flags where case_id = $1`,
      [file.id],
    );
    expect(rows).toEqual([{ visit: 6 }]);
  }, 60_000);

  // -- 7. forged job whose key equals the payload key --------------------------------------------

  it('a forged job whose job_key equals stageJobKey(payload) is still refused at claim', async () => {
    const file = await newCase();
    const forged = pay(file.id, 'intake', 7);
    // The worker role may write the queue; no stage_jobs record exists for this attempt.
    await db().worker.query(
      `select graphile_worker.add_job('case-stage:intake', $1::json, max_attempts => 1, job_key => $2)`,
      [JSON.stringify(forged), stageJobKey(forged)],
    );
    const ran: number[] = [];
    const runner = await startRunner(() => {
      ran.push(1);
      return Promise.resolve();
    }, file.id);
    try {
      await until(async () =>
        (await listFailedStageJobs(db().worker)).some((j) => j.key === stageJobKey(forged)),
      );
    } finally {
      await runner.stop();
    }
    expect(ran).toEqual([]);
    expect(await stageRunState(db().app, forged)).toBe('unclaimed');
    const failed = (await listFailedStageJobs(db().worker)).find(
      (j) => j.key === stageJobKey(forged),
    );
    expect(failed?.lastError).toMatch(/no enqueued stage job/);
    await expect(claimStageRun(db().worker, forged, 'w', 60)).rejects.toThrow(
      /no enqueued stage job/,
    );
  }, 60_000);

  // -- 8. the SQL terminal list is the contracts list --------------------------------------------

  it('the SQL terminal-stage list equals TERMINAL_STAGES (the live function and migration 0003)', async () => {
    const parse = (text: string) =>
      [...(/stage NOT IN \(([^)]*)\)/.exec(text)?.[1] ?? '').matchAll(/'([a-z]+)'/g)]
        .map((m) => m[1]!)
        .sort();
    const expected = [...TERMINAL_STAGES].sort();
    const fn = await db().admin.query<{ prosrc: string }>(
      `select prosrc from pg_proc where proname = 'list_open_cases'`,
    );
    expect(fn.rows).toHaveLength(1);
    expect(parse(fn.rows[0]!.prosrc)).toEqual(expected);
    const file0003 = readFileSync(
      fileURLToPath(new URL('../drizzle/0003_review_flags_security.sql', import.meta.url)),
      'utf8',
    );
    expect(parse(file0003)).toEqual(expected);
  });

  // -- 9. the heartbeat timer does not stack ------------------------------------------------------

  it('a hung heartbeat is not joined by more heartbeats', async () => {
    const file = await newCase();
    await enqueueStage(db().app, pay(file.id));
    let connects = 0;
    let atAbort = -1;
    const broken = {
      connect: () => {
        connects += 1;
        return new Promise(() => undefined);
      },
    } as unknown as AppPool;
    const runner = await startRunner(
      (_job, ctx) =>
        new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            atAbort = connects;
            resolve();
          });
        }),
      file.id,
      { leaseSeconds: 1, appPool: broken },
    );
    try {
      await until(() => atAbort >= 0, 10_000);
    } finally {
      void runner.stop().catch(() => undefined);
    }
    // The interval is 250 ms and the lease 1 s: without the guard that is three or four calls.
    expect(atAbort).toBe(1);
  }, 30_000);
});
