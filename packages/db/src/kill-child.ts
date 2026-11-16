/**
 * Test helper, not part of the package API: a stage worker in its own process, so a test can
 * SIGKILL it and let a real lease expire. It has its own app and worker pools. Configured by
 * environment (CHILD_*) and reports on stdout, one line per event.
 *
 * Modes: `hang` (start the attempt, then never return), `work-then-hang` (move the case on with
 * PgCaseStore, then hang), `hang-claim` (die before the claim can answer), `complete` (finish the
 * attempt in its own transaction).
 */
import { run } from 'graphile-worker';
import { PgCaseStore } from './case-store.js';
import { stageTaskList, type StageHandler } from './queue.js';
import { openPool, type WorkerPool } from './tenant.js';

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name}`);
  return v;
}

async function main(): Promise<void> {
  const mode = env('CHILD_MODE');
  const caseId = env('CHILD_CASE');
  const tenant = env('CHILD_TENANT');
  const leaseSeconds = Number(env('CHILD_LEASE'));
  const appPool = await openPool(env('CHILD_APP_URL'), 'affidavit_app');
  const workerPool = await openPool(env('CHILD_WORKER_URL'), 'affidavit_worker');
  const store = new PgCaseStore(appPool, tenant);
  const handler: StageHandler = async (job, ctx) => {
    // Jobs left over from other tests are not this child's business.
    if (job.caseId !== caseId) return;
    console.log(`STARTED ${job.attempt}`);
    if (mode === 'work-then-hang') {
      await store.transition(job.caseId, 'map');
      console.log('WORKED');
    }
    if (mode === 'complete') {
      await ctx.inTenantTx((tx) => ctx.complete(tx));
      console.log(`DONE ${job.attempt}`);
      return;
    }
    await new Promise<void>(() => undefined);
  };
  // Crashing before the claim: the claim connection never answers.
  const claimPool =
    mode === 'hang-claim'
      ? ({ query: () => new Promise(() => undefined) } as unknown as WorkerPool)
      : workerPool;
  await run({
    pgPool: workerPool,
    concurrency: 1,
    noHandleSignals: true,
    pollInterval: 100,
    taskList: stageTaskList(
      { intake: handler },
      {
        appPool,
        workerPool: claimPool,
        workerId: `child-${process.pid}`,
        leaseSeconds,
        log: () => undefined,
      },
    ),
  });
  console.log('READY');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
