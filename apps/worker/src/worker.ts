import { randomUUID } from 'node:crypto';
import {
  openPool,
  reconcileOnce,
  stageTaskList,
  type AppPool,
  type StageHooks,
  type WorkerPool,
} from '@affidavit/db';
import { run } from 'graphile-worker';
import type { WorkerConfig } from './config.js';
import { buildHandlers, prepareCores, type Components } from './handlers.js';

export { startCase } from '@affidavit/db';

export interface RunningWorker {
  appPool: AppPool;
  workerPool: WorkerPool;
  workerId: string;
  stop(): Promise<void>;
}

export interface StartOptions {
  log?: (message: string, err?: unknown) => void;
  workerId?: string;
  hooks?: StageHooks;
  /** Seams for the real wiring (tests inject fakes here); production passes nothing. */
  components?: Components;
}

/**
 * Opens the two role pools, registers the stage handlers on Graphile Worker, and starts the
 * recovery loop (once now, then every reconcileIntervalMs). Wiring only: the handler ordering and
 * the recovery policy live in @affidavit/db.
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
  // Every real component is built and its host prerequisites checked before any connection opens.
  const prepared = await prepareCores(config, { log: (m) => log(m), ...options.components });
  // The app pool serves the handlers (up to `concurrency`, plus a heartbeat each) and the
  // reconcile pass, which holds one connection in its per-case lock while it takes another from
  // this same pool. pg's default size of 10 covers the defaults (concurrency 4 plus one
  // reconciler); raise it if concurrency is raised (see withReconcileLock in @affidavit/db).
  const appPool = await openPool(config.appDatabaseUrl, 'affidavit_app', onPoolError).catch(
    async (err: unknown) => {
      await prepared.close().catch(() => undefined);
      throw err;
    },
  );
  let workerPool: WorkerPool | undefined;
  try {
    workerPool = await openPool(config.workerDatabaseUrl, 'affidavit_worker', onPoolError);
    const handlers = buildHandlers({
      appPool,
      config,
      cores: prepared.cores,
      hooks: options.hooks,
    });
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
        await prepared.close();
      },
    };
  } catch (err) {
    await appPool.end().catch(() => undefined);
    await workerPool?.end().catch(() => undefined);
    await prepared.close().catch(() => undefined);
    throw err;
  }
}
