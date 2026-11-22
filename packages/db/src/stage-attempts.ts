import {
  CaseFile as CaseFileSchema,
  CaseId,
  type CaseFile,
  type CaseFileSource,
  type CaseStage,
} from '@affidavit/contracts';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import * as t from './schema.js';
import { withTenant, type AppPool, type WorkerPool } from './tenant.js';

export interface StageAttemptState {
  /** cases.stage now. */
  stage: CaseStage;
  /** The stage-history ordinal of the current visit. */
  visit: number;
  /** The highest attempt enqueued for this stage during THIS visit, or null if none. */
  latestAttempt: number | null;
  /** How many attempts were enqueued for this stage during THIS visit (the retry budget counts these). */
  visitAttempts: number;
  /** The case's event counter when this visit began: events at or after it belong to the visit. */
  entrySeq: number;
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
      .select({ visit: t.stages.ordinal, entrySeq: t.stages.entrySeq })
      .from(t.stages)
      .where(and(eq(t.stages.tenantId, tenantId), eq(t.stages.caseId, caseId)))
      .orderBy(desc(t.stages.ordinal))
      .limit(1);
    const visit = v?.visit ?? 0;
    const [a] = await tx
      .select({
        any: sql<number | null>`max(${t.stageJobs.attempt})::int`,
        current: sql<
          number | null
        >`max(${t.stageJobs.attempt}) filter (where ${t.stageJobs.visit} = ${visit})::int`,
        inVisit: sql<number>`(count(*) filter (where ${t.stageJobs.visit} = ${visit}))::int`,
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
      visitAttempts: a?.inVisit ?? 0,
      entrySeq: v?.entrySeq ?? 0,
      nextAttempt: (a?.any ?? 0) + 1,
    };
  });
}

/**
 * Why a person has to look. `f3-hold`: discovery held the candidate (a dismissal rule matched at or
 * above the escalation floor), so it was opened for review instead of being queued (`openHeldCase`).
 * `model-refusal` (migration 0010): the model refused the stage's request on safety grounds; the
 * attempt is flagged at once instead of retried, since a retry asks the same model again.
 */
export type ReviewReason = 'attempts-exhausted' | 'budget-exhausted' | 'f3-hold' | 'model-refusal';

export const REVIEW_REASONS: readonly ReviewReason[] = [
  'attempts-exhausted',
  'budget-exhausted',
  'f3-hold',
  'model-refusal',
];

/**
 * Records that a person has to look at a case stage (insert-only, once per attempt). Returns true
 * when the row is new. The case is left where it is; this never dismisses anything. `visit` is the
 * stage visit (stage-history ordinal, from `stageAttemptState`) the flag is for: it blocks retries
 * of that visit only.
 */
export async function flagForReview(
  appPool: AppPool,
  p: { tenantId: string; caseId: string; stage: CaseStage; attempt: number; visit: number },
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
        visit: p.visit,
        reason,
        detail,
      })
      .onConflictDoNothing()
      .returning({ attempt: t.reviewFlags.attempt });
    return rows.length > 0;
  });
}

/**
 * True when an attempt of this case stage was flagged for review during `visit`. A row written
 * before visits were stored (visit 0) matches every visit of its stage.
 */
export async function isFlaggedForReview(
  appPool: AppPool,
  tenantId: string,
  caseId: string,
  stage: CaseStage,
  visit: number,
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
          or(eq(t.reviewFlags.visit, visit), eq(t.reviewFlags.visit, 0)),
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

/** Where a keyset page of `listOpenCases` stopped: the next page starts after this case. */
export interface OpenCaseCursor {
  tenantId: string;
  caseId: string;
}

export interface ListOpenCasesOptions {
  /** Continue after this case (keyset order: tenant id, then case id). */
  after?: OpenCaseCursor | null;
  /** A queue job locked longer than this with its attempt used up counts as dead. Default 600. */
  staleLockSeconds?: number;
}

/**
 * The recovery sweep's candidates, across tenants (list_open_cases(), worker role only; ids and
 * stage only): non-terminal cases not flagged for review at their current visit whose latest
 * attempt of that visit is NOT live (no job at all, a failed or completed-not-advanced or
 * expired attempt, a dead job). Healthy queued or running cases are not listed, so they cannot
 * crowd out orphans. Ordered by tenant and case id; page with `after`. Bounded by `limit` (at most
 * 1000).
 */
export async function listOpenCases(
  workerPool: WorkerPool,
  limit = 500,
  options: ListOpenCasesOptions = {},
): Promise<OpenCase[]> {
  const { rows } = await workerPool.query<{ tenant_id: string; case_id: string; stage: string }>(
    'select tenant_id, case_id, stage from public.list_open_cases($1, $2, $3, $4)',
    [
      limit,
      options.after?.tenantId ?? null,
      options.after?.caseId ?? null,
      options.staleLockSeconds ?? 600,
    ],
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
