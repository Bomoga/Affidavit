import { and, eq, sql } from 'drizzle-orm';
import type pg from 'pg';
import { stageJobState, type StageJobState, type StagePayload } from './queue.js';
import * as t from './schema.js';
import { withTenant, type Tx } from './tenant.js';

export type StageRunState = 'unclaimed' | 'running' | 'completed' | 'failed';

export interface StageRunInfo {
  state: Exclude<StageRunState, 'unclaimed'>;
  workerId: string;
  visit: number;
  claimedAt: Date;
  heartbeatAt: Date;
  leaseExpiresAt: Date;
  completedAt: Date | null;
  failedAt: Date | null;
  error: string | null;
}

const key = (p: StagePayload) =>
  and(
    eq(t.stageRuns.tenantId, p.tenantId),
    eq(t.stageRuns.caseId, p.caseId),
    eq(t.stageRuns.stage, p.stage),
    eq(t.stageRuns.attempt, p.attempt),
  );

/**
 * Claims a stage attempt as the worker role. The database checks the payload against the
 * stage_jobs record written by enqueue_stage() and refuses (throws) a forged or rewritten job, a
 * job whose case is no longer at that stage or visit, a superseded attempt, or one while another
 * attempt of the visit is open. Returns the SECRET lease token for the one caller that created
 * the run (with a lease of `leaseSeconds`, at most 3600), or null for every later caller.
 * At-most-once start: a claimed attempt is never started again, even after the queue job is gone.
 */
export async function claimStageRun(
  workerPool: pg.Pool,
  p: StagePayload,
  workerId: string,
  leaseSeconds = 300,
): Promise<string | null> {
  const { rows } = await workerPool.query<{ token: string | null }>(
    `select public.claim_stage_run($1, $2, $3, $4, $5, $6) as token`,
    [p.tenantId, p.caseId, p.stage, p.attempt, workerId, leaseSeconds],
  );
  return rows[0]!.token;
}

/**
 * Extends the lease of an open attempt, only with the lease token and only while the lease is
 * still live. Once it has expired the attempt belongs to the orchestrator and cannot be revived.
 * The database enforces this (stage_run_heartbeat); the application role cannot UPDATE stage_runs.
 */
export async function heartbeatStageRun(
  appPool: pg.Pool,
  p: StagePayload,
  token: string,
  leaseSeconds = 300,
): Promise<boolean> {
  return withTenant(appPool, p.tenantId, async (tx) => {
    const r = await tx.execute(
      sql`select public.stage_run_heartbeat(${p.caseId}, ${p.stage}, ${p.attempt}, ${token}, ${leaseSeconds}) as ok`,
    );
    return (r.rows[0] as { ok: boolean }).ok;
  });
}

/**
 * Completes the attempt inside the caller's transaction (stage_run_complete runs in it), so a
 * handler can make its last writes and "the stage is complete" one atomic commit. Needs the lease
 * token and a still-live lease. Throws otherwise (failed, abandoned, expired, already completed),
 * which rolls the caller's work back, so an expired-lease zombie can never complete. Writes made
 * through other ports (PgCaseStore opens its own transactions) are NOT in this transaction: if
 * the process dies after them but before this commit, the attempt stays open and the orchestrator
 * adopts it once the case has left the stage (decideResume, adopt-complete).
 */
export async function completeStageRunIn(tx: Tx, p: StagePayload, token: string): Promise<void> {
  const r = await tx.execute(
    sql`select public.stage_run_complete(${p.caseId}, ${p.stage}, ${p.attempt}, ${token}) as ok`,
  );
  if (!(r.rows[0] as { ok: boolean }).ok) {
    throw new Error(
      `stage run ${p.stage}#${p.attempt} for case ${p.caseId} is not open under a live lease for this token`,
    );
  }
}

/**
 * With `token`: completes the attempt in its own transaction, as the holder with a live lease.
 * Without it: the orchestrator adopting an attempt whose case already left the stage; only an
 * EXPIRED lease may be adopted, never a live one. False when nothing qualified.
 */
export async function completeStageRun(
  appPool: pg.Pool,
  p: StagePayload,
  token?: string,
): Promise<boolean> {
  return withTenant(appPool, p.tenantId, async (tx) => {
    const r = await tx.execute(
      sql`select public.stage_run_complete(${p.caseId}, ${p.stage}, ${p.attempt}, ${token ?? null}) as ok`,
    );
    return (r.rows[0] as { ok: boolean }).ok;
  });
}

/**
 * Records that the attempt failed. With `token` it is the holder reporting its own handler error
 * (allowed whatever the lease says). Without it, it is the orchestrator abandoning the attempt,
 * which is only allowed once the lease has EXPIRED: a live lease is never abandoned. Write-once;
 * false when nothing qualified.
 */
export async function failStageRun(
  appPool: pg.Pool,
  p: StagePayload,
  error: string,
  token?: string,
): Promise<boolean> {
  return withTenant(appPool, p.tenantId, async (tx) => {
    const r = await tx.execute(
      sql`select public.stage_run_fail(${p.caseId}, ${p.stage}, ${p.attempt}, ${error}, ${token ?? null}) as ok`,
    );
    return (r.rows[0] as { ok: boolean }).ok;
  });
}

export async function stageRunInfo(
  appPool: pg.Pool,
  p: StagePayload,
): Promise<StageRunInfo | null> {
  return withTenant(appPool, p.tenantId, async (tx) => {
    // Explicit columns: the application role cannot read the lease token.
    const [row] = await tx
      .select({
        workerId: t.stageRuns.workerId,
        visit: t.stageRuns.visit,
        claimedAt: t.stageRuns.claimedAt,
        heartbeatAt: t.stageRuns.heartbeatAt,
        leaseExpiresAt: t.stageRuns.leaseExpiresAt,
        completedAt: t.stageRuns.completedAt,
        failedAt: t.stageRuns.failedAt,
        error: t.stageRuns.error,
      })
      .from(t.stageRuns)
      .where(key(p));
    if (!row) return null;
    return {
      ...row,
      state: row.completedAt ? 'completed' : row.failedAt ? 'failed' : 'running',
    };
  });
}

export async function stageRunState(appPool: pg.Pool, p: StagePayload): Promise<StageRunState> {
  return (await stageRunInfo(appPool, p))?.state ?? 'unclaimed';
}

export type ResumeAction =
  /** Nothing claimed, no job in flight, and the case is still at this visit: enqueue the attempt. */
  | 'start'
  /**
   * A live lease holds the attempt, or its queue job is still queued or running (it will either
   * claim or be refused at claim and fail): do nothing yet.
   */
  | 'wait'
  /** The attempt is finished: completed, or failed after the case already left the visit. */
  | 'done'
  /**
   * The case has left this stage visit and the lease is gone (or there never was a claim and no
   * job can still run), so the attempt counts as complete and must never be re-run. Adopt it with
   * completeStageRun(pool, p) if it is still open.
   */
  | 'adopt-complete'
  /**
   * The attempt failed, its lease expired with the case still at this visit, or its queue job
   * failed or went stale before claiming. Abandon it with failStageRun(pool, p, 'lease expired')
   * if still open, charge the budget, and enqueue attempt + 1.
   */
  | 'next-attempt';

export interface ResumeInput {
  run: Pick<StageRunInfo, 'state' | 'leaseExpiresAt'> | null;
  /** The queue job for this attempt's key. */
  job: StageJobState;
  /** cases.stage now, and the case's current stage-history ordinal. */
  caseStage: string;
  caseVisit: number;
  /** The stage and the visit (stage-history ordinal) the attempt was enqueued for. */
  jobStage: string;
  jobVisit: number;
  now: Date;
}

/**
 * Pure resume decision for L1-10. An attempt belongs to one visit of a stage: the case has "left"
 * it when the stage differs or the stage-history ordinal moved on, so a case that went
 * verify, remedy, verify again never mistakes the old verify attempt for the new visit (and
 * enqueue_stage refuses to reuse the attempt number for the new visit). A live lease always means
 * wait, even if the case already moved on. An unclaimed attempt whose queue job can still run is
 * never adopted: at claim the database refuses it, which fails the job.
 */
export function decideResume(i: ResumeInput): ResumeAction {
  const left = i.caseStage !== i.jobStage || i.caseVisit !== i.jobVisit;
  if (i.run === null) {
    if (i.job === 'queued' || i.job === 'running') return 'wait';
    if (left) return 'adopt-complete';
    if (i.job === 'failed' || i.job === 'stale') return 'next-attempt';
    return 'start';
  }
  if (i.run.state === 'completed') return 'done';
  if (i.run.state === 'failed') return left ? 'done' : 'next-attempt';
  if (i.run.leaseExpiresAt.getTime() > i.now.getTime()) return 'wait';
  return left ? 'adopt-complete' : 'next-attempt';
}

export interface ResumePools {
  appPool: pg.Pool;
  /** Worker-role pool: reads the queue job state for the attempt. */
  workerPool: pg.Pool;
}

/** Reads the inputs for decideResume from the database and decides. */
export async function resumeDecision(
  pools: ResumePools,
  p: StagePayload,
  options: { now?: Date; staleLockSeconds?: number } = {},
): Promise<ResumeAction> {
  const run = await stageRunInfo(pools.appPool, p);
  const rows = await withTenant(pools.appPool, p.tenantId, async (tx) => {
    const [c] = await tx
      .select({ stage: t.cases.stage })
      .from(t.cases)
      .where(and(eq(t.cases.tenantId, p.tenantId), eq(t.cases.id, p.caseId)));
    if (!c) throw new Error(`unknown case ${p.caseId}`);
    const [v] = await tx
      .select({ visit: sql<number>`coalesce(max(${t.stages.ordinal}), 0)::int` })
      .from(t.stages)
      .where(and(eq(t.stages.tenantId, p.tenantId), eq(t.stages.caseId, p.caseId)));
    const [j] = await tx
      .select({ visit: t.stageJobs.visit })
      .from(t.stageJobs)
      .where(
        and(
          eq(t.stageJobs.tenantId, p.tenantId),
          eq(t.stageJobs.caseId, p.caseId),
          eq(t.stageJobs.stage, p.stage),
          eq(t.stageJobs.attempt, p.attempt),
        ),
      );
    return { caseStage: c.stage, caseVisit: v?.visit ?? 0, jobVisit: j?.visit };
  });
  // An attempt that was never enqueued has nothing to resume: treat the current visit as its own.
  const job = await stageJobState(pools.workerPool, p, options.staleLockSeconds);
  return decideResume({
    run,
    job,
    caseStage: rows.caseStage,
    caseVisit: rows.caseVisit,
    jobStage: p.stage,
    jobVisit: rows.jobVisit ?? rows.caseVisit,
    now: options.now ?? new Date(),
  });
}
