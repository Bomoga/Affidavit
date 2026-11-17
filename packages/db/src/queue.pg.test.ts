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
import { withTenant, type AppPool, type WorkerPool } from './tenant.js';
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

  function options(
    over: { workerPool?: WorkerPool; workerId?: string; leaseSeconds?: number } = {},
  ) {
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
    over: { leaseSeconds?: number; claimPool?: WorkerPool } = {},
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
    // Refused before the claim now: the queue key does not name the payload's tenant and case.
    // The claim itself still refuses the same payload (asserted directly below).
    expect(failed.find((j) => j.key === 'forged-1')?.lastError).toMatch(
      /queue job key does not match its payload/,
    );
    expect(failed.find((j) => j.key === stageJobKey(real))?.lastError).toMatch(
      /queue job key does not match its payload/,
    );
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
    /** One statement as the database owner or superuser, rolled back: for the trigger guards. */
    async function adminSql(text: string): Promise<string> {
      const c = await db().admin.connect();
      try {
        await c.query('begin');
        try {
          await c.query(text);
          return 'no error';
        } catch (err) {
          return (err as Error).message;
        }
      } finally {
        await c.query('rollback');
        c.release();
      }
    }

    it('a live lease cannot be abandoned or adopted; an expired one cannot be heartbeaten or completed', async () => {
      const file = await newCaseA();
      const p = pay(A, file.id, 'intake');
      await enqueueStage(db().app, p);
      const token = await claimStageRun(db().worker, p, 'w1', 60);
      expect(token).toEqual(expect.any(String));
      // Live: neither the orchestrator's abandon nor its adopt works.
      expect(await failStageRun(db().app, p, 'abandon')).toBe(false);
      expect(await completeStageRun(db().app, p)).toBe(false);
      // Only the holder of the secret token can heartbeat, complete or fail.
      expect(await heartbeatStageRun(db().app, p, 'guess', 60)).toBe(false);
      expect(await completeStageRun(db().app, p, 'guess')).toBe(false);
      expect(await failStageRun(db().app, p, 'x', 'guess')).toBe(false);
      expect(await heartbeatStageRun(db().app, p, token!, 60)).toBe(true);
      expect(await stageRunState(db().app, p)).toBe('running');
      // Expired: the zombie holder can no longer heartbeat or complete, in any of the three ways.
      await expireLease(p);
      expect(await heartbeatStageRun(db().app, p, token!, 60)).toBe(false);
      expect(await completeStageRun(db().app, p, token!)).toBe(false);
      await expect(
        withTenant(db().app, A, (tx) => completeStageRunIn(tx, p, token!)),
      ).rejects.toThrow(/not open under a live lease/);
      // Now the orchestrator may abandon it, once.
      expect(await failStageRun(db().app, p, 'lease expired')).toBe(true);
      expect(await failStageRun(db().app, p, 'again')).toBe(false);
    });

    it('the application role has no UPDATE on stage runs and cannot read lease tokens', async () => {
      const file = await newCaseA();
      const p = pay(A, file.id, 'intake');
      await enqueueStage(db().app, p);
      await claimStageRun(db().worker, p, 'w1', 60);
      for (const set of [
        `completed_at = now()`,
        `failed_at = now(), error = 'x'`,
        `lease_expires_at = now() + interval '1 minute'`,
        `heartbeat_at = now()`,
        `lease_token = 'mine'`,
      ]) {
        expect(
          await appSql(`update stage_runs set ${set} where case_id = '${file.id}'`),
          set,
        ).toMatch(/permission denied/);
      }
      expect(await appSql(`select lease_token from stage_runs`)).toMatch(/permission denied/);
      expect(await appSql(`select * from stage_runs`)).toMatch(/permission denied/);
    });

    it('the database caps a lease, refuses infinity, and will not extend an expired lease', async () => {
      const file = await newCaseA();
      const p = pay(A, file.id, 'intake');
      await enqueueStage(db().app, p);
      await claimStageRun(db().worker, p, 'w1', 60);
      const where = `where case_id = '${file.id}'`;
      for (const col of ['lease_expires_at', 'heartbeat_at']) {
        expect(await adminSql(`update stage_runs set ${col} = 'infinity' ${where}`), col).toMatch(
          /beyond the allowed bound/,
        );
      }
      expect(
        await adminSql(
          `update stage_runs set lease_expires_at = now() + interval '3 hours' ${where}`,
        ),
      ).toMatch(/beyond the allowed bound/);
      await expireLease(p);
      expect(
        await adminSql(
          `update stage_runs set lease_expires_at = now() + interval '1 minute' ${where}`,
        ),
      ).toMatch(/expired lease cannot be extended/);
    });

    it('claim refuses a lease outside 1 second to 1 hour', async () => {
      const file = await newCaseA();
      const p = pay(A, file.id, 'intake');
      await enqueueStage(db().app, p);
      await expect(claimStageRun(db().worker, p, 'w1', 0)).rejects.toThrow(/invalid claim/);
      await expect(claimStageRun(db().worker, p, 'w1', 3601)).rejects.toThrow(/invalid claim/);
    });

    it('the wrapper heartbeats on a timer so a long handler keeps its lease, and aborts the signal when the lease is lost', async () => {
      const file = await newCaseA();
      const p = pay(A, file.id, 'intake');
      let finished = false;
      let abortedByLoss = false;
      await enqueueStage(db().app, p);
      const r = await startKillableRunner(
        {
          intake: async (_job, ctx) => {
            // Longer than the 3 second lease: only the timer heartbeats keep it alive.
            await wait(4500);
            ctx.signal.addEventListener('abort', () => (abortedByLoss = true));
            await ctx.inTenantTx((tx) => ctx.complete(tx));
            finished = true;
          },
        },
        { leaseSeconds: 3 },
      );
      await until(() => finished, 20_000);
      expect(finished).toBe(true);
      expect(await stageRunState(db().app, p)).toBe('completed');
      expect(abortedByLoss).toBe(false);
      await r.kill();
    }, 40_000);

    it('aborts ctx.signal when the lease is lost mid-handler', async () => {
      const file = await newCaseA();
      const p = pay(A, file.id, 'intake');
      let aborted = false;
      let started = false;
      await enqueueStage(db().app, p);
      const r = await startKillableRunner(
        {
          intake: async (_job, ctx) => {
            started = true;
            await new Promise<void>((resolve) => {
              ctx.signal.addEventListener('abort', () => {
                aborted = true;
                resolve();
              });
            });
          },
        },
        { leaseSeconds: 3 },
      );
      await until(() => started);
      await expireLease(p);
      await until(() => aborted, 10_000);
      expect(aborted).toBe(true);
      await r.kill();
    }, 40_000);
  });

  describe('attempt numbers and stale jobs', () => {
    it('a reused attempt number cannot silently skip a new stage visit', async () => {
      const file = await newCaseA();
      for (const s of ['map', 'arraign', 'defense', 'prosecution', 'remedy', 'verify'] as const) {
        await storeA.transition(file.id, s);
      }
      const first = pay(A, file.id, 'verify', 1);
      await enqueueStage(db().app, first);
      const token = await claimStageRun(db().worker, first, 'w1', 60);
      expect(await completeStageRun(db().app, first, token!)).toBe(true);
      // verify -> remedy -> verify: a new visit. Reusing attempt 1 is refused loudly.
      await storeA.transition(file.id, 'remedy');
      await storeA.transition(file.id, 'verify');
      await expect(enqueueStage(db().app, first)).rejects.toThrow(/earlier visit/);
      expect(await resumeDecision(pools(), first)).toBe('done');
      // A fresh attempt number for the new visit works.
      const second = pay(A, file.id, 'verify', 2);
      expect(await enqueueStage(db().app, second)).toBe(true);
      expect(await claimStageRun(db().worker, second, 'w1', 60)).toEqual(expect.any(String));
    }, 60_000);

    it('claim refuses a job that can no longer run, and the refusal fails the job', async () => {
      // Case moved to another stage after enqueue.
      const moved = await newCaseA();
      const a = pay(A, moved.id, 'intake');
      await enqueueStage(db().app, a);
      await storeA.transition(moved.id, 'map');
      await expect(claimStageRun(db().worker, a, 'w', 60)).rejects.toThrow(
        /is at stage map, not intake/,
      );
      // Case left the visit (verify, remedy, verify) after an unclaimed enqueue.
      const looped = await newCaseA();
      for (const s of ['map', 'arraign', 'defense', 'prosecution', 'remedy', 'verify'] as const) {
        await storeA.transition(looped.id, s);
      }
      const v1 = pay(A, looped.id, 'verify', 1);
      await enqueueStage(db().app, v1);
      await storeA.transition(looped.id, 'remedy');
      await storeA.transition(looped.id, 'verify');
      await expect(claimStageRun(db().worker, v1, 'w', 60)).rejects.toThrow(/earlier visit/);
      // A later attempt exists for the visit.
      const sup = await newCaseA();
      const s1 = pay(A, sup.id, 'intake', 1);
      await enqueueStage(db().app, s1);
      await enqueueStage(db().app, { ...s1, attempt: 2 });
      await expect(claimStageRun(db().worker, s1, 'w', 60)).rejects.toThrow(/superseded/);
      // Another attempt of the visit is still open.
      const s2 = { ...s1, attempt: 2 };
      expect(await claimStageRun(db().worker, s2, 'w', 60)).toEqual(expect.any(String));
      await enqueueStage(db().app, { ...s1, attempt: 3 });
      await expect(claimStageRun(db().worker, { ...s1, attempt: 3 }, 'w', 60)).rejects.toThrow(
        /another attempt of stage intake is still open/,
      );
      // And through the real worker the refused job fails and is listed.
      const viaWorker = await newCaseA();
      const w = pay(A, viaWorker.id, 'intake', 1);
      await enqueueStage(db().app, w);
      await storeA.transition(viaWorker.id, 'map');
      const ran: number[] = [];
      await runWorker(
        {
          intake: (job) => {
            ran.push(job.attempt);
            return Promise.resolve();
          },
        },
        () => false,
      );
      expect(ran).toEqual([]);
      const failed = await listFailedStageJobs(db().worker);
      expect(failed.find((j) => j.key === stageJobKey(w))?.lastError).toMatch(/is at stage map/);
      // An unclaimed queued job is never adopted while it can still run; once it has failed the
      // case having left the stage means adopt-complete (nothing left to do).
      expect(await resumeDecision(pools(), w)).toBe('adopt-complete');
    }, 90_000);

    it('a stale-looking job whose attempt still holds a live lease is running, not stale', async () => {
      const file = await newCaseA();
      const p = pay(A, file.id, 'intake');
      await enqueueStage(db().app, p);
      const hang: StageHandler = () => new Promise<void>(() => undefined);
      const r1 = await startKillableRunner({ intake: hang }, { leaseSeconds: 60 });
      await until(async () => (await stageRunState(db().app, p)) === 'running');
      await ageJobLock(p);
      expect(await stageJobState(db().worker, p)).toBe('running');
      expect((await listFailedStageJobs(db().worker)).some((j) => j.key === stageJobKey(p))).toBe(
        false,
      );
      await expireLease(p);
      expect(await stageJobState(db().worker, p)).toBe('stale');
      await r1.kill();
    }, 60_000);

    it('stage history is written by the database; the application role cannot insert it', async () => {
      const file = await newCaseA();
      await storeA.transition(file.id, 'map');
      const { rows } = await db().admin.query<{ stage: string; ordinal: number }>(
        `select stage, ordinal from stages where case_id = $1 order by ordinal`,
        [file.id],
      );
      expect(rows).toEqual([
        { stage: 'intake', ordinal: 1 },
        { stage: 'map', ordinal: 2 },
      ]);
      expect(
        await appSql(
          `insert into stages (tenant_id, case_id, ordinal, stage) values ('${A}', '${file.id}', 3, 'map')`,
        ),
      ).toMatch(/permission denied/);
    });
  });

  describe('real kill and resume', () => {
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

  it('aborts ctx.signal when heartbeats fail with a database error, or never answer', async () => {
    for (const kind of ['error', 'hang'] as const) {
      const file = await newCaseA();
      const p = pay(A, file.id, 'intake');
      await enqueueStage(db().app, p);
      // An app pool whose connections cannot be had: an outage, or a cut network.
      const broken = {
        connect: () =>
          kind === 'error' ? Promise.reject(new Error('db down')) : new Promise(() => undefined),
      } as unknown as AppPool;
      let aborted = false;
      const runner = await run({
        pgPool: db().worker,
        concurrency: 1,
        noHandleSignals: true,
        pollInterval: 100,
        taskList: stageTaskList(
          scoped({
            intake: async (_job, ctx) => {
              await new Promise<void>((resolve) => {
                ctx.signal.addEventListener('abort', () => {
                  aborted = true;
                  resolve();
                });
              });
            },
          }),
          { appPool: broken, workerPool: db().worker, leaseSeconds: 3, log: () => undefined },
        ),
      });
      await until(() => aborted, 15_000);
      expect(aborted, kind).toBe(true);
      // With the app pool hanging the wrapper cannot finish either; do not wait for it.
      void runner.stop().catch(() => undefined);
    }
  }, 60_000);

  it('one concurrent enqueue wins: exactly one caller is told the job was added', async () => {
    const file = await newCaseA();
    const p = pay(A, file.id, 'intake');
    const results = await Promise.all(Array.from({ length: 5 }, () => enqueueStage(db().app, p)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await jobKeys()).filter((k) => k === stageJobKey(p))).toHaveLength(1);
  });

  it('adoption is refused in SQL while the case is still at the stage visit', async () => {
    const file = await newCaseA();
    const p = pay(A, file.id, 'intake');
    await enqueueStage(db().app, p);
    await claimStageRun(db().worker, p, 'w1', 60);
    await expireLease(p);
    // Expired lease, but the case never left intake: adopting would hide an unfinished stage.
    expect(await completeStageRun(db().app, p)).toBe(false);
    expect(await resumeDecision(pools(), p)).toBe('next-attempt');
    await storeA.transition(file.id, 'map');
    expect(await completeStageRun(db().app, p)).toBe(true);
  });

  it('a job whose lock Graphile reset (attempts used up, no lock, no error) is failed, not queued forever', async () => {
    const file = await newCaseA();
    const p = pay(A, file.id, 'intake');
    await enqueueStage(db().app, p);
    // What graphile-worker 0.18 leaves after resetLockedAt on a job locked for over 4 hours.
    await db().admin.query(
      `update graphile_worker._private_jobs
       set attempts = max_attempts, locked_at = null, locked_by = null, last_error = null
       where key = $1`,
      [stageJobKey(p)],
    );
    expect(await stageJobState(db().worker, p)).toBe('failed');
    expect(
      (await listFailedStageJobs(db().worker)).find((j) => j.key === stageJobKey(p))?.reason,
    ).toBe('failed');
    expect(await resumeDecision(pools(), p)).toBe('next-attempt');
    expect(await enqueueStage(db().app, p)).toBe(false);
    expect(await enqueueStage(db().app, { ...p, attempt: 2 })).toBe(true);
  });

  it('a stale-locked job whose attempt completed is not listed as dead', async () => {
    const file = await newCaseA();
    const p = pay(A, file.id, 'intake');
    await enqueueStage(db().app, p);
    const token = await claimStageRun(db().worker, p, 'w', 60);
    await completeStageRun(db().app, p, token!);
    await db().admin.query(
      `update graphile_worker._private_jobs
       set attempts = 1, locked_at = now() - interval '2 hours', locked_by = 'x' where key = $1`,
      [stageJobKey(p)],
    );
    expect((await listFailedStageJobs(db().worker, 60)).some((j) => j.key === stageJobKey(p))).toBe(
      false,
    );
    expect(await stageJobState(db().worker, p, 60)).toBe('running');
  });

  it('a malformed job payload does not break the failed-job list', async () => {
    await db().worker.query(
      `select graphile_worker.add_job('case-stage:intake',
         '{"tenantId":"x","caseId":"y","stage":"intake","attempt":"abc"}'::json,
         max_attempts => 1, job_key => 'malformed-1')`,
    );
    await db().admin.query(
      `update graphile_worker._private_jobs
       set attempts = 1, locked_at = now() - interval '2 hours', locked_by = 'dead'
       where key = 'malformed-1'`,
    );
    const listed = await listFailedStageJobs(db().worker, 60);
    expect(listed.find((j) => j.key === 'malformed-1')?.reason).toBe('stale-lock');
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
