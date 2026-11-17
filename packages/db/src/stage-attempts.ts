import {
  CaseFile as CaseFileSchema,
  CaseId,
  type CaseFile,
  type CaseFileSource,
  type CaseStage,
} from '@affidavit/contracts';
import { and, eq, sql } from 'drizzle-orm';
import * as t from './schema.js';
import { withTenant, type AppPool, type WorkerPool } from './tenant.js';

export interface StageAttemptState {
  /** cases.stage now. */
  stage: CaseStage;
  /** The stage-history ordinal of the current visit. */
  visit: number;
  /** The highest attempt enqueued for this stage during THIS visit, or null if none. */
  latestAttempt: number | null;
  /**
   * The attempt number to enqueue next: one more than the highest used for this case and stage in
   * ANY visit (enqueue_stage refuses to reuse a number from an earlier visit), at least 1.
   */
  nextAttempt: number;
}

/** Where a case stands in its queue, for the orchestration. Read as one tenant. */
export async function stageAttemptState(
  appPool: AppPool,
  tenantId: string,
  caseId: string,
): Promise<StageAttemptState> {
  return withTenant(appPool, tenantId, async (tx) => {
    const [c] = await tx
      .select({ stage: t.cases.stage })
      .from(t.cases)
      .where(and(eq(t.cases.tenantId, tenantId), eq(t.cases.id, caseId)));
    if (!c) throw new Error(`unknown case ${caseId}`);
    const [v] = await tx
      .select({ visit: sql<number>`coalesce(max(${t.stages.ordinal}), 0)::int` })
      .from(t.stages)
      .where(and(eq(t.stages.tenantId, tenantId), eq(t.stages.caseId, caseId)));
    const visit = v?.visit ?? 0;
    const [a] = await tx
      .select({
        any: sql<number | null>`max(${t.stageJobs.attempt})::int`,
        current: sql<
          number | null
        >`max(${t.stageJobs.attempt}) filter (where ${t.stageJobs.visit} = ${visit})::int`,
      })
      .from(t.stageJobs)
      .where(
        and(
          eq(t.stageJobs.tenantId, tenantId),
          eq(t.stageJobs.caseId, caseId),
          eq(t.stageJobs.stage, c.stage),
        ),
      );
    return {
      stage: c.stage as CaseStage,
      visit,
      latestAttempt: a?.current ?? null,
      nextAttempt: (a?.any ?? 0) + 1,
    };
  });
}

export type ReviewReason = 'attempts-exhausted' | 'budget-exhausted';

/**
 * Records that a person has to look at a case stage (insert-only, once per attempt). Returns true
 * when the row is new. The case is left where it is; this never dismisses anything.
 */
export async function flagForReview(
  appPool: AppPool,
  p: { tenantId: string; caseId: string; stage: CaseStage; attempt: number },
  reason: ReviewReason,
  detail: string,
): Promise<boolean> {
  return withTenant(appPool, p.tenantId, async (tx) => {
    const rows = await tx
      .insert(t.reviewFlags)
      .values({
        tenantId: p.tenantId,
        caseId: p.caseId,
        stage: p.stage,
        attempt: p.attempt,
        reason,
        detail,
      })
      .onConflictDoNothing()
      .returning({ attempt: t.reviewFlags.attempt });
    return rows.length > 0;
  });
}

/** True when any attempt of this case stage was flagged for review. */
export async function isFlaggedForReview(
  appPool: AppPool,
  tenantId: string,
  caseId: string,
  stage: CaseStage,
): Promise<boolean> {
  return withTenant(appPool, tenantId, async (tx) => {
    const rows = await tx
      .select({ attempt: t.reviewFlags.attempt })
      .from(t.reviewFlags)
      .where(
        and(
          eq(t.reviewFlags.tenantId, tenantId),
          eq(t.reviewFlags.caseId, caseId),
          eq(t.reviewFlags.stage, stage),
        ),
      )
      .limit(1);
    return rows.length > 0;
  });
}

export interface OpenCase {
  tenantId: string;
  caseId: CaseId;
  stage: CaseStage;
}

/**
 * Non-terminal cases not flagged for review at their current stage, across tenants, oldest
 * update first (list_open_cases(), worker role only). Ids and stage only. Bounded by `limit`
 * (at most 1000); a deployment with more open cases than that needs paging.
 */
export async function listOpenCases(workerPool: WorkerPool, limit = 500): Promise<OpenCase[]> {
  const { rows } = await workerPool.query<{ tenant_id: string; case_id: string; stage: string }>(
    'select tenant_id, case_id, stage from public.list_open_cases($1)',
    [limit],
  );
  return rows.map((r) => ({
    tenantId: r.tenant_id,
    caseId: CaseId.parse(r.case_id),
    stage: r.stage as CaseStage,
  }));
}

/** CaseFileSource over the cases table, read as one tenant: a keyed read, no scan. */
export class PgCaseFileSource implements CaseFileSource {
  constructor(
    private readonly pool: AppPool,
    private readonly tenantId: string,
  ) {}

  next(): Promise<CaseFile | null> {
    return Promise.reject(new Error('PgCaseFileSource.next is not supported'));
  }

  async get(caseId: CaseId): Promise<CaseFile | null> {
    return withTenant(this.pool, this.tenantId, async (tx) => {
      const [row] = await tx
        .select({ caseFile: t.cases.caseFile })
        .from(t.cases)
        .where(and(eq(t.cases.tenantId, this.tenantId), eq(t.cases.id, caseId)));
      return row ? CaseFileSchema.parse(row.caseFile) : null;
    });
  }
}
