import { randomUUID } from 'node:crypto';
import { CaseId, CaseStage, TenantId } from '@affidavit/contracts';
import { and, eq, sql } from 'drizzle-orm';
import type { TaskList } from 'graphile-worker';
import type pg from 'pg';
import * as t from './schema.js';
import {
  claimStageRun,
  completeStageRun,
  completeStageRunIn,
  failStageRun,
  heartbeatStageRun,
} from './stage-runs.js';
import { withTenant, type Tx } from './tenant.js';

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
 * transaction setting (never an argument), checks the case exists for it, records a durable
 * stage_jobs row, and queues the job.
 *
 * Returns true when a job was added. False means the same key is already queued, running, or
 * FAILED before it could claim (max_attempts is 1, so a failed job stays in the queue and dedupes
 * the key). Callers must not treat false as "will run": check stageRunState, and for an
 * 'unclaimed' attempt with a failed job (see listFailedStageJobs) move to the next attempt.
 */
export async function enqueueStage(pool: pg.Pool, p: StagePayload): Promise<boolean> {
  const payload = parseStagePayload(p);
  return withTenant(pool, payload.tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: t.cases.id })
      .from(t.cases)
      .where(and(eq(t.cases.tenantId, payload.tenantId), eq(t.cases.id, payload.caseId)));
    if (!row) throw new Error(`unknown case ${payload.caseId}`);
    const r = await tx.execute(
      sql`select public.enqueue_stage(${payload.caseId}, ${payload.stage}, ${payload.attempt}) as added`,
    );
    return (r.rows[0] as { added: boolean }).added;
  });
}

export interface FailedStageJob {
  key: string;
  attempts: number;
  lastError: string | null;
}

/**
 * Queue jobs that exhausted their single attempt with an error, including ones that failed before
 * claiming (a forged payload, a database outage). Read as the worker role. Surface these; a
 * failed job keeps its key, so the same attempt cannot be enqueued again.
 */
export async function listFailedStageJobs(workerPool: pg.Pool): Promise<FailedStageJob[]> {
  const { rows } = await workerPool.query<{
    key: string;
    attempts: number;
    last_error: string | null;
  }>(
    `select key, attempts, last_error from graphile_worker.jobs
     where attempts >= max_attempts and last_error is not null and locked_at is null
     order by id`,
  );
  return rows.map((r) => ({ key: r.key, attempts: r.attempts, lastError: r.last_error }));
}

export interface StageContext {
  workerId: string;
  /** Run work in a transaction scoped to the job's tenant (row-level security applies). */
  inTenantTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Complete this attempt inside `tx`. Call it in the handler's own final transaction, after its
   * last writes, so "the work happened" and "the attempt is complete" commit together: a kill
   * can no longer fall between them. If the attempt is not open any more it throws, rolling the
   * transaction back.
   */
  complete(tx: Tx): Promise<void>;
  /** Extend the lease while a long handler runs. */
  heartbeat(): Promise<boolean>;
}

export type StageHandler = (job: StagePayload, ctx: StageContext) => Promise<void>;

export interface StageTaskOptions {
  /** Application-role pool: tenant tables (completion, failure, heartbeat). */
  appPool: pg.Pool;
  /** Worker-role pool: the claim function. */
  workerPool: pg.Pool;
  /** Identifies this process in leases. Default: a random id per call. */
  workerId?: string;
  leaseSeconds?: number;
}

/**
 * Task list for graphile-worker's `run` (on the worker-role pool): one task per stage that has a
 * handler.
 *
 * Semantics: the claim goes through claim_stage_run(), which refuses a payload that does not
 * match a stage_jobs record (the job fails and shows in listFailedStageJobs). A claimed attempt
 * starts at most once per (tenant, case, stage, attempt); a later delivery is skipped. A handler
 * error marks the attempt failed (failed_at, error) and rethrows. A handler that returns without
 * completing in its own transaction is completed afterwards. If the process dies mid-handler the
 * attempt stays open until its lease expires; the orchestrator then uses resumeDecision.
 */
export function stageTaskList(
  handlers: Partial<Record<CaseStage, StageHandler>>,
  options: StageTaskOptions,
): TaskList {
  const workerId = options.workerId ?? randomUUID();
  const leaseSeconds = options.leaseSeconds ?? 300;
  const list: TaskList = {};
  for (const stage of CaseStage.options) {
    const handler = handlers[stage];
    if (!handler) continue;
    list[stageTaskIdentifier(stage)] = async (raw) => {
      const job = parseStagePayload(raw);
      if (job.stage !== stage) throw new Error(`payload stage ${job.stage} on task for ${stage}`);
      if (!(await claimStageRun(options.workerPool, job, workerId, leaseSeconds))) return;
      const ctx: StageContext = {
        workerId,
        inTenantTx: (fn) => withTenant(options.appPool, job.tenantId, fn),
        complete: (tx) => completeStageRunIn(tx, job, workerId),
        heartbeat: () => heartbeatStageRun(options.appPool, job, workerId, leaseSeconds),
      };
      try {
        await handler(job, ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await failStageRun(options.appPool, job, message, workerId).catch(() => false);
        throw err;
      }
      await completeStageRun(options.appPool, job, workerId);
    };
  }
  return list;
}
