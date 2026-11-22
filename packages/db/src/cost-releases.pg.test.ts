import {
  ReleaseRejectedError,
  TrialEvent,
  Verdict,
  samples,
  type BudgetState,
  type CaseId,
  type StageCost,
} from '@affidavit/contracts';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { PgCaseStore } from './case-store.js';
import { PgEventSink } from './event-sink.js';
import { GuardedCaseStore } from './orchestration.js';
import { parseStagePayload } from './queue.js';
import { stageScopedPorts } from './stage-scope.js';
import { withTenant } from './tenant.js';
import { describePg, sampleCase, useTestDatabase } from './test-support.js';

const A = 'tenant-rel-a';
const B = 'tenant-rel-b';
/** The first real run's shape: a $2 case budget, each turn charged up front at its cap. */
const CASE_BUDGET = { maxInputTokens: 1_000_000, maxOutputTokens: 200_000, maxUsd: 2 };
const TURN: StageCost = {
  stage: 'defense',
  attempt: 1,
  inputTokens: 100_000,
  outputTokens: 8_000,
  usd: 0.5,
  wallMs: 0,
};
/** What a failed call did not spend of TURN (illustrative amounts, not a measurement). */
const UNSPENT: StageCost = { ...TURN, inputTokens: 99_000, outputTokens: 8_000, usd: 0.497 };

describePg('PgCaseStore.releaseCharge (contracts v1.2, CR-T1)', () => {
  const db = useTestDatabase([A, B]);

  const store = (tenant = A) => new PgCaseStore(db().app, tenant);
  const sink = (tenant = A) => new PgEventSink(db().app, tenant);

  /** A case at defense, as the trial sees it when it charges its first turn. */
  async function defenseCase(tenant = A): Promise<CaseId> {
    const s = store(tenant);
    const file = sampleCase(tenant);
    await s.open(file, CASE_BUDGET);
    for (const to of ['map', 'arraign', 'defense'] as const) await s.transition(file.id, to);
    return file.id;
  }

  /** What the orchestrator does: chargeBudget, then a cost-charged event. Returns its seq. */
  async function charge(caseId: CaseId, cost: StageCost = TURN, tenant = A): Promise<number> {
    const remaining = await store(tenant).chargeBudget(caseId, cost);
    return emitCharge(caseId, cost, remaining, tenant);
  }

  async function emitCharge(
    caseId: CaseId,
    cost: StageCost,
    remaining: BudgetState,
    tenant = A,
  ): Promise<number> {
    const seq = await store(tenant).nextSeq(caseId);
    await sink(tenant).emit(
      TrialEvent.parse({
        schemaVersion: 1,
        caseId,
        seq,
        stage: cost.stage,
        at: '2026-11-21T12:00:00.000Z',
        actor: 'defense',
        type: 'cost-charged',
        payload: { cost, remaining },
      }),
    );
    return seq;
  }

  async function q<T>(text: string, params: unknown[] = []): Promise<T[]> {
    return (await db().admin.query(text, params)).rows as T[];
  }

  async function releaseRows(caseId: CaseId): Promise<number> {
    const [r] = await q<{ n: number }>(
      `select count(*)::int n from cost_releases where case_id = $1`,
      [caseId],
    );
    return r!.n;
  }

  async function rejection(p: Promise<unknown>): Promise<ReleaseRejectedError> {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ReleaseRejectedError);
    return err as ReleaseRejectedError;
  }

  /** The app role's own view of a case budget (net of releases), under its tenant. */
  async function viewBudget(caseId: CaseId, tenant = A) {
    return withTenant(db().app, tenant, async (tx) => {
      const r = await tx.execute(
        sql`select remaining_input_tokens::bigint as i, remaining_output_tokens::bigint as o,
              remaining_usd::text as usd, exhausted from public.case_budgets where case_id = ${caseId}`,
      );
      return r.rows as { i: string; o: string; usd: string; exhausted: boolean }[];
    });
  }

  it('gives back the unspent part, so up-front turn caps no longer exhaust a cheap case', async () => {
    const id = await defenseCase();
    const s = store();
    let budget: BudgetState | undefined;
    // Without releases, four charges at the $0.50 cap use the whole $2: exhausted after four calls.
    for (let i = 0; i < 4; i++) {
      const seq = await charge(id);
      budget = await s.releaseCharge(id, UNSPENT, seq);
      expect(budget.exhausted).toBe(false);
    }
    expect(budget).toEqual({
      remainingInputTokens: 1_000_000 - 4 * 1_000,
      remainingOutputTokens: 200_000,
      remainingUsd: 1.988,
      exhausted: false,
    });
    // The next charge sees the net budget too.
    const after = await s.chargeBudget(id, TURN);
    expect(after.remainingUsd).toBe(1.488);
    expect(after.exhausted).toBe(false);
    // The view says the same as the store, and the gross columns on cases are not credited.
    expect(await viewBudget(id)).toEqual([
      {
        i: String(1_000_000 - 4 * 1_000 - 100_000),
        o: '192000',
        usd: '1.488000',
        exhausted: false,
      },
    ]);
    const [gross] = await q<{ usd: string; exhausted: boolean }>(
      `select remaining_usd::text usd, exhausted from cases where id = $1`,
      [id],
    );
    expect(gross).toEqual({ usd: '-0.500000', exhausted: true });
  });

  it('reports charged, released and net per stage attempt for operators (case_cost_ledger)', async () => {
    const id = await defenseCase();
    const s = store();
    const first = await charge(id);
    await s.releaseCharge(id, UNSPENT, first);
    await charge(id, { ...TURN, attempt: 2 });
    const rows = await withTenant(db().app, A, async (tx) => {
      const r = await tx.execute(
        sql`select stage, attempt, charged_usd::text c, released_usd::text r, net_usd::text n,
              net_input_tokens::bigint ni
            from public.case_cost_ledger where case_id = ${id} order by attempt`,
      );
      return r.rows;
    });
    expect(rows).toEqual([
      {
        stage: 'defense',
        attempt: 1,
        c: '0.500000000',
        r: '0.497000000',
        n: '0.003000000',
        ni: '1000',
      },
      { stage: 'defense', attempt: 2, c: '0.500000000', r: '0', n: '0.500000000', ni: '100000' },
    ]);
    // cost_rows still holds both charges in full: a release never touches it.
    const [sums] = await q<{ n: number; usd: string }>(
      `select count(*)::int n, sum(usd)::text usd from cost_rows where case_id = $1`,
      [id],
    );
    expect(sums).toEqual({ n: 2, usd: '1.000000000' });
  });

  it('is idempotent on (case, reservation seq): a replay changes nothing, whatever it carries', async () => {
    const id = await defenseCase();
    const s = store();
    const seq = await charge(id);
    const once = await s.releaseCharge(id, UNSPENT, seq);
    expect(await s.releaseCharge(id, UNSPENT, seq)).toEqual(once);
    // A replay with another (even an invalid) refund is still a no-op that returns the budget.
    expect(await s.releaseCharge(id, { ...UNSPENT, usd: 0.1 }, seq)).toEqual(once);
    expect(await s.releaseCharge(id, { ...UNSPENT, usd: Number.NaN }, seq)).toEqual(once);
    expect(await releaseRows(id)).toBe(1);
  });

  it('rejects a refund that exceeds its charge in any field, and changes nothing', async () => {
    const id = await defenseCase();
    const s = store();
    const seq = await charge(id);
    const before = await viewBudget(id);
    for (const over of [
      { inputTokens: TURN.inputTokens + 1 },
      { outputTokens: TURN.outputTokens + 1 },
      { usd: 0.500001 },
      { wallMs: 1 },
    ]) {
      const err = await rejection(s.releaseCharge(id, { ...UNSPENT, ...over }, seq));
      expect(err.reservationSeq).toBe(seq);
      expect(err.message).toMatch(/exceeds the charge/);
    }
    expect(await releaseRows(id)).toBe(0);
    expect(await viewBudget(id)).toEqual(before);
    // The whole charge can be given back, but no more.
    await s.releaseCharge(id, TURN, seq);
    expect((await viewBudget(id))[0]!.usd).toBe('2.000000');
  });

  it('rejects a seq that is not a cost-charged event of this case, or another stage or attempt', async () => {
    const id = await defenseCase();
    const s = store();
    const seq = await charge(id);
    // A seq that is a different event type.
    const other = await s.nextSeq(id);
    await sink().emit(
      TrialEvent.parse({
        schemaVersion: 1,
        caseId: id,
        seq: other,
        stage: 'defense',
        at: '2026-11-21T12:00:00.000Z',
        actor: 'stenographer',
        type: 'stage-entered',
        payload: { from: 'arraign' },
      }),
    );
    expect((await rejection(s.releaseCharge(id, UNSPENT, other))).message).toMatch(
      /no cost-charged event/,
    );
    // A seq with no event, and a seq that is not a non-negative integer.
    for (const bad of [other + 50, -1, 1.5, Number.NaN, 2 ** 31]) {
      await rejection(s.releaseCharge(id, UNSPENT, bad));
    }
    // This case's charge at that seq does not count for another case with no event there.
    const fresh = await defenseCase();
    await s.chargeBudget(fresh, TURN);
    await rejection(s.releaseCharge(fresh, UNSPENT, seq));
    expect(await releaseRows(fresh)).toBe(0);
    // The right seq, but another stage or attempt than the charge.
    expect(
      (await rejection(s.releaseCharge(id, { ...UNSPENT, stage: 'prosecution' }, seq))).message,
    ).toMatch(/different stage or attempt/);
    await rejection(s.releaseCharge(id, { ...UNSPENT, attempt: 2 }, seq));
    expect(await releaseRows(id)).toBe(0);
  });

  it('rejects negative, NaN and non-finite refunds', async () => {
    const id = await defenseCase();
    const s = store();
    const seq = await charge(id);
    for (const bad of [
      { usd: -0.1 },
      { usd: Number.NaN },
      { usd: Number.POSITIVE_INFINITY },
      { inputTokens: -1 },
      { outputTokens: 1.5 },
      { attempt: 0 },
    ]) {
      expect((await rejection(s.releaseCharge(id, { ...UNSPENT, ...bad }, seq))).message).toMatch(
        /not a valid StageCost/,
      );
    }
    expect(await releaseRows(id)).toBe(0);
  });

  it('never releases more than the case was charged, even against a forged charge event', async () => {
    const id = await defenseCase();
    const s = store();
    const real = await charge(id);
    // A cost-charged event with no charge behind it (written straight to the sink).
    const remaining = {
      remainingInputTokens: 0,
      remainingOutputTokens: 0,
      remainingUsd: 0,
      exhausted: true,
    };
    const forged = await emitCharge(id, TURN, remaining);
    await s.releaseCharge(id, UNSPENT, real);
    expect((await rejection(s.releaseCharge(id, UNSPENT, forged))).message).toMatch(
      /more than the case was charged/,
    );
    expect(await releaseRows(id)).toBe(1);
  });

  it('serialises concurrent releases: one row per seq, and the case-wide cap holds', async () => {
    const id = await defenseCase();
    const s = store();
    const seq = await charge(id);
    const replays = await Promise.allSettled(
      Array.from({ length: 6 }, () => s.releaseCharge(id, UNSPENT, seq)),
    );
    expect(replays.every((r) => r.status === 'fulfilled')).toBe(true);
    const budgets = replays.map((r) => (r as PromiseFulfilledResult<BudgetState>).value);
    expect(new Set(budgets.map((b) => b.remainingUsd))).toEqual(new Set([1.997]));
    expect(await releaseRows(id)).toBe(1);

    // Two charge events can each justify the whole release, but the case was charged once more
    // only: of two concurrent full releases, exactly one may land.
    const id2 = await defenseCase();
    const one = await charge(id2);
    const forged = await emitCharge(id2, TURN, {
      remainingInputTokens: 0,
      remainingOutputTokens: 0,
      remainingUsd: 0,
      exhausted: true,
    });
    const both = await Promise.allSettled([
      s.releaseCharge(id2, TURN, one),
      s.releaseCharge(id2, TURN, forged),
    ]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = both.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(ReleaseRejectedError);
    expect(await releaseRows(id2)).toBe(1);

    // Releases racing charges never lose a deduction or a credit.
    const id3 = await defenseCase();
    const seqs = [await charge(id3), await charge(id3)];
    await Promise.all([
      s.releaseCharge(id3, UNSPENT, seqs[0]!),
      s.chargeBudget(id3, { ...TURN, usd: 0.25, inputTokens: 0, outputTokens: 0 }),
      s.releaseCharge(id3, UNSPENT, seqs[1]!),
      s.chargeBudget(id3, { ...TURN, usd: 0.25, inputTokens: 0, outputTokens: 0 }),
    ]);
    // 2 - 2 * 0.5 - 2 * 0.25 + 2 * 0.497
    expect((await viewBudget(id3))[0]!.usd).toBe('1.494000');
  });

  it('refuses a release once the case is closed (a terminal stage or a verdict)', async () => {
    const s = store();
    const escalated = await defenseCase();
    const seq = await charge(escalated);
    await s.transition(escalated, 'escalated');
    expect((await rejection(s.releaseCharge(escalated, UNSPENT, seq))).message).toMatch(/closed/);

    const judged = await defenseCase();
    const seq2 = await charge(judged);
    await s.appendVerdict(Verdict.parse({ ...(samples.Verdict as object), caseId: judged }));
    expect((await rejection(s.releaseCharge(judged, UNSPENT, seq2))).message).toMatch(/closed/);
    expect((await releaseRows(escalated)) + (await releaseRows(judged))).toBe(0);
  });

  it('keeps tenants apart: another tenant cannot release, see or insert a release for a case', async () => {
    const id = await defenseCase(A);
    const seq = await charge(id);
    await store(A).releaseCharge(id, UNSPENT, seq);
    await expect(store(B).releaseCharge(id, UNSPENT, seq)).rejects.toThrow(/unknown case/);
    expect(await viewBudget(id, B)).toEqual([]);
    const seen = await withTenant(db().app, B, async (tx) => {
      const r = await tx.execute(sql`select * from public.cost_releases where case_id = ${id}`);
      return r.rows.length;
    });
    expect(seen).toBe(0);
    // A raw insert as B naming A's case: the row is B's, so the case and its event are unknown.
    const err = await withTenant(db().app, B, (tx) =>
      tx.execute(sql`insert into public.cost_releases
        (tenant_id, case_id, reservation_seq, stage, attempt, input_tokens, output_tokens, usd, wall_ms)
        values (${B}, ${id}, ${seq + 1}, 'defense', 1, 0, 0, 0, 0)`),
    ).catch((e: Error) => (e.cause as Error | undefined)?.message ?? e.message);
    expect(err).toMatch(/cost release rejected: unknown case|violates/);
    // And as A naming tenant B: row-level security refuses it.
    const err2 = await withTenant(db().app, A, (tx) =>
      tx.execute(sql`insert into public.cost_releases
        (tenant_id, case_id, reservation_seq, stage, attempt, input_tokens, output_tokens, usd, wall_ms)
        values (${B}, ${id}, ${seq + 1}, 'defense', 1, 0, 0, 0, 0)`),
    ).catch((e: Error) => (e.cause as Error | undefined)?.message ?? e.message);
    expect(err2).toMatch(/row-level security|cost release rejected/);
    expect(await releaseRows(id)).toBe(1);
  });

  it('through the stage-scoped ports, a reservation is released under its stored seq', async () => {
    const id = await defenseCase();
    // An earlier event, so stored seqs and placeholders differ.
    await emitCharge(
      id,
      { ...TURN, stage: 'arraign' },
      await store().chargeBudget(id, { ...TURN, stage: 'arraign' }),
    );
    const pgSink = sink();
    const ports = stageScopedPorts({
      job: parseStagePayload({ tenantId: A, caseId: id, stage: 'defense', attempt: 1 }),
      store: new GuardedCaseStore(store(), new AbortController().signal),
      sink: pgSink,
      events: (caseId) => pgSink.events(caseId),
    });
    // What the orchestrator does: charge, then a cost-charged event numbered by the store.
    const remaining = await ports.store.chargeBudget(id, TURN);
    const placeholder = await ports.store.nextSeq(id);
    const storedSeq = await ports.sink.emitStored(
      TrialEvent.parse({
        schemaVersion: 1,
        caseId: id,
        seq: placeholder,
        stage: 'defense',
        at: '2026-11-21T12:00:00.000Z',
        actor: 'defense',
        type: 'cost-charged',
        payload: { cost: TURN, remaining },
      }),
    );
    expect(storedSeq).toBe(1);
    expect(placeholder).not.toBe(storedSeq);
    const once = await ports.store.releaseCharge!(id, UNSPENT, placeholder);
    // The (case, seq) key in Postgres is the stored seq: a replay by either number is a no-op.
    expect(await ports.store.releaseCharge!(id, UNSPENT, storedSeq!)).toEqual(once);
    expect(await store().releaseCharge(id, UNSPENT, storedSeq!)).toEqual(once);
    const rows = await q<{ seq: number }>(
      `select reservation_seq seq from cost_releases where case_id = $1`,
      [id],
    );
    expect(rows).toEqual([{ seq: storedSeq }]);
    // The arraign charge (seq 0) was not made through these ports: refused there.
    await rejection(ports.store.releaseCharge!(id, UNSPENT, 0));
  });

  it('is append-only, and the insert guard refuses an invalid raw insert', async () => {
    const id = await defenseCase();
    const seq = await charge(id);
    await store().releaseCharge(id, UNSPENT, seq);
    const raw = (text: string) =>
      withTenant(db().app, A, (tx) => tx.execute(sql.raw(text))).then(
        () => 'no error',
        (e: Error) => (e.cause as Error | undefined)?.message ?? e.message,
      );
    expect(await raw(`update cost_releases set usd = 0.5 where case_id = '${id}'`)).toMatch(
      /permission denied/,
    );
    expect(await raw(`delete from cost_releases where case_id = '${id}'`)).toMatch(
      /permission denied/,
    );
    expect(await raw(`truncate cost_releases`)).toMatch(/permission denied/);
    // The owner's triggers stop a mutation even with the grant in place.
    const asOwner = async (text: string) => {
      const c = await db().admin.connect();
      try {
        await c.query('begin');
        await c.query('grant update, delete on public.cost_releases to affidavit_app');
        await c.query('set local role affidavit_app');
        await c.query(`select set_config('app.tenant_id', $1, true)`, [A]);
        return await c.query(text).then(
          () => 'no error',
          (e: Error) => e.message,
        );
      } finally {
        await c.query('rollback');
        c.release();
      }
    };
    expect(await asOwner(`update cost_releases set usd = 0.5 where case_id = '${id}'`)).toMatch(
      /append-only/,
    );
    expect(await asOwner(`delete from cost_releases where case_id = '${id}'`)).toMatch(
      /append-only/,
    );

    // A raw insert by the app role is checked by the guard like a store call.
    const seq2 = await charge(id);
    const insert = (seqN: number, usd: string, stage = 'defense') =>
      raw(`insert into cost_releases
        (tenant_id, case_id, reservation_seq, stage, attempt, input_tokens, output_tokens, usd, wall_ms)
        values ('${A}', '${id}', ${seqN}, '${stage}', 1, 0, 0, ${usd}, 0)`);
    expect(await insert(seq2, '0.6')).toMatch(/cost release rejected: the refund exceeds/);
    expect(await insert(seq2, '0.1', 'remedy')).toMatch(/different stage or attempt/);
    expect(await insert(seq2, '-0.1')).toMatch(/cost_releases_values_valid|rejected/);
    expect(await insert(seq, '0.001')).toMatch(/duplicate key/);
    expect(await insert(seq2, '0.1')).toBe('no error');
    expect(await releaseRows(id)).toBe(2);
  });
});
