import { randomUUID } from 'node:crypto';
import type { Budget, CaseFile } from '@affidavit/contracts';
import {
  PgCaseStore,
  PgEventSink,
  enqueueStage,
  openPool,
  stageTaskList,
  type AppPool,
  type WorkerPool,
} from '@affidavit/db';
import { run } from 'graphile-worker';
import type { WorkerConfig } from './config.js';
import { buildHandlers, type HandlerHooks } from './handlers.js';
import { reconcileOnce } from './reconcile.js';
import { record } from './stage.js';

export interface RunningWorker {
  appPool: AppPool;
  workerPool: WorkerPool;
  workerId: string;
  stop(): Promise<void>;
}

export interface StartOptions {
  log?: (message: string, err?: unknown) => void;
  workerId?: string;
  hooks?: HandlerHooks;
}

/**
 * Opens the two role pools, registers the stage handlers on Graphile Worker, and starts the
 * recovery loop (once now, then every reconcileIntervalMs).
 */
export async function startWorker(
  config: WorkerConfig,
  options: StartOptions = {},
): Promise<RunningWorker> {
  const log =
    options.log ??
    ((message: string, err?: unknown) => {
      console.error(`[worker] ${message}`, err instanceof Error ? err.message : '');
    });
  const workerId = options.workerId ?? randomUUID();
  const onPoolError = (err: Error) => log('database pool error', err);
  // Handlers are built first so a `real` setting that is not wired fails before any connection.
  const appPool = await openPool(config.appDatabaseUrl, 'affidavit_app', onPoolError);
  let workerPool: WorkerPool | undefined;
  try {
    workerPool = await openPool(config.workerDatabaseUrl, 'affidavit_worker', onPoolError);
    const handlers = buildHandlers({ appPool, config, hooks: options.hooks });
    const runner = await run({
      pgPool: workerPool,
      concurrency: config.concurrency,
      noHandleSignals: true,
      pollInterval: config.pollIntervalMs,
      taskList: stageTaskList(handlers, {
        appPool,
        workerPool,
        workerId,
        leaseSeconds: config.leaseSeconds,
        log,
      }),
    });
    const pools = workerPool;
    let reconciling = false;
    const tick = async () => {
      if (reconciling) return;
      reconciling = true;
      try {
        const actions = await reconcileOnce({
          appPool,
          workerPool: pools,
          staleLockSeconds: config.staleLockSeconds,
          maxStageAttempts: config.maxStageAttempts,
          juryEnabled: config.juryEnabled,
          log,
        });
        for (const a of actions) {
          log(`reconcile ${a.kind} case ${a.payload.caseId} stage ${a.payload.stage}`);
        }
      } catch (err) {
        log('reconcile pass failed', err);
      } finally {
        reconciling = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), config.reconcileIntervalMs);
    return {
      appPool,
      workerPool,
      workerId,
      async stop() {
        clearInterval(timer);
        await runner.stop();
        await appPool.end();
        await pools.end();
      },
    };
  } catch (err) {
    await appPool.end().catch(() => undefined);
    await workerPool?.end().catch(() => undefined);
    throw err;
  }
}

/**
 * Registers a case at `intake`, records the first event and enqueues the first stage job. The
 * entry point the API and CLI will call. Not atomic: a crash after `open` leaves a case at
 * intake with no job, which a later retry of this call repairs only if the caller re-enqueues.
 */
export async function startCase(
  appPool: AppPool,
  caseFile: CaseFile,
  budget: Budget,
  options: { juryEnabled?: boolean } = {},
): Promise<void> {
  const store = new PgCaseStore(appPool, caseFile.tenantId, options);
  await store.open(caseFile, budget);
  const sink = new PgEventSink(appPool, caseFile.tenantId);
  await record({ store, sink }, caseFile.id, 'intake', 'stenographer', {
    type: 'stage-entered',
    payload: {},
  });
  await enqueueStage(appPool, {
    tenantId: caseFile.tenantId,
    caseId: caseFile.id,
    stage: 'intake',
    attempt: 1,
  });
}
