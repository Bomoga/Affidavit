import { randomUUID } from 'node:crypto';
import { CaseId, CaseStage, TenantId } from '@affidavit/contracts';
import { and, eq, sql } from 'drizzle-orm';
import type { TaskList } from 'graphile-worker';
import * as t from './schema.js';
import {
  claimStageRun,
  completeStageRun,
  completeStageRunIn,
  failStageRun,
  heartbeatStageRun,
  stageRunInfo,
} from './stage-runs.js';
import { withTenant, type AppPool, type Tx, type WorkerPool } from './tenant.js';

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
 * transaction setting (never an argument), requires the case to be at that stage now (attempts
 * are bounded at 100 per case and stage), records a durable stage_jobs row with the stage visit,
 * and queues the job.
 *
 * Returns true when a job row was added to the queue. That includes re-enqueueing a key whose
 * earlier job FINISHED (Graphile deletes finished jobs): the new job is then skipped at claim
 * because the attempt was already claimed. False means the same key is still in the queue:
 * queued, running, or failed or stuck before it could claim (max_attempts is 1, so such a job
 * keeps its key). Callers must not treat false as "will run": ask resumeDecision, which reads the
 * job's state and says next-attempt for a failed or stale-locked job.
 *
 * Coupling: the duplicate check and stageJobState read graphile_worker._private_jobs and
 * graphile_worker.jobs (columns key, attempts, max_attempts, last_error, locked_at). A test pins
 * those, so a Graphile Worker upgrade that changes them fails loudly.
 */
export async function enqueueStage(pool: AppPool, p: StagePayload): Promise<boolean> {
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

/** A job locked for longer than this with its single attempt used up is treated as dead. */
export const DEFAULT_STALE_LOCK_SECONDS = 600;

export interface FailedStageJob {
  key: string;
  attempts: number;
  lastError: string | null;
  /** `failed`: errored out. `stale-lock`: locked by a worker that never reported back. */
  reason: 'failed' | 'stale-lock';
}

/**
 * Queue jobs that will never run again: those that exhausted their single attempt with an error
 * (including failures before claiming, such as a forged payload, a refused claim or a database
 * outage), and those still locked by a worker that died (locked longer than `staleLockSeconds`
 * with the attempt used up, no error ever recorded, and no live stage-run lease). Read as the
 * worker role. Surface these; such a job keeps its key, so the same attempt cannot be enqueued
 * again and the orchestrator must use the next one.
 */
export async function listFailedStageJobs(
  workerPool: WorkerPool,
  staleLockSeconds = DEFAULT_STALE_LOCK_SECONDS,
): Promise<FailedStageJob[]> {
  const { rows } = await workerPool.query<{
    key: string;
    attempts: number;
    last_error: string | null;
    stale: boolean;
  }>(
    `select key, attempts, last_error, (locked_at is not null) as stale
     from graphile_worker._private_jobs j
     where attempts >= max_attempts
       and ((locked_at is null)
         or (locked_at is not null and locked_at < now() - make_interval(secs => $1)
             and not coalesce(public.stage_run_job_alive(
               j.payload->>'tenantId', j.payload->>'caseId', j.payload->>'stage',
               case when (j.payload->>'attempt') ~ '^[0-9]{1,9}$'
                    then (j.payload->>'attempt')::int end), false)))
     order by id`,
    [staleLockSeconds],
  );
  return rows.map((r) => ({
    key: r.key,
    attempts: r.attempts,
    lastError: r.last_error,
    reason: r.stale ? 'stale-lock' : 'failed',
  }));
}

export type StageJobState = 'none' | 'queued' | 'running' | 'failed' | 'stale';

/**
 * The queue job for a stage attempt's key, as the worker role sees it. `none`: no job (never
 * enqueued, or finished and deleted). `failed`: errored with its attempt used up. `stale`: locked
 * with the attempt used up for longer than `staleLockSeconds`, and no live stage-run lease (the
 * worker died, possibly before claiming). `running`: locked recently, or its attempt still holds
 * a live lease. `queued`: waiting.
 */
export async function stageJobState(
  workerPool: WorkerPool,
  p: StagePayload,
  staleLockSeconds = DEFAULT_STALE_LOCK_SECONDS,
): Promise<StageJobState> {
  const { rows } = await workerPool.query<{
    attempts: number;
    max_attempts: number;
    last_error: string | null;
    locked: boolean;
    stale: boolean;
    live: boolean;
  }>(
    `select attempts, max_attempts, last_error, (locked_at is not null) as locked,
            coalesce(locked_at < now() - make_interval(secs => $2), false) as stale,
            coalesce(public.stage_run_job_alive($3, $4, $5, $6), false) as live
     from graphile_worker._private_jobs where key = $1`,
    [stageJobKey(p), staleLockSeconds, p.tenantId, p.caseId, p.stage, p.attempt],
  );
  const r = rows[0];
  if (!r) return 'none';
  if (r.locked) return r.stale && r.attempts >= r.max_attempts && !r.live ? 'stale' : 'running';
  if (r.attempts >= r.max_attempts) return 'failed';
  return 'queued';
}

export interface StageContext {
  workerId: string;
  /**
   * Aborted when the lease could not be extended (it expired, was abandoned, or the database was
   * unreachable). A well-behaved handler stops its work then; completing would fail anyway.
   */
  signal: AbortSignal;
  /** Run work in a transaction scoped to the job's tenant (row-level security applies). */
  inTenantTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Complete this attempt inside `tx`. Call it in the handler's own final transaction, after its
   * last writes, so "the work happened" and "the attempt is complete" commit together: a kill
   * can no longer fall between them. If the lease is not live any more it throws, rolling the
   * transaction back. Writes made through other ports (PgCaseStore opens its own transactions)
   * are not part of `tx`: a kill after them but before this commit leaves the attempt open, and
   * the orchestrator adopts it once the case has left the stage (resumeDecision, adopt-complete).
   */
  complete(tx: Tx): Promise<void>;
  /** Extend the lease now (the task wrapper also does this on a timer). */
  heartbeat(): Promise<boolean>;
}

export type StageHandler = (job: StagePayload, ctx: StageContext) => Promise<void>;

export interface StageTaskOptions {
  /** Application-role pool: tenant tables (completion, failure, heartbeat). */
  appPool: AppPool;
  /** Worker-role pool: the claim function. */
  workerPool: WorkerPool;
  /** Identifies this process in leases (informational). Default: a random id per call. */
  workerId?: string;
  /** Lease length, 1 to 3600 seconds. The wrapper heartbeats about every third of it. */
  leaseSeconds?: number;
  /** Where ignored outcomes are reported. Default: console.error. */
  log?: (message: string, err?: unknown) => void;
}

/**
 * Task list for graphile-worker's `run` (on the worker-role pool): one task per stage that has a
 * handler.
 *
 * Semantics: the claim goes through claim_stage_run(), which refuses a payload that does not
 * match a stage_jobs record, a job whose case left the stage or visit, a superseded attempt, and
 * a second open attempt (the job fails and shows in listFailedStageJobs). A claimed attempt
 * starts at most once per (tenant, case, stage, attempt); a later delivery is skipped. While the
 * handler runs the wrapper extends the lease every lease/3 seconds and aborts `ctx.signal` if it
 * cannot. A handler error marks the attempt failed (failed_at, error) and rethrows. A handler
 * that returns without completing in its own transaction is completed afterwards. If the process
 * dies mid-handler the attempt stays open until its lease expires; the orchestrator then uses
 * resumeDecision.
 */
export function stageTaskList(
  handlers: Partial<Record<CaseStage, StageHandler>>,
  options: StageTaskOptions,
): TaskList {
  const workerId = options.workerId ?? randomUUID();
  const leaseSeconds = options.leaseSeconds ?? 300;
  const log =
    options.log ??
    ((message: string, err?: unknown) => {
      console.error(`[@affidavit/db] ${message}`, err ?? '');
    });
  const list: TaskList = {};
  for (const stage of CaseStage.options) {
    const handler = handlers[stage];
    if (!handler) continue;
    list[stageTaskIdentifier(stage)] = async (raw) => {
      const job = parseStagePayload(raw);
      if (job.stage !== stage) throw new Error(`payload stage ${job.stage} on task for ${stage}`);
      const claimStartedAt = Date.now();
      const token = await claimStageRun(options.workerPool, job, workerId, leaseSeconds);
      if (token === null) return;
      const abort = new AbortController();
      // The lease expiry we last KNOW about (measured conservatively from when the request that
      // confirmed it started). If we cannot confirm a heartbeat before it, the lease may be gone,
      // so the signal aborts: once that expiry has passed, or after three failures in a row,
      // whether the database answered no, errored, or did not answer at all.
      let confirmedUntil = claimStartedAt + leaseSeconds * 1000;
      let failures = 0;
      const lose = (why: string) => {
        if (!abort.signal.aborted) abort.abort(new Error(why));
      };
      const beat = async (): Promise<boolean> => {
        const startedAt = Date.now();
        try {
          const ok = await heartbeatStageRun(options.appPool, job, token, leaseSeconds);
          if (ok) {
            confirmedUntil = Math.max(confirmedUntil, startedAt + leaseSeconds * 1000);
            failures = 0;
          } else {
            lose('lease lost');
          }
          return ok;
        } catch (err) {
          failures += 1;
          log(`heartbeat failed for ${stageJobKey(job)}`, err);
          if (failures >= 3 || Date.now() >= confirmedUntil) lose('heartbeat failed');
          return false;
        }
      };
      const timer = setInterval(
        () => {
          // A heartbeat that hangs (network cut) never settles, so the expiry is checked here too.
          if (Date.now() >= confirmedUntil)
            lose('lease expiry passed without a confirmed heartbeat');
          void beat();
        },
        Math.max(250, (leaseSeconds * 1000) / 3),
      );
      const ctx: StageContext = {
        workerId,
        signal: abort.signal,
        inTenantTx: (fn) => withTenant(options.appPool, job.tenantId, fn),
        complete: (tx) => completeStageRunIn(tx, job, token),
        heartbeat: beat,
      };
      try {
        try {
          await handler(job, ctx);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          try {
            if (!(await failStageRun(options.appPool, job, message, token))) {
              log(`could not record the failure of ${stageJobKey(job)}: attempt no longer open`);
            }
          } catch (recordErr) {
            log(`could not record the failure of ${stageJobKey(job)}`, recordErr);
          }
          throw err;
        }
        // A handler that completed in its own transaction leaves nothing open, so false is
        // expected then. False for an attempt that is still not completed (an expired lease) is
        // logged, and the attempt stays open for the orchestrator to adopt or abandon.
        if (!(await completeStageRun(options.appPool, job, token))) {
          const info = await stageRunInfo(options.appPool, job).catch(() => null);
          if (info?.state !== 'completed') {
            log(`stage run ${stageJobKey(job)} was not completed after its handler returned`);
          }
        }
      } finally {
        clearInterval(timer);
      }
    };
  }
  return list;
}
