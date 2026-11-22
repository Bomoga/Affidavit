import {
  Budget as BudgetSchema,
  BudgetState,
  CaseFile as CaseFileSchema,
  CaseStage as CaseStageSchema,
  Exhibit as ExhibitSchema,
  ExhibitResult as ExhibitResultSchema,
  IllegalTransitionError,
  ReleaseRejectedError,
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
import * as t from './schema.js';
import { withTenant, type AppPool, type Tx } from './tenant.js';
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
    private readonly pool: AppPool,
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
      // The stage-history row for intake is written by a trigger on cases.
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
      // The stage-history row for the new stage is written by a trigger on cases.
    });
  }

  /**
   * The budget the port reports: `case_budgets`, the gross columns on `cases` plus every release
   * (v1.2, CR-T1), with `exhausted` recomputed from the net amounts as `FakeCaseStore` does.
   */
  private async netBudget(tx: Tx, caseId: CaseId): Promise<BudgetState> {
    const res = await tx.execute(sql`
      select remaining_input_tokens, remaining_output_tokens, remaining_usd, exhausted
      from public.case_budgets where tenant_id = ${this.tenantId} and case_id = ${caseId}`);
    const row = res.rows[0] as
      | {
          remaining_input_tokens: string | number;
          remaining_output_tokens: string | number;
          remaining_usd: string;
          exhausted: boolean;
        }
      | undefined;
    if (!row) throw unknownCase(caseId);
    return BudgetState.parse({
      remainingInputTokens: Number(row.remaining_input_tokens),
      remainingOutputTokens: Number(row.remaining_output_tokens),
      remainingUsd: Number(row.remaining_usd),
      exhausted: row.exhausted,
    });
  }

  /**
   * Locks the case row (the budget) for the rest of the transaction; returns its stage.
   * FOR NO KEY UPDATE: charges and releases still run one at a time (the lock conflicts with
   * itself and with UPDATE), but an event emit or cost row insert, whose foreign key check takes
   * FOR KEY SHARE on this row, is not blocked by it (migration 0011 does the same in the guard).
   */
  private async lockCase(tx: Tx, caseId: CaseId): Promise<CaseStage> {
    const [row] = await tx
      .select({ stage: t.cases.stage })
      .from(t.cases)
      .where(this.caseWhere(caseId))
      .for('no key update');
    if (!row) throw unknownCase(caseId);
    return CaseStageSchema.parse(row.stage);
  }

  async chargeBudget(caseId: CaseId, costIn: StageCost) {
    const cost = StageCostSchema.parse(costIn);
    return this.run(async (tx) => {
      // The budget row is locked first, so a charge and a release of the same case run one at a
      // time and each reads the other's committed rows.
      await this.lockCase(tx, caseId);
      // The columns on cases stay gross (charges only, never credited), so they only decrease;
      // `cases.exhausted` is the gross flag and never clears. The budget returned is net of
      // releases (case_budgets).
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
        returning id`);
      if (updated.rows.length === 0) throw unknownCase(caseId);
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
      return this.netBudget(tx, caseId);
    });
  }

  /**
   * v1.2 (CR-T1). Gives back `refund`, the unspent part of the charge recorded by the
   * `cost-charged` event at `reservationSeq`, as an insert-only `cost_releases` row (charges are
   * never changed). One transaction, under a lock on the case row:
   * - a release already recorded for (tenant, case, reservationSeq) changes nothing and returns
   *   the current budget, whatever refund it carries (idempotent);
   * - otherwise it throws ReleaseRejectedError, changing nothing, when the seq is not a
   *   non-negative integer, the refund is not a valid StageCost (negative, NaN, non-finite), the
   *   case is closed (a terminal stage or a verdict), the event at that seq is not a
   *   `cost-charged` event of this case, the refund names another stage or attempt, a field
   *   exceeds that charge, or the case's releases would exceed its charges;
   * - and returns the budget net of releases. The caller emits `cost-released`.
   * An insert trigger (migration 0009) repeats the checks for any other writer.
   */
  async releaseCharge(
    caseId: CaseId,
    refundIn: StageCost,
    reservationSeq: number,
  ): Promise<BudgetState> {
    const reject = (why: string) => new ReleaseRejectedError(caseId, reservationSeq, why);
    if (!Number.isInteger(reservationSeq) || reservationSeq < 0 || reservationSeq > INT4_MAX) {
      throw reject('reservationSeq is not a non-negative integer');
    }
    try {
      return await this.run(async (tx) => {
        const stage = await this.lockCase(tx, caseId);
        const [done] = await tx
          .select({ seq: t.costReleases.reservationSeq })
          .from(t.costReleases)
          .where(
            and(
              eq(t.costReleases.tenantId, this.tenantId),
              eq(t.costReleases.caseId, caseId),
              eq(t.costReleases.reservationSeq, reservationSeq),
            ),
          );
        if (done) return this.netBudget(tx, caseId);

        const parsed = StageCostSchema.safeParse(refundIn);
        if (!parsed.success || !finiteCost(parsed.data)) {
          throw reject('refund is not a valid StageCost (finite, non-negative amounts)');
        }
        const refund = parsed.data;
        if (TERMINAL_STAGES.includes(stage)) throw reject(`the case is closed (${stage})`);
        const [verdict] = await tx
          .select({ caseId: t.verdicts.caseId })
          .from(t.verdicts)
          .where(and(eq(t.verdicts.tenantId, this.tenantId), eq(t.verdicts.caseId, caseId)));
        if (verdict) throw reject('the case is closed (it has a verdict)');

        const [event] = await tx
          .select({ type: t.events.type, event: t.events.event })
          .from(t.events)
          .where(
            and(
              eq(t.events.tenantId, this.tenantId),
              eq(t.events.caseId, caseId),
              eq(t.events.seq, reservationSeq),
            ),
          );
        if (event?.type !== 'cost-charged') throw reject('no cost-charged event at that seq');
        const charge = StageCostSchema.safeParse(
          (event.event as { payload?: { cost?: unknown } }).payload?.cost,
        );
        if (!charge.success) throw reject('the cost-charged event at that seq has no valid cost');
        const c = charge.data;
        if (c.stage !== refund.stage || c.attempt !== refund.attempt) {
          throw reject('refund names a different stage or attempt than the charge');
        }
        if (
          refund.inputTokens > c.inputTokens ||
          refund.outputTokens > c.outputTokens ||
          round6(refund.usd) > round6(c.usd) ||
          refund.wallMs > c.wallMs
        ) {
          throw reject('refund exceeds the charge it releases');
        }

        // The ledger never goes negative: releases never exceed charges, field by field.
        const totals = await tx.execute(sql`
          select
            (select coalesce(sum(input_tokens), 0) from public.cost_rows
              where tenant_id = ${this.tenantId} and case_id = ${caseId})
              - (select coalesce(sum(input_tokens), 0) from public.cost_releases
              where tenant_id = ${this.tenantId} and case_id = ${caseId})
              - ${refund.inputTokens} < 0 as over_in,
            (select coalesce(sum(output_tokens), 0) from public.cost_rows
              where tenant_id = ${this.tenantId} and case_id = ${caseId})
              - (select coalesce(sum(output_tokens), 0) from public.cost_releases
              where tenant_id = ${this.tenantId} and case_id = ${caseId})
              - ${refund.outputTokens} < 0 as over_out,
            round((select coalesce(sum(usd), 0) from public.cost_releases
              where tenant_id = ${this.tenantId} and case_id = ${caseId}) + ${refund.usd}::numeric, 6)
              > round((select coalesce(sum(usd), 0) from public.cost_rows
              where tenant_id = ${this.tenantId} and case_id = ${caseId}), 6) as over_usd`);
        const over = totals.rows[0] as
          { over_in: boolean; over_out: boolean; over_usd: boolean } | undefined;
        if (!over || over.over_in || over.over_out || over.over_usd) {
          throw reject('would release more than the case was charged');
        }

        await tx.insert(t.costReleases).values({
          tenantId: this.tenantId,
          caseId,
          reservationSeq,
          stage: refund.stage,
          attempt: refund.attempt,
          inputTokens: refund.inputTokens,
          outputTokens: refund.outputTokens,
          usd: String(refund.usd),
          wallMs: refund.wallMs,
        });
        return this.netBudget(tx, caseId);
      });
    } catch (err) {
      // The insert guard's refusals (any writer's backstop) surface as the contract error.
      // Drizzle wraps the driver error; the Postgres message is on `cause`.
      const cause = err instanceof Error ? err.cause : undefined;
      const msg = [err, cause].map((e) => (e instanceof Error ? e.message : '')).join(' ');
      const m = /cost release rejected: ([^\n]*)/.exec(msg);
      if (m && !(err instanceof ReleaseRejectedError)) {
        throw reject(m[1]!.trim());
      }
      throw err;
    }
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

const INT4_MAX = 2_147_483_647;
const TERMINAL_STAGES: readonly CaseStage[] = ['verdict', 'dismissed', 'escalated'];
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const finiteCost = (c: StageCost): boolean =>
  [c.inputTokens, c.outputTokens, c.usd, c.wallMs].every((n) => Number.isFinite(n) && n >= 0);

function unknownCase(caseId: string): Error {
  return new Error(`unknown case ${caseId}`);
}
