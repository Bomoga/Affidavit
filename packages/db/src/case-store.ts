import {
  Budget as BudgetSchema,
  BudgetState,
  CaseFile as CaseFileSchema,
  CaseStage as CaseStageSchema,
  Exhibit as ExhibitSchema,
  ExhibitResult as ExhibitResultSchema,
  IllegalTransitionError,
  StageCost as StageCostSchema,
  Verdict as VerdictSchema,
  VerdictAlreadyWrittenError,
  type Budget,
  type CaseFile,
  type CaseId,
  type CaseStage,
  type CaseStore,
  type Exhibit,
  type ExhibitResult,
  type StageCost,
  type Verdict,
} from '@affidavit/contracts';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type pg from 'pg';
import * as t from './schema.js';
import { withTenant, type Tx } from './tenant.js';
import { rejectTransition } from './transition-rules.js';

export interface PgCaseStoreOptions {
  /** When false, verify goes straight to verdict and jury is unreachable. Default true. */
  juryEnabled?: boolean;
}

/**
 * Postgres CaseStore for one tenant. Every call runs in a transaction with the tenant set, so
 * row-level security applies; the queries also filter on tenant_id explicitly. A case that
 * belongs to another tenant is indistinguishable from one that does not exist.
 */
export class PgCaseStore implements CaseStore {
  private readonly juryEnabled: boolean;

  constructor(
    private readonly pool: pg.Pool,
    readonly tenantId: string,
    options: PgCaseStoreOptions = {},
  ) {
    this.juryEnabled = options.juryEnabled ?? true;
  }

  private run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.pool, this.tenantId, fn);
  }

  private caseWhere(caseId: string) {
    return and(eq(t.cases.tenantId, this.tenantId), eq(t.cases.id, caseId));
  }

  async open(caseFileIn: CaseFile, budgetIn: Budget): Promise<void> {
    const caseFile = CaseFileSchema.parse(caseFileIn);
    const budget = BudgetSchema.parse(budgetIn);
    if (caseFile.tenantId !== this.tenantId) {
      throw new Error(`case ${caseFile.id} belongs to another tenant than this store`);
    }
    await this.run(async (tx) => {
      // Tenants are provisioned by the owner (provisionTenant), never by the application role.
      const [tenant] = await tx
        .select({ id: t.tenants.tenantId })
        .from(t.tenants)
        .where(eq(t.tenants.tenantId, this.tenantId));
      if (!tenant) throw new Error(`unknown tenant ${this.tenantId}`);
      await tx
        .insert(t.repos)
        .values({ tenantId: this.tenantId, id: caseFile.target.repo })
        .onConflictDoNothing();
      const inserted = await tx
        .insert(t.cases)
        .values({
          tenantId: this.tenantId,
          id: caseFile.id,
          repoId: caseFile.target.repo,
          caseFile,
          stage: 'intake',
          candidateScore: caseFile.candidate.score,
          escalationFloor: caseFile.escalationFloor,
          remainingInputTokens: budget.maxInputTokens,
          remainingOutputTokens: budget.maxOutputTokens,
          remainingUsd: String(budget.maxUsd),
        })
        .onConflictDoNothing()
        .returning({ id: t.cases.id });
      if (inserted.length === 0) throw new Error(`case ${caseFile.id} already open`);
      await tx
        .insert(t.stages)
        .values({ tenantId: this.tenantId, caseId: caseFile.id, ordinal: 1, stage: 'intake' });
    });
  }

  async stage(caseId: CaseId): Promise<CaseStage> {
    return this.run(async (tx) => {
      const [row] = await tx
        .select({ stage: t.cases.stage })
        .from(t.cases)
        .where(this.caseWhere(caseId));
      if (!row) throw unknownCase(caseId);
      return CaseStageSchema.parse(row.stage);
    });
  }

  async transition(caseId: CaseId, to: CaseStage): Promise<void> {
    await this.run(async (tx) => {
      // Row lock: concurrent transitions on one case run one at a time, each seeing the last.
      const [row] = await tx
        .select({
          stage: t.cases.stage,
          score: t.cases.candidateScore,
          floor: t.cases.escalationFloor,
          appeals: t.cases.appeals,
        })
        .from(t.cases)
        .where(this.caseWhere(caseId))
        .for('update');
      if (!row) throw unknownCase(caseId);
      const from = CaseStageSchema.parse(row.stage);
      const why = rejectTransition({
        from,
        to,
        score: row.score,
        escalationFloor: row.floor,
        appeals: row.appeals,
        juryEnabled: this.juryEnabled,
      });
      if (why !== null) throw new IllegalTransitionError(from, to, why);
      const appeal = from === 'verify' && to === 'remedy';
      await tx
        .update(t.cases)
        .set({
          stage: to,
          appeals: appeal ? row.appeals + 1 : row.appeals,
          updatedAt: sql`now()`,
        })
        .where(this.caseWhere(caseId));
      await tx.execute(sql`
        insert into public.stages (tenant_id, case_id, ordinal, stage)
        select ${this.tenantId}, ${caseId}, coalesce(max(ordinal), 0) + 1, ${to}
        from public.stages where tenant_id = ${this.tenantId} and case_id = ${caseId}`);
    });
  }

  async chargeBudget(caseId: CaseId, costIn: StageCost) {
    const cost = StageCostSchema.parse(costIn);
    return this.run(async (tx) => {
      // One atomic UPDATE: concurrent charges never lose a deduction.
      const updated = await tx.execute(sql`
        update public.cases set
          remaining_input_tokens = remaining_input_tokens - ${cost.inputTokens},
          remaining_output_tokens = remaining_output_tokens - ${cost.outputTokens},
          remaining_usd = round(remaining_usd - ${cost.usd}::numeric, 6),
          exhausted = (
            remaining_input_tokens - ${cost.inputTokens} <= 0
            or remaining_output_tokens - ${cost.outputTokens} <= 0
            or round(remaining_usd - ${cost.usd}::numeric, 6) <= 0
          ),
          updated_at = now()
        where tenant_id = ${this.tenantId} and id = ${caseId}
        returning remaining_input_tokens, remaining_output_tokens, remaining_usd, exhausted`);
      const row = updated.rows[0] as
        | {
            remaining_input_tokens: string | number;
            remaining_output_tokens: string | number;
            remaining_usd: string;
            exhausted: boolean;
          }
        | undefined;
      if (!row) throw unknownCase(caseId);
      await tx.insert(t.costRows).values({
        tenantId: this.tenantId,
        caseId,
        stage: cost.stage,
        attempt: cost.attempt,
        inputTokens: cost.inputTokens,
        outputTokens: cost.outputTokens,
        usd: String(cost.usd),
        wallMs: cost.wallMs,
      });
      return BudgetState.parse({
        remainingInputTokens: Number(row.remaining_input_tokens),
        remainingOutputTokens: Number(row.remaining_output_tokens),
        remainingUsd: Number(row.remaining_usd),
        exhausted: row.exhausted,
      });
    });
  }

  async nextSeq(caseId: CaseId): Promise<number> {
    return this.run(async (tx) => {
      const rows = await tx
        .update(t.cases)
        .set({ seq: sql`${t.cases.seq} + 1` })
        .where(this.caseWhere(caseId))
        .returning({ next: t.cases.seq });
      const row = rows[0];
      if (!row) throw unknownCase(caseId);
      return row.next - 1;
    });
  }

  async appendVerdict(verdictIn: Verdict): Promise<void> {
    const verdict = VerdictSchema.parse(verdictIn);
    await this.run(async (tx) => {
      const [exists] = await tx
        .select({ id: t.cases.id })
        .from(t.cases)
        .where(this.caseWhere(verdict.caseId));
      if (!exists) throw unknownCase(verdict.caseId);
      const inserted = await tx
        .insert(t.verdicts)
        .values({
          tenantId: this.tenantId,
          caseId: verdict.caseId,
          outcome: verdict.outcome,
          verdict,
        })
        .onConflictDoNothing()
        .returning({ caseId: t.verdicts.caseId });
      if (inserted.length === 0) throw new VerdictAlreadyWrittenError(verdict.caseId);
    });
  }

  async getVerdict(caseId: CaseId): Promise<Verdict | null> {
    return this.run(async (tx) => {
      const [exists] = await tx
        .select({ id: t.cases.id })
        .from(t.cases)
        .where(this.caseWhere(caseId));
      if (!exists) throw unknownCase(caseId);
      const [row] = await tx
        .select({ verdict: t.verdicts.verdict })
        .from(t.verdicts)
        .where(and(eq(t.verdicts.tenantId, this.tenantId), eq(t.verdicts.caseId, caseId)));
      return row ? VerdictSchema.parse(row.verdict) : null;
    });
  }

  /** Beyond the port: store an exhibit once; a repeat of the same id is ignored. */
  async putExhibit(exhibitIn: Exhibit): Promise<void> {
    const exhibit = ExhibitSchema.parse(exhibitIn);
    await this.run(async (tx) => {
      const [exists] = await tx
        .select({ id: t.cases.id })
        .from(t.cases)
        .where(this.caseWhere(exhibit.caseId));
      if (!exists) throw unknownCase(exhibit.caseId);
      await tx
        .insert(t.exhibits)
        .values({
          tenantId: this.tenantId,
          caseId: exhibit.caseId,
          id: exhibit.id,
          kind: exhibit.kind,
          author: exhibit.author,
          sha256: exhibit.sha256,
          exhibit,
        })
        .onConflictDoNothing();
    });
  }

  /** Beyond the port: attach the Judge's result to a stored exhibit (the one mutable column). */
  async recordExhibitResult(caseId: CaseId, resultIn: ExhibitResult): Promise<void> {
    const result = ExhibitResultSchema.parse(resultIn);
    await this.run(async (tx) => {
      const rows = await tx
        .update(t.exhibits)
        .set({ result })
        .where(
          and(
            eq(t.exhibits.tenantId, this.tenantId),
            eq(t.exhibits.caseId, caseId),
            eq(t.exhibits.id, result.exhibitId),
            isNull(t.exhibits.result),
          ),
        )
        .returning({ id: t.exhibits.id });
      // Write-once: a result already recorded is rejected here and by a trigger in the database.
      if (rows.length === 0) {
        throw new Error(`unknown exhibit ${result.exhibitId}, or its result is already recorded`);
      }
    });
  }

  /** Beyond the port: exhibits for a case with their results, oldest first. */
  async getExhibits(caseId: CaseId): Promise<{ exhibit: Exhibit; result: ExhibitResult | null }[]> {
    return this.run(async (tx) => {
      const rows = await tx
        .select({ exhibit: t.exhibits.exhibit, result: t.exhibits.result })
        .from(t.exhibits)
        .where(and(eq(t.exhibits.tenantId, this.tenantId), eq(t.exhibits.caseId, caseId)))
        .orderBy(t.exhibits.createdAt, t.exhibits.id);
      return rows.map((r) => ({
        exhibit: ExhibitSchema.parse(r.exhibit),
        result: r.result === null ? null : ExhibitResultSchema.parse(r.result),
      }));
    });
  }
}

function unknownCase(caseId: string): Error {
  return new Error(`unknown case ${caseId}`);
}
