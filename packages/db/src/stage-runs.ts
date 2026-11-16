import { and, eq, isNull, sql } from 'drizzle-orm';
import type pg from 'pg';
import type { StagePayload } from './queue.js';
import * as t from './schema.js';
import { withTenant, type Tx } from './tenant.js';

export type StageRunState = 'unclaimed' | 'running' | 'completed' | 'failed';

export interface StageRunInfo {
  state: Exclude<StageRunState, 'unclaimed'>;
  workerId: string;
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
 * stage_jobs record written by enqueue_stage() and throws for a forged or rewritten job. Returns
 * true for the one caller that created the run (with a lease of `leaseSeconds`), false for every
 * later caller. At-most-once start: a claimed attempt is never started again, even after the
 * queue job is gone.
 */
export async function claimStageRun(
  workerPool: pg.Pool,
  p: StagePayload,
  workerId: string,
  leaseSeconds = 300,
): Promise<boolean> {
  const { rows } = await workerPool.query<{ claimed: boolean }>(
    `select public.claim_stage_run($1, $2, $3, $4, $5, $6) as claimed`,
    [p.tenantId, p.caseId, p.stage, p.attempt, workerId, leaseSeconds],
  );
  return rows[0]!.claimed;
}

/** Extends the lease of a running attempt held by `workerId`. False if it no longer holds it. */
export async function heartbeatStageRun(
  appPool: pg.Pool,
  p: StagePayload,
  workerId: string,
  leaseSeconds = 300,
): Promise<boolean> {
  return withTenant(appPool, p.tenantId, async (tx) => {
    const rows = await tx
      .update(t.stageRuns)
      .set({
        heartbeatAt: sql`now()`,
        leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSeconds})`,
      })
      .where(
        and(
          key(p),
          eq(t.stageRuns.workerId, workerId),
          isNull(t.stageRuns.completedAt),
          isNull(t.stageRuns.failedAt),
        ),
      )
      .returning({ attempt: t.stageRuns.attempt });
    return rows.length === 1;
  });
}

/**
 * Completes the attempt inside the caller's transaction, so a handler can make "the stage's work"
 * and "the stage is complete" one atomic commit. Throws if this worker no longer holds an open
 * attempt (it was failed or abandoned, or already completed), which rolls the caller's work back.
 */
export async function completeStageRunIn(tx: Tx, p: StagePayload, workerId: string): Promise<void> {
  const rows = await tx
    .update(t.stageRuns)
    .set({ completedAt: sql`now()` })
    .where(
      and(
        key(p),
        eq(t.stageRuns.workerId, workerId),
        isNull(t.stageRuns.completedAt),
        isNull(t.stageRuns.failedAt),
      ),
    )
    .returning({ attempt: t.stageRuns.attempt });
  if (rows.length !== 1) {
    throw new Error(
      `stage run ${p.stage}#${p.attempt} for case ${p.caseId} is not open for worker ${workerId}`,
    );
  }
}

/**
 * Completes the attempt in its own transaction. With `workerId` it must be the holder; without it
 * (the orchestrator adopting an attempt whose case already left the stage) any open attempt
 * qualifies. False when it was not open.
 */
export async function completeStageRun(
  appPool: pg.Pool,
  p: StagePayload,
  workerId?: string,
): Promise<boolean> {
  return withTenant(appPool, p.tenantId, async (tx) => {
    const rows = await tx
      .update(t.stageRuns)
      .set({ completedAt: sql`now()` })
      .where(
        and(
          key(p),
          workerId === undefined ? undefined : eq(t.stageRuns.workerId, workerId),
          isNull(t.stageRuns.completedAt),
          isNull(t.stageRuns.failedAt),
        ),
      )
      .returning({ attempt: t.stageRuns.attempt });
    return rows.length === 1;
  });
}

/**
 * Records that the attempt failed (a handler error, or the orchestrator abandoning an expired
 * lease), so a failure is never mistaken for a crash. Write-once; false when it was not open.
 */
export async function failStageRun(
  appPool: pg.Pool,
  p: StagePayload,
  error: string,
  workerId?: string,
): Promise<boolean> {
  return withTenant(appPool, p.tenantId, async (tx) => {
    const rows = await tx
      .update(t.stageRuns)
      .set({ failedAt: sql`now()`, error: error.slice(0, 2000) })
      .where(
        and(
          key(p),
          workerId === undefined ? undefined : eq(t.stageRuns.workerId, workerId),
          isNull(t.stageRuns.completedAt),
          isNull(t.stageRuns.failedAt),
        ),
      )
      .returning({ attempt: t.stageRuns.attempt });
    return rows.length === 1;
  });
}

export async function stageRunInfo(
  appPool: pg.Pool,
  p: StagePayload,
): Promise<StageRunInfo | null> {
  return withTenant(appPool, p.tenantId, async (tx) => {
    const [row] = await tx.select().from(t.stageRuns).where(key(p));
    if (!row) return null;
    return {
      state: row.completedAt ? 'completed' : row.failedAt ? 'failed' : 'running',
      workerId: row.workerId,
      claimedAt: row.claimedAt,
      heartbeatAt: row.heartbeatAt,
      leaseExpiresAt: row.leaseExpiresAt,
      completedAt: row.completedAt,
      failedAt: row.failedAt,
      error: row.error,
    };
  });
}

export async function stageRunState(appPool: pg.Pool, p: StagePayload): Promise<StageRunState> {
  return (await stageRunInfo(appPool, p))?.state ?? 'unclaimed';
}

export type ResumeAction =
  /** Nothing claimed and the case is still at this stage: run the attempt. */
  | 'start'
  /** A live lease holds the attempt: do nothing yet. */
  | 'wait'
  /** The attempt is finished (completed). Nothing to do. */
  | 'done'
  /**
   * The case has already left this stage, so the attempt counts as complete and must never be
   * re-run. Adopt it with completeStageRun(pool, p) if it is still open.
   */
  | 'adopt-complete'
  /**
   * The attempt failed, or its lease expired with the case still at this stage. Abandon it with
   * failStageRun(pool, p, 'lease expired') if still open, charge the budget, and enqueue
   * attempt + 1.
   */
  | 'next-attempt';

export interface ResumeInput {
  run: Pick<StageRunInfo, 'state' | 'leaseExpiresAt'> | null;
  /** cases.stage now. */
  caseStage: string;
  /** The stage the attempt is for. */
  jobStage: string;
  now: Date;
}

/**
 * Pure resume decision for L1-10. "Left the stage" means cases.stage differs from the attempt's
 * stage; a case that loops back to the same stage (verify to remedy to verify) uses a fresh
 * attempt number, and the caller passes the attempt it is resuming.
 */
export function decideResume(i: ResumeInput): ResumeAction {
  const left = i.caseStage !== i.jobStage;
  if (i.run === null) return left ? 'adopt-complete' : 'start';
  if (i.run.state === 'completed') return 'done';
  if (left) return 'adopt-complete';
  if (i.run.state === 'failed') return 'next-attempt';
  return i.run.leaseExpiresAt.getTime() > i.now.getTime() ? 'wait' : 'next-attempt';
}

/** Reads the inputs for decideResume from the database (tenant scoped) and decides. */
export async function resumeDecision(
  appPool: pg.Pool,
  p: StagePayload,
  now: Date = new Date(),
): Promise<ResumeAction> {
  const run = await stageRunInfo(appPool, p);
  const caseStage = await withTenant(appPool, p.tenantId, async (tx) => {
    const [row] = await tx
      .select({ stage: t.cases.stage })
      .from(t.cases)
      .where(and(eq(t.cases.tenantId, p.tenantId), eq(t.cases.id, p.caseId)));
    if (!row) throw new Error(`unknown case ${p.caseId}`);
    return row.stage;
  });
  return decideResume({ run, caseStage, jobStage: p.stage, now });
}
