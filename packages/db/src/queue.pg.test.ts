import { expect, it } from 'vitest';
import { run, makeWorkerUtils } from 'graphile-worker';
import { enqueueStage, stageJobKey, stageTaskList, type StagePayload } from './queue.js';
import { describePg, useTestDatabase } from './test-support.js';

describePg('stage queue (Graphile Worker)', () => {
  const db = useTestDatabase();

  const payload: StagePayload = {
    tenantId: 'tenant-q',
    caseId: 'case-q1' as never,
    stage: 'map',
    attempt: 1,
  };

  async function jobCount(key: string): Promise<number> {
    const { rows } = await db().admin.query<{ n: string }>(
      `select count(*)::text as n from graphile_worker.jobs where key = $1`,
      [key],
    );
    return Number(rows[0]!.n);
  }

  it('enqueueing the same case, stage and attempt twice yields one job', async () => {
    const utils = await makeWorkerUtils({ pgPool: db().app });
    try {
      await enqueueStage(utils, payload);
      await enqueueStage(utils, payload);
      expect(await jobCount(stageJobKey(payload))).toBe(1);
      await enqueueStage(utils, { ...payload, attempt: 2 });
      await enqueueStage(utils, { ...payload, stage: 'arraign' });
      const { rows } = await db().admin.query<{ n: string }>(
        `select count(*)::text as n from graphile_worker.jobs`,
      );
      expect(Number(rows[0]!.n)).toBe(3);
    } finally {
      await utils.release();
    }
  });

  it('runs one job per stage through the real worker, once', async () => {
    const seen: StagePayload[] = [];
    const utils = await makeWorkerUtils({ pgPool: db().app });
    const p: StagePayload = { ...payload, caseId: 'case-q2' as never, stage: 'defense' };
    await enqueueStage(utils, p);
    await enqueueStage(utils, p);
    const runner = await run({
      pgPool: db().app,
      concurrency: 1,
      noHandleSignals: true,
      pollInterval: 100,
      taskList: stageTaskList({
        defense: (job) => {
          seen.push(job);
          return Promise.resolve();
        },
      }),
    });
    try {
      const deadline = Date.now() + 15_000;
      while (seen.length === 0 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      await runner.stop();
      await utils.release();
    }
    expect(seen).toEqual([p]);
  }, 30_000);
});
