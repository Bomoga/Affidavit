import { run } from 'graphile-worker';
import { beforeAll, describe, expect, it } from 'vitest';
import { PgCaseStore } from './case-store.js';
import { enqueueStage, stageJobKey, stageTaskList, type StagePayload } from './queue.js';
import { claimStageRun, completeStageRun, stageRunState } from './stage-runs.js';
import { BUDGET, describePg, sampleCase, useTestDatabase } from './test-support.js';

const A = 'tenant-qa';
const B = 'tenant-qb';

describePg('stage queue (Graphile Worker)', () => {
  const db = useTestDatabase([A, B]);
  const caseA = sampleCase(A);
  const caseB = sampleCase(B);

  const pay = (tenantId: string, caseId: string, stage: StagePayload['stage'], attempt = 1) =>
    ({ tenantId, caseId, stage, attempt }) as StagePayload;

  beforeAll(async () => {
    await new PgCaseStore(db().app, A).open(caseA, BUDGET);
    await new PgCaseStore(db().app, B).open(caseB, BUDGET);
  }, 60_000);

  async function jobKeys(): Promise<string[]> {
    const { rows } = await db().admin.query<{ key: string }>(
      `select key from graphile_worker.jobs order by key`,
    );
    return rows.map((r) => r.key);
  }

  /** Runs the real worker (worker role) until `done()` or the deadline, then stops it. */
  async function runWorker(
    handlers: Parameters<typeof stageTaskList>[0],
    done: () => boolean,
  ): Promise<void> {
    const runner = await run({
      pgPool: db().worker,
      concurrency: 1,
      noHandleSignals: true,
      pollInterval: 100,
      taskList: stageTaskList(handlers, db().app),
    });
    try {
      const deadline = Date.now() + 15_000;
      while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 600));
    } finally {
      await runner.stop();
    }
  }

  it('enqueueing the same case, stage and attempt twice yields one job, with the TS job key', async () => {
    const p = pay(A, caseA.id, 'map');
    await enqueueStage(db().app, p);
    await enqueueStage(db().app, p);
    expect(await jobKeys()).toEqual([stageJobKey(p)]);
    await enqueueStage(db().app, pay(A, caseA.id, 'map', 2));
    await enqueueStage(db().app, pay(A, caseA.id, 'arraign'));
    expect(await jobKeys()).toHaveLength(3);
  });

  it('a payload for an unknown case is refused', async () => {
    await expect(enqueueStage(db().app, pay(A, caseB.id, 'map'))).rejects.toThrow(/unknown case/);
  });

  it('re-enqueueing after the job completed does not run the stage again', async () => {
    const p = pay(A, caseA.id, 'defense');
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
    await enqueueStage(db().app, p);
    expect((await jobKeys()).includes(stageJobKey(p))).toBe(true);
    await runWorker(handlers, () => false);
    expect(seen).toHaveLength(1);
    expect((await jobKeys()).includes(stageJobKey(p))).toBe(false);
  }, 60_000);

  it('a crash mid-stage is never silently re-run; the next attempt runs', async () => {
    const p = pay(A, caseA.id, 'prosecution');
    const seen: number[] = [];
    const handlers = {
      prosecution: (job: StagePayload) => {
        seen.push(job.attempt);
        if (job.attempt === 1) return Promise.reject(new Error('worker died mid-stage'));
        return Promise.resolve();
      },
    };
    await enqueueStage(db().app, p);
    await runWorker(handlers, () => seen.length > 0);
    expect(seen).toEqual([1]);
    // Claimed but never completed: visible to the orchestrator as `running`.
    expect(await stageRunState(db().app, p)).toBe('running');
    // Delivering attempt 1 again (as a re-delivery would) does not start the handler.
    await db().admin.query(`delete from graphile_worker._private_jobs where key = $1`, [
      stageJobKey(p),
    ]);
    await enqueueStage(db().app, p);
    await runWorker(handlers, () => false);
    expect(seen).toEqual([1]);
    // Resume is an explicit new attempt.
    const next = { ...p, attempt: 2 };
    await enqueueStage(db().app, next);
    await runWorker(handlers, () => seen.length > 1);
    expect(seen).toEqual([1, 2]);
    expect(await stageRunState(db().app, next)).toBe('completed');
  }, 60_000);

  it('claims are at most once, completion is write-once, and they are tenant scoped', async () => {
    const p = pay(A, caseA.id, 'remedy');
    expect(await stageRunState(db().app, p)).toBe('unclaimed');
    expect(await claimStageRun(db().app, p)).toBe(true);
    expect(await claimStageRun(db().app, p)).toBe(false);
    expect(await completeStageRun(db().app, p)).toBe(true);
    expect(await completeStageRun(db().app, p)).toBe(false);
    // Tenant B cannot claim for tenant A's case: the case is not visible to it.
    await expect(claimStageRun(db().app, { ...p, tenantId: B, attempt: 5 })).rejects.toThrow();
  });

  describe('tenant A against the queue', () => {
    it('cannot read, delete, truncate or insert queue tables, or call add_job directly', async () => {
      await enqueueStage(db().app, pay(B, caseB.id, 'map'));
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
      expect((await jobKeys()).some((k) => k.includes(B))).toBe(true);
    });

    it('can enqueue only for itself: the wrapper forces the payload tenant', async () => {
      const c = await db().app.connect();
      try {
        await c.query('begin');
        await c.query(`select set_config('app.tenant_id', $1, true)`, [A]);
        // Even naming tenant B's case id, the job is tagged with tenant A.
        await c.query(`select public.enqueue_stage($1, 'jury', 1)`, [caseB.id]);
        await c.query('commit');
      } finally {
        c.release();
      }
      const { rows } = await db().admin.query<{ key: string; payload: { tenantId: string } }>(
        `select key, payload from graphile_worker._private_jobs where payload->>'caseId' = $1 and payload->>'stage' = 'jury'`,
        [caseB.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload.tenantId).toBe(A);
      expect(rows[0]!.key).toBe(stageJobKey(pay(A, caseB.id, 'jury')));
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

    it('the worker role runs the queue but cannot touch tenant tables or truncate the queue', async () => {
      const c = await db().worker.connect();
      try {
        for (const s of [
          `select * from public.cases`,
          `select * from public.verdicts`,
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
