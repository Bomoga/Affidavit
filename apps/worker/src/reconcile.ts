import { TERMINAL_STAGES, type StageCost } from '@affidavit/contracts';
import {
  PgCaseStore,
  completeStageRun,
  enqueueStage,
  failStageRun,
  listFailedStageJobs,
  parseStagePayload,
  resumeDecision,
  type AppPool,
  type StagePayload,
  type WorkerPool,
} from '@affidavit/db';

export interface ReconcileOptions {
  appPool: AppPool;
  workerPool: WorkerPool;
  staleLockSeconds: number;
  /** Total attempts of one stage, the first included. Beyond it a human has to look. */
  maxStageAttempts: number;
  juryEnabled: boolean;
  log?: (message: string) => void;
}

export type ReconcileAction =
  | { kind: 'retried'; payload: StagePayload; nextAttempt: number }
  | { kind: 'adopted'; payload: StagePayload }
  | { kind: 'enqueued'; payload: StagePayload }
  /** Never silently dropped: the case stays where it is and needs a person. */
  | { kind: 'needs-review'; payload: StagePayload; why: string };

function parseKey(key: string): StagePayload | null {
  try {
    const parts: unknown = JSON.parse(key);
    if (!Array.isArray(parts) || parts.length !== 4) return null;
    const [tenantId, caseId, stage, attempt] = parts as unknown[];
    return parseStagePayload({ tenantId, caseId, stage, attempt });
  } catch {
    return null;
  }
}

/**
 * Recovery pass. Finds queue jobs that will never run again (failed, or locked by a dead worker)
 * and applies `resumeDecision` to each: abandon and retry as attempt + 1, or adopt an attempt
 * whose case already moved on and make sure the stage the case is at has a job. Safe to run from
 * several workers at once: enqueueing is idempotent on the attempt key. Two racing workers can
 * both write the (zero-amount) retry charge row; that is conservative, not a duplicate stage.
 */
export async function reconcileOnce(options: ReconcileOptions): Promise<ReconcileAction[]> {
  const actions: ReconcileAction[] = [];
  const failed = await listFailedStageJobs(options.workerPool, options.staleLockSeconds);
  for (const job of failed) {
    const p = parseKey(job.key);
    if (!p) {
      options.log?.(`ignoring a queue job with an unreadable key`);
      continue;
    }
    try {
      await reconcileAttempt(options, p, actions);
    } catch (err) {
      options.log?.(
        `reconcile failed for ${job.key}: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }
  return actions;
}

async function reconcileAttempt(
  o: ReconcileOptions,
  p: StagePayload,
  actions: ReconcileAction[],
): Promise<void> {
  const pools = { appPool: o.appPool, workerPool: o.workerPool };
  const decide = (q: StagePayload) =>
    resumeDecision(pools, q, { staleLockSeconds: o.staleLockSeconds });
  const action = await decide(p);
  if (action === 'adopt-complete') {
    if (await completeStageRun(o.appPool, p)) actions.push({ kind: 'adopted', payload: p });
    await ensureCurrentStageJob(o, p, actions);
    return;
  }
  if (action === 'start') {
    if (await enqueueStage(o.appPool, p)) actions.push({ kind: 'enqueued', payload: p });
    return;
  }
  if (action !== 'next-attempt') return;

  const next = { ...p, attempt: p.attempt + 1 };
  // A later attempt already exists (queued, running, finished): this one is superseded.
  if ((await decide(next)) !== 'start') return;
  if (p.attempt >= o.maxStageAttempts) {
    const why = `stage ${p.stage} used ${p.attempt} of ${o.maxStageAttempts} attempts`;
    if (!actions.some((a) => a.kind === 'needs-review' && a.payload.attempt === p.attempt)) {
      actions.push({ kind: 'needs-review', payload: p, why });
    }
    return;
  }
  // The dead attempt must be abandoned BEFORE the next one is enqueued, or the claim refuses it.
  await failStageRun(o.appPool, p, 'abandoned by reconcile: lease expired or job failed');
  const store = new PgCaseStore(o.appPool, p.tenantId, { juryEnabled: o.juryEnabled });
  const charge: StageCost = {
    stage: p.stage,
    inputTokens: 0,
    outputTokens: 0,
    usd: 0,
    wallMs: 0,
    attempt: next.attempt,
  };
  const budget = await store.chargeBudget(p.caseId, charge);
  if (budget.exhausted) {
    actions.push({ kind: 'needs-review', payload: p, why: 'case budget is exhausted' });
    return;
  }
  if (await enqueueStage(o.appPool, next)) {
    actions.push({ kind: 'retried', payload: p, nextAttempt: next.attempt });
  }
}

/** After adopting an attempt: the stage the case is at now must have a job. */
async function ensureCurrentStageJob(
  o: ReconcileOptions,
  p: StagePayload,
  actions: ReconcileAction[],
): Promise<void> {
  const store = new PgCaseStore(o.appPool, p.tenantId, { juryEnabled: o.juryEnabled });
  const stage = await store.stage(p.caseId);
  if (TERMINAL_STAGES.includes(stage) || stage === p.stage) return;
  await reconcileAttempt(o, { tenantId: p.tenantId, caseId: p.caseId, stage, attempt: 1 }, actions);
}
