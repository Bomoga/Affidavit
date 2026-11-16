import { CaseId, CaseStage, TenantId } from '@affidavit/contracts';
import { and, eq, sql } from 'drizzle-orm';
import type { TaskList } from 'graphile-worker';
import type pg from 'pg';
import * as t from './schema.js';
import { claimStageRun, completeStageRun } from './stage-runs.js';
import { withTenant } from './tenant.js';

/** What a stage job carries: ids only, never case content. */
export interface StagePayload {
  tenantId: string;
  caseId: CaseId;
  stage: CaseStage;
  /** Logical attempt, 1-based. A retry is a new attempt and must charge its budget first. */
  attempt: number;
}

/** One Graphile Worker task per case stage. */
export function stageTaskIdentifier(stage: CaseStage): string {
  return `case-stage:${CaseStage.parse(stage)}`;
}

export function parseStagePayload(input: unknown): StagePayload {
  if (typeof input !== 'object' || input === null)
    throw new Error('stage payload must be an object');
  const o = input as Record<string, unknown>;
  const attempt = o.attempt;
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) {
    throw new Error('stage payload attempt must be an integer of at least 1');
  }
  return {
    tenantId: TenantId.parse(o.tenantId),
    caseId: CaseId.parse(o.caseId),
    stage: CaseStage.parse(o.stage),
    attempt,
  };
}

/**
 * Idempotency key: tenant, case, stage and attempt, as a JSON array so the parts stay
 * unambiguous whatever characters the ids contain. The enqueue_stage() SQL wrapper builds the
 * same string; a test keeps the two equal.
 */
export function stageJobKey(p: StagePayload): string {
  return JSON.stringify([p.tenantId, p.caseId, p.stage, p.attempt]);
}

/**
 * Enqueue the job for a case stage as `tenantId`. The application role cannot touch the queue
 * tables: this calls the SECURITY DEFINER enqueue_stage(), which takes the tenant from the
 * transaction setting (never from an argument) and so can only enqueue for that tenant. The case
 * must exist for the tenant. Repeating the call for the same key does nothing while the job is
 * queued, running or failed; once the job has finished, the stage_runs claim stops a second run.
 */
export async function enqueueStage(pool: pg.Pool, p: StagePayload): Promise<void> {
  const payload = parseStagePayload(p);
  await withTenant(pool, payload.tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: t.cases.id })
      .from(t.cases)
      .where(and(eq(t.cases.tenantId, payload.tenantId), eq(t.cases.id, payload.caseId)));
    if (!row) throw new Error(`unknown case ${payload.caseId}`);
    await tx.execute(
      sql`select public.enqueue_stage(${payload.caseId}, ${payload.stage}, ${payload.attempt})`,
    );
  });
}

export type StageHandler = (job: StagePayload) => Promise<void>;

/**
 * Task list for graphile-worker's `run` (on the worker-role pool): one task per stage that has a
 * handler. `appPool` is the application-role pool, used only for the stage_runs claim.
 *
 * Semantics: the attempt is claimed before the handler runs, so a handler starts at most once per
 * (tenant, case, stage, attempt). A second delivery, or a re-enqueue after the job finished, is
 * skipped. If the process dies mid-handler the attempt stays `running` and is never started
 * again; the orchestrator resumes by charging budget and enqueueing the next attempt.
 */
export function stageTaskList(
  handlers: Partial<Record<CaseStage, StageHandler>>,
  appPool: pg.Pool,
): TaskList {
  const list: TaskList = {};
  for (const stage of CaseStage.options) {
    const handler = handlers[stage];
    if (!handler) continue;
    list[stageTaskIdentifier(stage)] = async (raw) => {
      const job = parseStagePayload(raw);
      if (job.stage !== stage) throw new Error(`payload stage ${job.stage} on task for ${stage}`);
      if (!(await claimStageRun(appPool, job))) return;
      await handler(job);
      await completeStageRun(appPool, job);
    };
  }
  return list;
}
