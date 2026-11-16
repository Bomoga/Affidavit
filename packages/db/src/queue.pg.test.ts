import { run, type Runner } from 'graphile-worker';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { PgCaseStore } from './case-store.js';
import {
  enqueueStage,
  listFailedStageJobs,
  stageJobKey,
  stageJobState,
  stageTaskList,
  type StageHandler,
  type StagePayload,
} from './queue.js';
import { repos } from './schema.js';
import {
  claimStageRun,
  completeStageRun,
  completeStageRunIn,
  failStageRun,
  heartbeatStageRun,
  resumeDecision,
  stageRunInfo,
  stageRunState,
} from './stage-runs.js';
import { withTenant } from './tenant.js';
import { BUDGET, describePg, sampleCase, useTestDatabase } from './test-support.js';

const A = 'tenant-qa';
const B = 'tenant-qb';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describePg('stage queue (Graphile Worker)', () => {
  const db = useTestDatabase([A, B]);
  const caseB = sampleCase(B);
  let n = 0;
  let storeA: PgCaseStore;
  /** Jobs from earlier tests stay queued; handlers only act for the current test case. */
  let scope: string | undefined;
  const scoped = (
    handlers: Partial<Record<StagePayload['stage'], StageHandler>>,
  ): Partial<Record<StagePayload['stage'], StageHandler>> =>
    Object.fromEntries(
      Object.entries(handlers).map(([stage, h]) => [
        stage,
        (job: StagePayload, ctx: Parameters<StageHandler>[1]) =>
          job.caseId === scope ? h(job, ctx) : Promise.resolve(),
      ]),
    );

  const pay = (tenantId: string, caseId: string, stage: StagePayload['stage'], attempt = 1) =>
    ({ tenantId, caseId, stage, attempt }) as StagePayload;
  const pools = () => ({ appPool: db().app, workerPool: db().worker });

  /** A fresh case for tenant A at intake, so scenarios do not share attempts. */
  async function newCaseA() {
    const file = sampleCase(A);
    await storeA.open(file, BUDGET);
    scope = file.id;
    return file;
  }

  beforeAll(async () => {
    storeA = new PgCaseStore(db().app, A);
    await new PgCaseStore(db().app, B).open(caseB, BUDGET);
  }, 60_000);

  async function jobKeys(): Promise<string[]> {
    const { rows } = await db().admin.query<{ key: string }>(
      `select key from graphile_worker.jobs order by key`,
    );
    return rows.map((r) => r.key);
  }

  function options(over: { workerPool?: pg.Pool; workerId?: string; leaseSeconds?: number } = {}) {
    return { appPool: db().app, workerPool: db().worker, log: () => undefined, ...over };
  }

  /** Runs the real worker (worker role) until `done()` or the deadline, then stops it. */
  async function runWorker(
    handlers: Partial<Record<StagePayload['stage'], StageHandler>>,
    done: () => boolean,
  ): Promise<void> {
    const runner = await run({
      pgPool: db().worker,
      concurrency: 1,
      noHandleSignals: true,
      pollInterval: 100,
      taskList: stageTaskList(scoped(handlers), options()),
    });
    try {
      const deadline = Date.now() + 15_000;
      while (!done() && Date.now() < deadline) await wait(100);
      await wait(600);
    } finally {
      await runner.stop();
    }
  }

  /**
   * A runner on its own connections that can be killed: its backends are terminated while a
   * handler is still running, like a crashed process, and its pool is closed afterwards. The
   * handler is left hanging forever. `claimPool` can replace the claim connection (to crash
   * before claiming).
   */
  async function startKillableRunner(
    handlers: Partial<Record<StagePayload['stage'], StageHandler>>,
    over: { leaseSeconds?: number; claimPool?: pg.Pool } = {},
  ) {
    const name = `runner-${(n += 1)}`;
    const u = new URL(db().workerUrl);
    u.searchParams.set('application_name', name);
    const pool = new pg.Pool({ connectionString: u.toString() });
    pool.on('error', () => undefined);
    const runner: Runner = await run({
      pgPool: pool,
      concurrency: 1,
      noHandleSignals: true,
      pollInterval: 100,
      taskList: stageTaskList(
        scoped(handlers),
        options({
          workerId: name,
          leaseSeconds: over.leaseSeconds ?? 60,
          ...(over.claimPool ? { workerPool: over.claimPool } : {}),
        }),
      ),
    });
    runner.promise.catch(() => undefined);
    return {
      name,
      async kill() {
        await db().admin.query(
          `select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1`,
          [name],
        );
        await Promise.race([pool.end().catch(() => undefined), wait(3000)]);
      },
    };
  }

  async function until(cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!(await cond()) && Date.now() < deadline) await wait(100);
  }

  /** Test-only: make an open attempt's lease already expired (the guard forbids moving it back). */
  async function expireLease(p: StagePayload): Promise<void> {
    const c = await db().admin.connect();
    try {
      await c.query('begin');
      await c.query(`alter table stage_runs disable trigger stage_runs_guard`);
      await c.query(
        `update stage_runs set lease_expires_at = now() - interval '1 second'
         where case_id = $1 and stage = $2 and attempt = $3`,
        [p.caseId, p.stage, p.attempt],
      );
      await c.query(`alter table stage_runs enable trigger stage_runs_guard`);
      await c.query('commit');
    } finally {
      c.release();
    }
  }

  /** Test-only: pretend the worker holding this job's lock died long ago. */
  async function ageJobLock(p: StagePayload): Promise<void> {
    await db().admin.query(
      `update graphile_worker._private_jobs set locked_at = now() - interval '2 hours' where key = $1`,
      [stageJobKey(p)],
    );
  }

  async function appSql(text: string, params: unknown[] = []): Promise<string> {
    const c = await db().app.connect();
    try {
      await c.query('begin');
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

  it('enqueueing the same case, stage and attempt twice yields one job, with the TS job key', async () => {
    const file = await newCaseA();
    const p = pay(A, file.id, 'intake');
    expect(await enqueueStage(db().app, p)).toBe(true);
    expect(await enqueueStage(db().app, p)).toBe(false);
    expect((await jobKeys()).filter((k) => k === stageJobKey(p))).toHaveLength(1);
    expect(await enqueueStage(db().app, { ...p, attempt: 2 })).toBe(true);
  });

  it('only the case current stage can be enqueued, with a bounded attempt, and the visit is recorded', async () => {
    const file = await newCaseA();
    await expect(enqueueStage(db().app, pay(A, file.id, 'map'))).rejects.toThrow(/not map/);
    await expect(enqueueStage(db().app, pay(A, file.id, 'intake', 101))).rejects.toThrow(/invalid/);
    await expect(enqueueStage(db().app, pay(A, caseB.id, 'map'))).rejects.toThrow(/unknown case/);
    await enqueueStage(db().app, pay(A, file.id, 'intake', 100));
    await storeA.transition(file.id, 'map');
    await enqueueStage(db().app, pay(A, file.id, 'map'));
    const { rows } = await db().admin.query<{ stage: string; visit: number }>(
      `select stage, visit from stage_jobs where case_id = $1 order by visit`,
      [file.id],
    );
    expect(rows).toEqual([
      { stage: 'intake', visit: 1 },
      { stage: 'map', visit: 2 },
    ]);
  });

  it('re-enqueueing after the job completed does not run the stage again', async () => {
    const file = await newCaseA();
    const p = pay(A, file.id, 'intake');
    const seen: StagePayload[] = [];
    const handlers = {
      intake: (job: StagePayload) => {
        seen.push(job);
        return Promise.resolve();
      },
    };
    await enqueueStage(db().app, p);
    await runWorker(handlers, () => seen.length > 0);
    expect(seen).toEqual([p]);
    expect(await stageRunState(db().app, p)).toBe('completed');
    // The finished job is deleted by Graphile, so the same key is free to enqueue again.
    expect((await jobKeys()).includes(stageJobKey(p))).toBe(false);
    expect(await enqueueStage(db().app, p)).toBe(true);
    await runWorker(handlers, () => false);
    expect(seen).toHaveLength(1);
  }, 60_000);

  it('a handler error is recorded as failed, not left looking like a crash, and surfaced', async () => {
    const file = await newCaseA();
    const p = pay(A, file.id, 'intake');
    let calls = 0;
    await enqueueStage(db().app, p);
    await runWorker(
      {
        intake: () => {
          calls += 1;
          return Promise.reject(new Error('model said no'));
        },
      },
      () => calls > 0,
    );
    const info = await stageRunInfo(db().app, p);
    expect(info?.state).toBe('failed');
    expect(info?.error).toBe('model said no');
    // The failed job keeps its key: re-enqueue reports false, and the failure is listable.
    expect(await enqueueStage(db().app, p)).toBe(false);
    expect(await stageJobState(db().worker, p)).toBe('failed');
    const failed = await listFailedStageJobs(db().worker);
    expect(failed.find((j) => j.key === stageJobKey(p))?.reason).toBe('failed');
    expect(await resumeDecision(pools(), p)).toBe('next-attempt');
    expect(await completeStageRun(db().app, p)).toBe(false);
    expect(await failStageRun(db().app, p, 'again')).toBe(false);
    expect(await enqueueStage(db().app, { ...p, attempt: 2 })).toBe(true);
  }, 60_000);

  it('a forged or rewritten job is refused at claim and surfaced as a failed job', async () => {
    const file = await newCaseA();
    // Forged: the worker role can write the queue, but no stage_jobs record exists for tenant B.
    await db().worker.query(
      `select graphile_worker.add_job('case-stage:map', $1::json, max_attempts => 1, job_key => 'forged-1')`,
      [JSON.stringify({ tenantId: B, caseId: caseB.id, stage: 'map', attempt: 1 })],
    );
    // Rewritten: a real tenant A job whose payload is changed to tenant B before it runs.
    const real = pay(A, file.id, 'intake', 3);
    await enqueueStage(db().app, real);
    await db().worker.query(
      `update graphile_worker._private_jobs set payload = $1::json where key = $2`,
      [JSON.stringify({ ...real, tenantId: B, caseId: caseB.id }), stageJobKey(real)],
    );
    const ran: StagePayload[] = [];
    const record = (job: StagePayload) => {
      ran.push(job);
      return Promise.resolve();
    };
    await runWorker({ map: record, intake: record }, () => false);
    // Other tenant A jobs from earlier tests may run; nothing for tenant B or B's case may.
    expect(ran.every((j) => j.tenantId === A && j.caseId !== caseB.id)).toBe(true);
    const failed = await listFailedStageJobs(db().worker);
    expect(failed.map((j) => j.key)).toEqual(
      expect.arrayContaining(['forged-1', stageJobKey(real)]),
    );
    expect(failed.find((j) => j.key === 'forged-1')?.lastError).toMatch(/no enqueued stage job/);
    expect(await stageRunState(db().app, pay(B, caseB.id, 'map'))).toBe('unclaimed');
    await expect(claimStageRun(db().worker, pay(B, caseB.id, 'map', 9), 'w', 60)).rejects.toThrow(
      /no enqueued stage job/,
    );
    await expect(claimStageRun(db().worker, pay(A, caseB.id, 'map', 1), 'w', 60)).rejects.toThrow(
      /no enqueued stage job/,
    );
  }, 60_000);

  it('completion in the handler own transaction is atomic with its work', async () => {
    const file = await newCaseA();
    const p = pay(A, file.id, 'intake');
    const p2 = { ...p, attempt: 2 };
    let calls = 0;
    const handler: StageHandler = async (job, ctx) => {
      calls += 1;
      await ctx.inTenantTx(async (tx) => {
        await tx.insert(repos).values({ tenantId: A, id: `work-${job.attempt}-${file.id}` });
        await ctx.complete(tx);
        // Attempt 1: the transaction fails after completing, so neither write may survive.
        if (job.attempt === 1) throw new Error('boom after complete');
      });
    };
    await enqueueStage(db().app, p);
    await runWorker({ intake: handler }, () => calls > 0);
    expect((await stageRunInfo(db().app, p))?.state).toBe('failed');
    await enqueueStage(db().app, p2);
    await runWorker({ intake: handler }, () => calls > 1);
    expect((await stageRunInfo(db().app, p2))?.state).toBe('completed');
    const { rows } = await db().admin.query<{ id: string }>(
      `select id from repos where id like $1 and tenant_id = $2 order by id`,
      [`work-%-${file.id}`, A],
    );
    expect(rows.map((r) => r.id)).toEqual([`work-2-${file.id}`]);
  }, 60_000);

  describe('leases are enforced in SQL', () => {
    it('a live lease cannot be abandoned or adopted; an expired one cannot be heartbeaten or completed', async () => {
      const file = await newCaseA();
      const p = pay(A, file.id, 'intake');
      await enqueueStage(db().app, p);
      expect(await claimStageRun(db().worker, p, 'w1', 60)).toBe(true);
      // Live: neither the orchestrator's abandon nor its adopt works.
      expect(await failStageRun(db().app, p, 'abandon')).toBe(false);
      expect(await completeStageRun(db().app, p)).toBe(false);
      // Only the holder can heartbeat.
      expect(await heartbeatStageRun(db().app, p, 'w2', 60)).toBe(false);
      expect(await heartbeatStageRun(db().app, p, 'w1', 60)).toBe(true);
      expect(await stageRunState(db().app, p)).toBe('running');
      // Expired: the zombie holder can no longer heartbeat or complete, in any of the three ways.
      await expireLease(p);
      expect(await heartbeatStageRun(db().app, p, 'w1', 60)).toBe(false);
      expect(await completeStageRun(db().app, p, 'w1')).toBe(false);
      await expect(
        withTenant(db().app, A, (tx) => completeStageRunIn(tx, p, 'w1')),
      ).rejects.toThrow(/not open under a live lease/);
      expect(
        await appSql(
          `update stage_runs set lease_expires_at = now() + interval '1 hour' where case_id = '${file.id}'`,
        ),
      ).toMatch(/expired lease cannot be extended/);
      // Now the orchestrator may abandon it, once.
      expect(await failStageRun(db().app, p, 'lease expired')).toBe(true);
      expect(await failStageRun(db().app, p, 'again')).toBe(false);
    });

    it('the application role cannot push a lease or heartbeat out to infinity', async () => {
      const file = await newCaseA();
      const p = pay(A, file.id, 'intake');
      await enqueueStage(db().app, p);
      await claimStageRun(db().worker, p, 'w1', 60);
      for (const col of ['lease_expires_at', 'heartbeat_at']) {
        expect(
          await appSql(`update stage_runs set ${col} = 'infinity' where case_id = '${file.id}'`),
          col,
        ).toMatch(/beyond the allowed bound/);
      }
      expect(
        await appSql(
          `update stage_runs set lease_expires_at = now() + interval '3 days' where case_id = '${file.id}'`,
        ),
      ).toMatch(/beyond the allowed bound/);
    });

    it('claim refuses a lease outside 1 second to 1 day', async () => {
      const file = await newCaseA();
      const p = pay(A, file.id, 'intake');
      await enqueueStage(db().app, p);
      await expect(claimStageRun(db().worker, p, 'w1', 0)).rejects.toThrow(/invalid claim/);
      await expect(claimStageRun(db().worker, p, 'w1', 86401)).rejects.toThrow(/invalid claim/);
    });
  });

  describe('real kill and resume', () => {
    it('a kill mid-handler: the attempt never re-runs, not even after a worker restart; the next attempt does', async () => {
      const file = await newCaseA();
      const p = pay(A, file.id, 'intake');
      const calls: number[] = [];
      const hang: StageHandler = (job) => {
        calls.push(job.attempt);
        return new Promise<void>(() => undefined);
      };
      await enqueueStage(db().app, p);
      const r1 = await startKillableRunner({ intake: hang });
      await until(() => calls.length > 0);
      await r1.kill();
      expect(calls).toEqual([1]);
      expect(await stageRunState(db().app, p)).toBe('running');
      expect(await resumeDecision(pools(), p)).toBe('wait');
      // Restart a worker: Graphile will not re-deliver the used-up job, and a re-enqueue of the
      // same attempt is a no-op, so the handler is not called a second time.
      expect(await enqueueStage(db().app, p)).toBe(false);
      await runWorker({ intake: hang }, () => false);
      expect(calls).toEqual([1]);
      // The lease runs out: the orchestrator abandons attempt 1 and starts attempt 2.
      await expireLease(p);
      expect(await resumeDecision(pools(), p)).toBe('next-attempt');
      expect(await failStageRun(db().app, p, 'lease expired')).toBe(true);
      const next = { ...p, attempt: 2 };
      await enqueueStage(db().app, next);
      await runWorker(
        {
          intake: async (job, ctx) => {
            calls.push(job.attempt);
            await ctx.inTenantTx((tx) => ctx.complete(tx));
          },
        },
        () => calls.length > 1,
      );
      expect(calls).toEqual([1, 2]);
      expect(await stageRunState(db().app, next)).toBe('completed');
      expect(await resumeDecision(pools(), next)).toBe('done');
    }, 90_000);

    it('a kill after the work committed: the case left the stage, so the attempt is adopted once its lease expires, never re-run', async () => {
      const file = await newCaseA();
      const p = pay(A, file.id, 'intake');
      const calls: number[] = [];
      const doWorkThenHang: StageHandler = async (job) => {
        calls.push(job.attempt);
        await storeA.transition(job.caseId, 'map');
        await new Promise<void>(() => undefined);
      };
      await enqueueStage(db().app, p);
      const r1 = await startKillableRunner({ intake: doWorkThenHang });
      await until(async () => (await storeA.stage(file.id)) === 'map');
      await r1.kill();
      // Under a live lease the orchestrator waits and cannot adopt.
      expect(await resumeDecision(pools(), p)).toBe('wait');
      expect(await completeStageRun(db().app, p)).toBe(false);
      await expireLease(p);
      expect(await resumeDecision(pools(), p)).toBe('adopt-complete');
      expect(await completeStageRun(db().app, p)).toBe(true);
      expect(await stageRunState(db().app, p)).toBe('completed');
      expect(await resumeDecision(pools(), p)).toBe('done');
      expect(calls).toEqual([1]);
    }, 60_000);

    it('a crash BEFORE claim leaves a stale-locked job: it is surfaced and resume moves to the next attempt', async () => {
      const file = await newCaseA();
      const p = pay(A, file.id, 'intake');
      const calls: number[] = [];
      // The claim connection never answers, like a worker that died between locking and claiming.
      const deadClaim = { query: () => new Promise(() => undefined) } as unknown as pg.Pool;
      await enqueueStage(db().app, p);
      const r1 = await startKillableRunner(
        {
          intake: (job) => {
            calls.push(job.attempt);
            return Promise.resolve();
          },
        },
        { claimPool: deadClaim },
      );
      await until(async () => (await stageJobState(db().worker, p)) === 'running');
      await r1.kill();
      expect(await stageRunState(db().app, p)).toBe('unclaimed');
      // The lock is fresh: a worker might still be about to claim, so wait.
      expect(await resumeDecision(pools(), p)).toBe('wait');
      // Locked, attempt used up, last_error null, and enqueueStage cannot help: a silent stall.
      expect(await enqueueStage(db().app, p)).toBe(false);
      await ageJobLock(p);
      expect(await stageJobState(db().worker, p)).toBe('stale');
      const stale = await listFailedStageJobs(db().worker);
      expect(stale.find((j) => j.key === stageJobKey(p))?.reason).toBe('stale-lock');
      expect(await resumeDecision(pools(), p)).toBe('next-attempt');
      const next = { ...p, attempt: 2 };
      expect(await enqueueStage(db().app, next)).toBe(true);
      await runWorker(
        {
          intake: (job) => {
            calls.push(job.attempt);
            return Promise.resolve();
          },
        },
        () => calls.length > 0,
      );
      expect(calls).toEqual([2]);
    }, 90_000);

    it('a stage visited twice: an open attempt for the first visit is not mistaken for the second', async () => {
      const file = await newCaseA();
      for (const s of ['map', 'arraign', 'defense', 'prosecution', 'remedy', 'verify'] as const) {
        await storeA.transition(file.id, s);
      }
      const first = pay(A, file.id, 'verify', 1);
      await enqueueStage(db().app, first);
      await claimStageRun(db().worker, first, 'w1', 60);
      // verify -> remedy -> verify: the case is at 'verify' again, but it is a new visit.
      await storeA.transition(file.id, 'remedy');
      await storeA.transition(file.id, 'verify');
      expect(await storeA.stage(file.id)).toBe('verify');
      expect(await resumeDecision(pools(), first)).toBe('wait'); // lease still live
      expect(await completeStageRun(db().app, first)).toBe(false); // never adopted under a live lease
      await expireLease(first);
      expect(await resumeDecision(pools(), first)).toBe('adopt-complete');
      expect(await completeStageRun(db().app, first)).toBe(true);
      // The second visit is its own attempt and starts normally.
      const second = pay(A, file.id, 'verify', 2);
      expect(await resumeDecision(pools(), second)).toBe('start');
      await enqueueStage(db().app, second);
      const { rows } = await db().admin.query<{ attempt: number; visit: number }>(
        `select attempt, visit from stage_jobs where case_id = $1 and stage = 'verify' order by attempt`,
        [file.id],
      );
      expect(rows[1]!.visit).toBeGreaterThan(rows[0]!.visit);
    }, 60_000);
  });

  it('pins the Graphile Worker internals the queue code depends on', async () => {
    const cols = async (view: string) => {
      const { rows } = await db().admin.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'graphile_worker' and table_name = $1`,
        [view],
      );
      return rows.map((r) => r.column_name);
    };
    expect(await cols('_private_jobs')).toEqual(
      expect.arrayContaining([
        'key',
        'payload',
        'attempts',
        'max_attempts',
        'last_error',
        'locked_at',
      ]),
    );
    expect(await cols('jobs')).toEqual(
      expect.arrayContaining(['id', 'key', 'attempts', 'max_attempts', 'last_error', 'locked_at']),
    );
    const { rows } = await db().admin.query<{ args: string }>(
      `select pg_get_function_arguments(p.oid) as args from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'graphile_worker' and p.proname = 'add_job'`,
    );
    for (const arg of ['identifier', 'payload', 'max_attempts', 'job_key', 'job_key_mode']) {
      expect(rows[0]!.args, arg).toContain(arg);
    }
  });

  describe('tenant A against the queue', () => {
    it('cannot read, delete, truncate or insert queue tables, or call queue functions directly', async () => {
      const file = await newCaseA();
      await enqueueStage(db().app, pay(A, file.id, 'intake', 11));
      const statements = [
        `select * from graphile_worker.jobs`,
        `select * from graphile_worker._private_jobs`,
        `delete from graphile_worker._private_jobs`,
        `truncate graphile_worker._private_jobs`,
        `update graphile_worker._private_jobs set payload = '{}'`,
        `insert into graphile_worker._private_tasks (identifier) values ('x')`,
        `select graphile_worker.add_job('case-stage:map', '{"tenantId":"tenant-qb"}')`,
        `select graphile_worker.remove_job('x')`,
        `select * from graphile_worker.migrations`,
        `select public.claim_stage_run('${A}', '${file.id}', 'intake', 11, 'w', 60)`,
        `insert into stage_runs (tenant_id, case_id, stage, attempt, worker_id, lease_expires_at) values ('${A}', '${file.id}', 'intake', 12, 'w', now())`,
        `insert into stage_jobs (tenant_id, case_id, stage, attempt, visit) values ('${A}', '${file.id}', 'intake', 13, 1)`,
        `update stage_runs set worker_id = 'other'`,
      ];
      for (const s of statements) {
        expect(await appSql(s), s).toMatch(/permission denied/);
      }
    });

    it('cannot enqueue into B: the case must exist for the tenant doing the enqueue', async () => {
      expect(await appSql(`select public.enqueue_stage('${caseB.id}', 'intake', 1)`)).toMatch(
        /unknown case/,
      );
      const { rows } = await db().admin.query(`select 1 from stage_jobs where case_id = $1`, [
        caseB.id,
      ]);
      expect(rows).toHaveLength(0);
    });

    it('cannot enqueue with no tenant set, or with a bad stage or attempt', async () => {
      await expect(db().app.query(`select public.enqueue_stage('c', 'map', 1)`)).rejects.toThrow(
        /no tenant set/,
      );
      for (const q of [
        `select public.enqueue_stage('c', 'nope', 1)`,
        `select public.enqueue_stage('c', 'map', 0)`,
      ]) {
        expect(await appSql(q), q).toMatch(/invalid/);
      }
    });

    it('the worker role runs the queue but cannot touch tenant tables, enqueue, or truncate the queue', async () => {
      const c = await db().worker.connect();
      try {
        for (const s of [
          `select * from public.cases`,
          `select * from public.verdicts`,
          `select * from public.stage_jobs`,
          `select * from public.stage_runs`,
          `select public.enqueue_stage('c', 'map', 1)`,
          `truncate graphile_worker._private_jobs`,
          `update graphile_worker.migrations set id = id`,
          `drop table graphile_worker._private_jobs`,
        ]) {
          await expect(c.query(s), s).rejects.toThrow(/permission denied|must be owner/);
        }
        const { rows } = await c.query<{ n: number }>(
          `select count(*)::int as n from graphile_worker.jobs`,
        );
        expect(rows[0]!.n).toBeGreaterThan(0);
      } finally {
        c.release();
      }
    });
  });
});
