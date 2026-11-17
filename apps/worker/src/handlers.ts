import { TERMINAL_STAGES, type CaseStage } from '@affidavit/contracts';
import {
  PgCaseStore,
  PgEventSink,
  enqueueStage,
  type AppPool,
  type StageHandler,
} from '@affidavit/db';
import type { WorkerConfig } from './config.js';
import { fakeIntakeCores, fakeJudge, fakeTrialCores } from './fakes/stages.js';
import { GuardedCaseStore, GuardedEventSink, LeaseLostError } from './guard.js';
import { PgCaseFileSource, type StageCore } from './stage.js';

/** Raised at startup for a `real` setting whose implementation has not landed. */
export class NotWiredError extends Error {
  constructor(what: string, pending: string) {
    super(`${what} is configured as "real" but is not wired yet (${pending})`);
    this.name = 'NotWiredError';
  }
}

/** Test seams. Only the kill/resume tests use them; the production entry point passes none. */
export interface HandlerHooks {
  /** Before any stage work is done. */
  beforeStageWork?: (job: { caseId: string; stage: CaseStage; attempt: number }) => Promise<void>;
  /** After the stage work and its case transition, before the next stage job is enqueued. */
  afterStageWork?: (job: { caseId: string; stage: CaseStage; attempt: number }) => Promise<void>;
}

/** The core of every stage, by config. Intake, map, arraign, then the trial stages. */
export function selectCores(config: WorkerConfig): Partial<Record<CaseStage, StageCore>> {
  if (config.intake === 'real') {
    throw new NotWiredError('intake, map and arraign', 'Lane 1 L1-01, L1-05, L1-06');
  }
  if (config.trial === 'real') throw new NotWiredError('trial handlers', 'Lane 3');
  if (config.judge === 'real') throw new NotWiredError('the Judge', 'Lane 2');
  return {
    ...fakeIntakeCores,
    ...fakeTrialCores({ judge: fakeJudge(), juryEnabled: config.juryEnabled }),
  };
}

/**
 * Turns stage work into a queue handler. Order matters (packages/db/CLAUDE.md): the work and the
 * case transition first, then the next stage's job, then completion of this attempt last. Every
 * port write is guarded by the lease signal. A kill anywhere in between is repaired by
 * `reconcile` (adopt the attempt, then enqueue the stage the case is now at).
 */
export function stageHandler(
  core: StageCore,
  options: { appPool: AppPool; config: WorkerConfig; hooks?: HandlerHooks },
): StageHandler {
  const { appPool, config, hooks } = options;
  return async (job, ctx) => {
    const store = new GuardedCaseStore(
      new PgCaseStore(appPool, job.tenantId, { juryEnabled: config.juryEnabled }),
      ctx.signal,
    );
    const sink = new GuardedEventSink(new PgEventSink(appPool, job.tenantId), ctx.signal);
    await hooks?.beforeStageWork?.(job);
    await core({
      job,
      store,
      sink,
      caseFiles: new PgCaseFileSource(appPool, job.tenantId),
      signal: ctx.signal,
    });
    await hooks?.afterStageWork?.(job);
    const now = await store.stage(job.caseId);
    if (now !== job.stage && !TERMINAL_STAGES.includes(now)) {
      if (ctx.signal.aborted) throw new LeaseLostError();
      await enqueueStage(appPool, {
        tenantId: job.tenantId,
        caseId: job.caseId,
        stage: now,
        attempt: 1,
      });
    }
    if (ctx.signal.aborted) throw new LeaseLostError();
    await ctx.inTenantTx((tx) => ctx.complete(tx));
  };
}

export function buildHandlers(options: {
  appPool: AppPool;
  config: WorkerConfig;
  hooks?: HandlerHooks;
}): Partial<Record<CaseStage, StageHandler>> {
  const out: Partial<Record<CaseStage, StageHandler>> = {};
  for (const [stage, core] of Object.entries(selectCores(options.config))) {
    out[stage as CaseStage] = stageHandler(core, options);
  }
  return out;
}
