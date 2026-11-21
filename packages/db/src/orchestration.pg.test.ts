import { sql } from 'drizzle-orm';
import { run } from 'graphile-worker';
import { beforeAll, expect, it } from 'vitest';
import { PgCaseStore } from './case-store.js';
import {
  StageDidNotAdvanceError,
  ensureStageJob,
  openHeldCase,
  reconcileOnce,
  stageHandler,
  type ReconcileOptions,
} from './orchestration.js';
import { enqueueStage, stageTaskList, type StageHandler } from './queue.js';
import {
  PgCaseFileSource,
  flagForReview,
  isFlaggedForReview,
  listOpenCases,
  stageAttemptState,
} from './stage-attempts.js';
import { withTenant } from './tenant.js';
import { BUDGET, describePg, sampleCase, useTestDatabase } from './test-support.js';

const A = 'tenant-oa';
const B = 'tenant-ob';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describePg('stage attempts, review flags, open-case sweep and recovery', () => {
  const db = useTestDatabase([A, B]);
  let storeA: PgCaseStore;
  beforeAll(() => {
    storeA = new PgCaseStore(db().app, A);
  });

  const opts = (over: Partial<ReconcileOptions> = {}): ReconcileOptions => ({
    appPool: db().app,
    workerPool: db().worker,
    staleLockSeconds: 3,
    maxStageAttempts: 3,
    ...over,
  });

  async function until(cond: () => Promise<boolean>, ms = 20_000) {
    const deadline = Date.now() + ms;
    while (!(await cond()) && Date.now() < deadline) await wait(100);
  }

  async function count(query: string): Promise<number> {
    const r = await db().admin.query<{ n: string }>(query);
    return Number(r.rows[0]?.n);
  }

  it('a revisited stage gets a new attempt number, which enqueue_stage accepts', async () => {
    const file = sampleCase(A);
    await storeA.open(file, BUDGET);
    for (const s of ['map', 'arraign', 'defense', 'prosecution', 'remedy'] as const) {
      await storeA.transition(file.id, s);
    }
    expect(
      await enqueueStage(db().app, { tenantId: A, caseId: file.id, stage: 'remedy', attempt: 1 }),
    ).toBe(true);
    await storeA.transition(file.id, 'verify');
    await storeA.transition(file.id, 'remedy'); // an appeal: a second visit to remedy
    const s = await stageAttemptState(db().app, A, file.id);
    expect(s).toMatchObject({ stage: 'remedy', latestAttempt: null, nextAttempt: 2 });
    // Attempt 1 belongs to the earlier visit; enqueue_stage refuses it.
    await expect(
      enqueueStage(db().app, { tenantId: A, caseId: file.id, stage: 'remedy', attempt: 1 }),
    ).rejects.toThrow(/earlier visit/);
    expect(await ensureStageJob(db().app, A, file.id)).toMatchObject({
      stage: 'remedy',
      attempt: 2,
    });
    expect(await ensureStageJob(db().app, A, file.id)).toBeNull();
    expect(await stageAttemptState(db().app, A, file.id)).toMatchObject({
      latestAttempt: 2,
      nextAttempt: 3,
    });
  });

  it('review flags are one per attempt, durable, insert-only and tenant scoped', async () => {
    const file = sampleCase(A);
    await storeA.open(file, BUDGET);
    const p = { tenantId: A, caseId: file.id, stage: 'intake' as const, attempt: 1, visit: 1 };
    expect(await isFlaggedForReview(db().app, A, file.id, 'intake', 1)).toBe(false);
    expect(await flagForReview(db().app, p, 'attempts-exhausted', 'first')).toBe(true);
    expect(await flagForReview(db().app, p, 'budget-exhausted', 'again')).toBe(false);
    expect(await isFlaggedForReview(db().app, A, file.id, 'intake', 1)).toBe(true);
    // A flag is for its own visit only.
    expect(await isFlaggedForReview(db().app, A, file.id, 'intake', 2)).toBe(false);
    expect(await isFlaggedForReview(db().app, B, file.id, 'intake', 1)).toBe(false);
    for (const stmt of [sql`update review_flags set detail = 'x'`, sql`delete from review_flags`]) {
      await expect(withTenant(db().app, A, (tx) => tx.execute(stmt))).rejects.toThrow();
    }
    // A flagged case is no longer listed for sweeping; an unflagged open case is.
    const other = sampleCase(A);
    await storeA.open(other, BUDGET);
    const listed = (await listOpenCases(db().worker)).map((c) => c.caseId);
    expect(listed).toContain(other.id);
    expect(listed).not.toContain(file.id);
    // Only the worker role may list across tenants.
    await expect(
      withTenant(db().app, A, (tx) => tx.execute(sql`select * from public.list_open_cases(10)`)),
    ).rejects.toThrow(/permission denied/);
  });

  it('openHeldCase records an F3 hold durably for a person: flagged, never queued, idempotent', async () => {
    const file = sampleCase(A);
    expect(
      await openHeldCase(db().app, file, BUDGET, 'held: unreachable (route person-or-trial)'),
    ).toBe(true);
    expect(await openHeldCase(db().app, file, BUDGET, 'again')).toBe(false);
    expect(await storeA.stage(file.id)).toBe('intake');
    const flags = await db().admin.query<{ reason: string; detail: string; visit: number }>(
      `select reason, detail, visit from review_flags where case_id = $1`,
      [file.id],
    );
    expect(flags.rows).toEqual([
      { reason: 'f3-hold', detail: 'held: unreachable (route person-or-trial)', visit: 1 },
    ]);
    expect(await count(`select count(*) as n from stage_jobs where case_id = '${file.id}'`)).toBe(
      0,
    );
    const entered = await count(
      `select count(*) as n from events where case_id = '${file.id}' and type = 'stage-entered'`,
    );
    expect(entered).toBe(1);
    // Neither the sweep nor recovery queues it: a person decides.
    const actions = await reconcileOnce(opts());
    expect(actions.filter((a) => a.payload.caseId === file.id)).toEqual([]);
    expect(await count(`select count(*) as n from stage_jobs where case_id = '${file.id}'`)).toBe(
      0,
    );
  });

  it('PgCaseFileSource is a keyed, tenant scoped read', async () => {
    const file = sampleCase(A);
    await storeA.open(file, BUDGET);
    expect(await new PgCaseFileSource(db().app, A).get(file.id)).toEqual(file);
    expect(await new PgCaseFileSource(db().app, B).get(file.id)).toBeNull();
  });

  it('the sweep enqueues a case that was opened but never enqueued, once', async () => {
    const file = sampleCase(A);
    await storeA.open(file, BUDGET); // a crash right after open, before enqueue
    const first = await reconcileOnce(opts());
    expect(first.filter((a) => a.payload.caseId === file.id)).toEqual([
      { kind: 'enqueued', payload: { tenantId: A, caseId: file.id, stage: 'intake', attempt: 1 } },
    ]);
    const second = await reconcileOnce(opts());
    expect(second.filter((a) => a.payload.caseId === file.id)).toEqual([]);
  });

  it('the sweep enqueues the stage a case moved to when its handler failed after the transition', async () => {
    const file = sampleCase(A);
    await storeA.open(file, BUDGET);
    await ensureStageJob(db().app, A, file.id);
    // The handler transitions, then fails (as a lost lease would) before enqueueing the next job.
    const failing: StageHandler = stageHandler(
      async (env) => {
        await env.store.transition(env.job.caseId, 'map');
        throw new Error('lease lost after the transition');
      },
      { appPool: db().app },
    );
    const runner = await run({
      pgPool: db().worker,
      concurrency: 1,
      noHandleSignals: true,
      pollInterval: 100,
      taskList: stageTaskList(
        { intake: (j, c) => (j.caseId === file.id ? failing(j, c) : Promise.resolve()) },
        { appPool: db().app, workerPool: db().worker, leaseSeconds: 3, log: () => undefined },
      ),
    });
    try {
      await until(async () => (await storeA.stage(file.id)) === 'map');
      await until(async () =>
        count(
          `select count(*) n from stage_runs where case_id='${file.id}' and failed_at is not null`,
        ).then((n) => n === 1),
      );
    } finally {
      await runner.stop();
    }
    expect(await stageAttemptState(db().app, A, file.id)).toMatchObject({
      stage: 'map',
      latestAttempt: null,
    });
    const actions = (await reconcileOnce(opts())).filter((a) => a.payload.caseId === file.id);
    expect(actions.some((a) => a.kind === 'enqueued' && a.payload.stage === 'map')).toBe(true);
    expect(await stageAttemptState(db().app, A, file.id)).toMatchObject({
      stage: 'map',
      latestAttempt: 1,
    });
  });

  it('a core that does not move the case fails; retries stop at the cap with a durable flag and no further charges', async () => {
    const file = sampleCase(A);
    await storeA.open(file, BUDGET);
    await ensureStageJob(db().app, A, file.id);
    const idle = stageHandler(() => Promise.resolve(), { appPool: db().app });
    const runner = await run({
      pgPool: db().worker,
      concurrency: 1,
      noHandleSignals: true,
      pollInterval: 100,
      taskList: stageTaskList(
        { intake: (j, c) => (j.caseId === file.id ? idle(j, c) : Promise.resolve()) },
        { appPool: db().app, workerPool: db().worker, leaseSeconds: 3, log: () => undefined },
      ),
    });
    const mine = (r: Awaited<ReturnType<typeof reconcileOnce>>) =>
      r.filter((a) => a.payload.caseId === file.id);
    try {
      const failedRuns = (n: number) => async () =>
        (await count(
          `select count(*) n from stage_runs where case_id='${file.id}' and failed_at is not null`,
        )) >= n;
      await until(failedRuns(1));
      // The runner may fail attempt 2 within the same pass, so collect across passes.
      const seen: ReturnType<typeof mine> = [];
      for (let i = 0; i < 40 && !seen.some((a) => a.kind === 'needs-review'); i++) {
        seen.push(...mine(await reconcileOnce(opts({ maxStageAttempts: 2 }))));
        await wait(150);
      }
      expect(seen).toMatchObject([
        { kind: 'retried', payload: { attempt: 1 }, nextAttempt: 2 },
        { kind: 'needs-review', reason: 'attempts-exhausted', payload: { attempt: 2 } },
      ]);
      await until(failedRuns(2));
    } finally {
      await runner.stop();
    }
    const err = await db().admin.query<{ error: string }>(
      `select error from stage_runs where case_id='${file.id}' and attempt=1`,
    );
    expect(err.rows[0]?.error).toMatch(
      new RegExp(new StageDidNotAdvanceError('intake').message.slice(0, 20)),
    );
    // Nothing more happens, and nothing is charged again, however often recovery runs.
    for (let i = 0; i < 3; i++) {
      expect(mine(await reconcileOnce(opts({ maxStageAttempts: 2 })))).toEqual([]);
    }
    expect(await count(`select count(*) n from stage_jobs where case_id='${file.id}'`)).toBe(2);
    expect(await count(`select count(*) n from cost_rows where case_id='${file.id}'`)).toBe(1);
    expect(await count(`select count(*) n from review_flags where case_id='${file.id}'`)).toBe(1);
    expect(await storeA.stage(file.id)).toBe('intake');
  });

  it('an exhausted budget is flagged for review once instead of being charged every pass', async () => {
    const file = sampleCase(A);
    await storeA.open(file, { maxInputTokens: 0, maxOutputTokens: 0, maxUsd: 0 });
    await ensureStageJob(db().app, A, file.id);
    const idle = stageHandler(() => Promise.resolve(), { appPool: db().app });
    const runner = await run({
      pgPool: db().worker,
      concurrency: 1,
      noHandleSignals: true,
      pollInterval: 100,
      taskList: stageTaskList(
        { intake: (j, c) => (j.caseId === file.id ? idle(j, c) : Promise.resolve()) },
        { appPool: db().app, workerPool: db().worker, leaseSeconds: 3, log: () => undefined },
      ),
    });
    try {
      await until(
        async () =>
          (await count(
            `select count(*) n from stage_runs where case_id='${file.id}' and failed_at is not null`,
          )) >= 1,
      );
    } finally {
      await runner.stop();
    }
    const first = (await reconcileOnce(opts())).filter((a) => a.payload.caseId === file.id);
    expect(first).toEqual([
      expect.objectContaining({ kind: 'needs-review', reason: 'budget-exhausted' }),
    ]);
    for (let i = 0; i < 3; i++) {
      expect((await reconcileOnce(opts())).filter((a) => a.payload.caseId === file.id)).toEqual([]);
    }
    expect(await count(`select count(*) n from cost_rows where case_id='${file.id}'`)).toBe(1);
    expect(await count(`select count(*) n from review_flags where case_id='${file.id}'`)).toBe(1);
  });
});
