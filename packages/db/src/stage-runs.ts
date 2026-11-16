import { and, eq, isNull } from 'drizzle-orm';
import type pg from 'pg';
import type { StagePayload } from './queue.js';
import * as t from './schema.js';
import { withTenant } from './tenant.js';

export type StageRunState = 'unclaimed' | 'running' | 'completed';

const key = (p: StagePayload) =>
  and(
    eq(t.stageRuns.tenantId, p.tenantId),
    eq(t.stageRuns.caseId, p.caseId),
    eq(t.stageRuns.stage, p.stage),
    eq(t.stageRuns.attempt, p.attempt),
  );

/**
 * Claims a stage attempt. Returns true for the one caller that inserted the row, false for every
 * later caller. At-most-once start: a claimed attempt is never started again, even after the
 * queue job is gone. The case must exist for the tenant (foreign key under RLS).
 */
export async function claimStageRun(pool: pg.Pool, p: StagePayload): Promise<boolean> {
  return withTenant(pool, p.tenantId, async (tx) => {
    const rows = await tx
      .insert(t.stageRuns)
      .values({ tenantId: p.tenantId, caseId: p.caseId, stage: p.stage, attempt: p.attempt })
      .onConflictDoNothing()
      .returning({ attempt: t.stageRuns.attempt });
    return rows.length === 1;
  });
}

/** Marks a claimed attempt finished. Write-once; false if it was not claimed or already done. */
export async function completeStageRun(pool: pg.Pool, p: StagePayload): Promise<boolean> {
  return withTenant(pool, p.tenantId, async (tx) => {
    const rows = await tx
      .update(t.stageRuns)
      .set({ completedAt: new Date() })
      .where(and(key(p), isNull(t.stageRuns.completedAt)))
      .returning({ attempt: t.stageRuns.attempt });
    return rows.length === 1;
  });
}

/**
 * `running` covers both a live handler and a crashed one: the row alone cannot tell them apart.
 * The orchestrator decides (for example by age) and moves on with a new attempt.
 */
export async function stageRunState(pool: pg.Pool, p: StagePayload): Promise<StageRunState> {
  return withTenant(pool, p.tenantId, async (tx) => {
    const [row] = await tx
      .select({ completedAt: t.stageRuns.completedAt })
      .from(t.stageRuns)
      .where(key(p));
    if (!row) return 'unclaimed';
    return row.completedAt === null ? 'running' : 'completed';
  });
}
