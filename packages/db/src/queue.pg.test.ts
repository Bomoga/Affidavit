import { run, type Runner } from 'graphile-worker';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { PgCaseStore } from './case-store.js';
import {
  enqueueStage,
  listFailedStageJobs,
  stageJobKey,
  stageTaskList,
  type StageHandler,
  type StagePayload,
} from './queue.js';
import {
  claimStageRun,
  completeStageRun,
  failStageRun,
  resumeDecision,
  stageRunInfo,
  stageRunState,
} from './stage-runs.js';
import { repos } from './schema.js';
import { BUDGET, describePg, sampleCase, useTestDatabase } from './test-support.js';

const A = 'tenant-qa';
const B = 'tenant-qb';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describePg('stage queue (Graphile Worker)', () => {
  const db = useTestDatabase([A, B]);
  const caseB = sampleCase(B);
  let n = 0;
  let storeA: PgCaseStore;

  const pay = (tenantId: string, caseId: string, stage: StagePayload['stage'], attempt = 1) =>
    ({ tenantId, caseId, stage, attempt }) as StagePayload;

  /** A fresh case for tenant A at intake, so scenarios do not share attempts. */
  async function newCaseA() {
    const file = sampleCase(A);
    await storeA.open(file, BUDGET);
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
    return { appPool: db().app, workerPool: db().worker, ...over };
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
      taskList: stageTaskList(handlers, options()),
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
   * handler is still running, like a crashed process. The handler is left hanging forever.
   */
  async function startKillableRunner(
    handlers: Partial<Record<StagePayload['stage'], StageHandler>>,
    leaseSeconds: number,
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
      taskList: stageTaskList(handlers, options({ workerId: name, leaseSeconds })),
    });
    runner.promise.catch(() => undefined);
    return {
      name,
      async kill() {
        await db().admin.query(
          `select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1`,
          [name],
        );
      },
    };
  }

  async function until(cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!(await cond()) && Date.now() < deadline) await wait(100);
  }

  it('enqueueing the same case, stage and attempt twice yields one job, with the TS job key', async () => {
    const file = await newCaseA();
    const p = pay(A, file.id, 'map');
    expect(await enqueueStage(db().app, p)).toBe(true);
    expect(await enqueueStage(db().app, p)).toBe(false);
    expect((await jobKeys()).filter((k) => k === stageJobKey(p))).toHaveLength(1);
    expect(await enqueueStage(db().app, pay(A, file.id, 'map', 2))).toBe(true);
    expect(await enqueueStage(db().app, pay(A, file.id, 'arraign'))).toBe(true);
  });

  it('a payload for an unknown case is refused', async () => {
    await expect(enqueueStage(db().app, pay(A, caseB.id, 'map'))).rejects.toThrow(/unknown case/);
  });

  it('re-enqueueing after the job completed does not run the stage again', async () => {
    const file = await newCaseA();
    const p = pay(A, file.id, 'defense');
    const seen: StagePayload[] = [];
    const handlers = {
      defense: (job: StagePayload) => {
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
    const p = pay(A, file.id, 'prosecution');
    let calls = 0;
    await enqueueStage(db().app, p);
    await runWorker(
      {
        prosecution: () => {
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
    expect((await listFailedStageJobs(db().worker)).map((j) => j.key)).toContain(stageJobKey(p));
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
    const real = pay(A, file.id, 'map', 3);
    await enqueueStage(db().app, real);
    await db().worker.query(
      `update graphile_worker._private_jobs set payload = $1::json where key = $2`,
      [JSON.stringify({ ...real, tenantId: B, caseId: caseB.id }), stageJobKey(real)],
    );
    const ran: StagePayload[] = [];
    await runWorker(
      {
        map: (job) => {
          ran.push(job);
          return Promise.resolve();
        },
      },
      () => false,
    );
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
        await tx.insert(repos).values({ tenantId: A, id: `work-${job.attempt}` });
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
      `select id from repos where id like 'work-%' and tenant_id = $1 order by id`,
      [A],
    );
    expect(rows.map((r) => r.id)).toEqual(['work-2']);
  }, 60_000);

  it('kill mid-handler: the attempt is never re-run, the lease expires, the next attempt runs', async () => {
    const file = await newCaseA();
    const p = pay(A, file.id, 'intake');
    const calls: number[] = [];
    const hang: StageHandler = (job) => {
      calls.push(job.attempt);
      return new Promise<void>(() => undefined);
    };
    await enqueueStage(db().app, p);
    const r1 = await startKillableRunner({ intake: hang }, 3);
    await until(() => calls.length > 0);
    await r1.kill();
    expect(calls).toEqual([1]);
    expect(await stageRunState(db().app, p)).toBe('running');
    expect(await resumeDecision(db().app, p)).toBe('wait');
    // Restart: the same attempt is delivered again (re-enqueue) and must not run a second time.
    await db().admin.query(`delete from graphile_worker._private_jobs where key = $1`, [
      stageJobKey(p),
    ]);
    await enqueueStage(db().app, p);
    await runWorker({ intake: hang }, () => false);
    expect(calls).toEqual([1]);
    // The lease runs out: the orchestrator abandons attempt 1 and starts attempt 2.
    await wait(3500);
    expect(await resumeDecision(db().app, p)).toBe('next-attempt');
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
    expect(await resumeDecision(db().app, next)).toBe('done');
  }, 90_000);

  it('kill after the work committed but before completion: the case left the stage, so it is adopted, not re-run', async () => {
    const file = await newCaseA();
    const p = pay(A, file.id, 'intake');
    const calls: number[] = [];
    const doWorkThenHang: StageHandler = async (job) => {
      calls.push(job.attempt);
      await storeA.transition(job.caseId, 'map');
      await new Promise<void>(() => undefined);
    };
    await enqueueStage(db().app, p);
    const r1 = await startKillableRunner({ intake: doWorkThenHang }, 1);
    await until(async () => (await storeA.stage(file.id)) === 'map');
    await r1.kill();
    await wait(1500);
    expect(await stageRunState(db().app, p)).toBe('running');
    expect(await resumeDecision(db().app, p)).toBe('adopt-complete');
    expect(await completeStageRun(db().app, p)).toBe(true);
    expect(await stageRunState(db().app, p)).toBe('completed');
    expect(await resumeDecision(db().app, p)).toBe('done');
    expect(calls).toEqual([1]);
  }, 60_000);

  describe('tenant A against the queue', () => {
    it('cannot read, delete, truncate or insert queue tables, or call queue functions directly', async () => {
      const file = await newCaseA();
      await enqueueStage(db().app, pay(A, file.id, 'map', 11));
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
        `select public.claim_stage_run('${A}', '${file.id}', 'map', 11, 'w', 60)`,
        `insert into stage_runs (tenant_id, case_id, stage, attempt, worker_id, lease_expires_at) values ('${A}', '${file.id}', 'map', 12, 'w', now())`,
        `insert into stage_jobs (tenant_id, case_id, stage, attempt) values ('${A}', '${file.id}', 'map', 13)`,
        `update stage_runs set worker_id = 'other'`,
      ];
      for (const s of statements) {
        const c = await db().app.connect();
        try {
          await c.query('begin');
          await c.query(`select set_config('app.tenant_id', $1, true)`, [A]);
          await expect(c.query(s), s).rejects.toThrow(/permission denied/);
        } finally {
          await c.query('rollback');
          c.release();
        }
      }
    });

    it('cannot enqueue into B: the case must exist for the tenant doing the enqueue', async () => {
      const c = await db().app.connect();
      try {
        await c.query('begin');
        await c.query(`select set_config('app.tenant_id', $1, true)`, [A]);
        await expect(
          c.query(`select public.enqueue_stage($1, 'jury', 1)`, [caseB.id]),
        ).rejects.toThrow(/unknown case/);
        await c.query('rollback');
      } finally {
        c.release();
      }
      const { rows } = await db().admin.query(
        `select 1 from graphile_worker._private_jobs where payload->>'caseId' = $1 and payload->>'stage' = 'jury'`,
        [caseB.id],
      );
      expect(rows).toHaveLength(0);
    });

    it('cannot enqueue with no tenant set, or with a bad stage or attempt', async () => {
      await expect(db().app.query(`select public.enqueue_stage('c', 'map', 1)`)).rejects.toThrow(
        /no tenant set/,
      );
      const c = await db().app.connect();
      try {
        for (const q of [
          `select public.enqueue_stage('c', 'nope', 1)`,
          `select public.enqueue_stage('c', 'map', 0)`,
        ]) {
          await c.query('begin');
          await c.query(`select set_config('app.tenant_id', $1, true)`, [A]);
          await expect(c.query(q), q).rejects.toThrow(/invalid/);
          await c.query('rollback');
        }
      } finally {
        c.release();
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
