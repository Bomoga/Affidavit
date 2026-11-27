import {
  IllegalTransitionError,
  MAX_APPEALS,
  ReleaseRejectedError,
  StageCost as StageCostSchema,
  VerdictAlreadyWrittenError,
  isLegalTransition,
  type Budget,
  type BudgetState,
  type CaseFile,
  type CaseId,
  type CaseStage,
  type CaseStore,
  type EventSink,
  type StageCost,
  type TrialEvent,
  type Verdict,
} from '@affidavit/contracts';

interface CaseRecord {
  caseFile: CaseFile;
  stage: CaseStage;
  budget: BudgetState;
  appeals: number;
  seq: number;
  verdict: Verdict | null;
  costs: StageCost[];
  /** v1.2 (CR-T1): releases by the seq of the `cost-charged` event they release. */
  releases: Map<number, StageCost>;
}

export interface FakeCaseStoreOptions {
  /** When false, verify goes straight to verdict and jury is unreachable. Default true. */
  juryEnabled?: boolean;
  /**
   * v1.2 (CR-T1): the sink the trial emits to. When set, `releaseCharge` checks each refund
   * against the `cost-charged` event at its `reservationSeq` (same stage and attempt, no field
   * larger). Without it the fake can only enforce the case-wide rule that releases never exceed
   * charges, since a store does not see seqs when it charges.
   */
  events?: FakeEventSink;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** In-memory CaseStore that enforces the same rules the Postgres store must. */
export class FakeCaseStore implements CaseStore {
  private readonly cases = new Map<CaseId, CaseRecord>();
  private readonly juryEnabled: boolean;
  private readonly events: FakeEventSink | undefined;

  constructor(options: FakeCaseStoreOptions = {}) {
    this.juryEnabled = options.juryEnabled ?? true;
    this.events = options.events;
  }

  private rec(caseId: CaseId): CaseRecord {
    const r = this.cases.get(caseId);
    if (!r) throw new Error(`unknown case ${caseId}`);
    return r;
  }

  open(caseFile: CaseFile, budget: Budget): Promise<void> {
    if (this.cases.has(caseFile.id))
      return Promise.reject(new Error(`case ${caseFile.id} already open`));
    this.cases.set(caseFile.id, {
      caseFile,
      stage: 'intake',
      budget: {
        remainingInputTokens: budget.maxInputTokens,
        remainingOutputTokens: budget.maxOutputTokens,
        remainingUsd: budget.maxUsd,
        exhausted: false,
      },
      appeals: 0,
      seq: 0,
      verdict: null,
      costs: [],
      releases: new Map(),
    });
    return Promise.resolve();
  }

  stage(caseId: CaseId): Promise<CaseStage> {
    return Promise.resolve(this.rec(caseId).stage);
  }

  transition(caseId: CaseId, to: CaseStage): Promise<void> {
    const r = this.rec(caseId);
    const from = r.stage;
    const fail = (why: string): Promise<void> =>
      Promise.reject(new IllegalTransitionError(from, to, why));

    if (!isLegalTransition(from, to)) return fail('not in the transition table');
    // F3 applies to every way into `dismissed` (CR-3), not only defense.
    if (to === 'dismissed' && r.caseFile.candidate.score >= r.caseFile.escalationFloor) {
      return fail(
        'score is at or above the escalation floor, so the case cannot be dismissed (F3)',
      );
    }
    if (from === 'verify' && to === 'remedy') {
      if (r.appeals >= MAX_APPEALS) return fail(`appeal limit of ${MAX_APPEALS} reached`);
      r.appeals += 1;
    }
    if (from === 'verify' && to === 'jury' && !this.juryEnabled) return fail('jury is disabled');
    // With the jury enabled every verdict passes through it, appeals exhausted or not (CR-3).
    if (from === 'verify' && to === 'verdict' && this.juryEnabled) {
      return fail('jury is enabled; verify must go to jury, remedy, or escalated');
    }
    r.stage = to;
    return Promise.resolve();
  }

  chargeBudget(caseId: CaseId, cost: StageCost): Promise<BudgetState> {
    const r = this.rec(caseId);
    r.costs.push(cost);
    const b = r.budget;
    b.remainingInputTokens -= cost.inputTokens;
    b.remainingOutputTokens -= cost.outputTokens;
    b.remainingUsd = Math.round((b.remainingUsd - cost.usd) * 1e6) / 1e6;
    b.exhausted =
      b.remainingInputTokens <= 0 || b.remainingOutputTokens <= 0 || b.remainingUsd <= 0;
    return Promise.resolve({ ...b });
  }

  releaseCharge(caseId: CaseId, refundIn: StageCost, reservationSeq: number): Promise<BudgetState> {
    const r = this.rec(caseId);
    // Idempotent on (caseId, reservationSeq): a replayed release changes nothing.
    if (r.releases.has(reservationSeq)) return Promise.resolve({ ...r.budget });
    const reject = (why: string): Promise<BudgetState> =>
      Promise.reject(new ReleaseRejectedError(caseId, reservationSeq, why));

    if (!Number.isInteger(reservationSeq) || reservationSeq < 0)
      return reject('reservationSeq is not a non-negative integer');
    const parsed = StageCostSchema.safeParse(refundIn);
    if (!parsed.success) return reject('refund is not a valid StageCost');
    const refund = parsed.data;

    if (this.events) {
      const charge = this.events.events(caseId).find((e) => e.seq === reservationSeq);
      if (charge?.type !== 'cost-charged') return reject('no cost-charged event at that seq');
      const c = charge.payload.cost;
      if (c.stage !== refund.stage || c.attempt !== refund.attempt)
        return reject('refund names a different stage or attempt than the charge');
      if (
        refund.inputTokens > c.inputTokens ||
        refund.outputTokens > c.outputTokens ||
        round6(refund.usd) > round6(c.usd) ||
        refund.wallMs > c.wallMs
      ) {
        return reject('refund exceeds the charge it releases');
      }
    }

    // The ledger never goes negative: releases never exceed charges, field by field.
    const sum = (list: Iterable<StageCost>) => {
      const t = { inputTokens: 0, outputTokens: 0, usd: 0 };
      for (const x of list) {
        t.inputTokens += x.inputTokens;
        t.outputTokens += x.outputTokens;
        t.usd = round6(t.usd + x.usd);
      }
      return t;
    };
    const charged = sum(r.costs);
    const released = sum(r.releases.values());
    if (
      released.inputTokens + refund.inputTokens > charged.inputTokens ||
      released.outputTokens + refund.outputTokens > charged.outputTokens ||
      round6(released.usd + refund.usd) > charged.usd
    ) {
      return reject('would release more than the case was charged');
    }

    r.releases.set(reservationSeq, refund);
    const b = r.budget;
    b.remainingInputTokens += refund.inputTokens;
    b.remainingOutputTokens += refund.outputTokens;
    b.remainingUsd = round6(b.remainingUsd + refund.usd);
    b.exhausted =
      b.remainingInputTokens <= 0 || b.remainingOutputTokens <= 0 || b.remainingUsd <= 0;
    return Promise.resolve({ ...b });
  }

  nextSeq(caseId: CaseId): Promise<number> {
    const r = this.rec(caseId);
    return Promise.resolve(r.seq++);
  }

  appendVerdict(verdict: Verdict): Promise<void> {
    const r = this.rec(verdict.caseId);
    if (r.verdict) return Promise.reject(new VerdictAlreadyWrittenError(verdict.caseId));
    r.verdict = verdict;
    return Promise.resolve();
  }

  getVerdict(caseId: CaseId): Promise<Verdict | null> {
    return Promise.resolve(this.rec(caseId).verdict);
  }

  /** Test helper: every charge recorded for a case, in order. */
  charges(caseId: CaseId): readonly StageCost[] {
    return this.rec(caseId).costs;
  }

  /** Test helper (v1.2, CR-T1): every release recorded for a case, by reservation seq. */
  releases(caseId: CaseId): ReadonlyMap<number, StageCost> {
    return this.rec(caseId).releases;
  }
}

/** In-memory EventSink, idempotent on (caseId, seq). */
export class FakeEventSink implements EventSink {
  private readonly byKey = new Map<string, TrialEvent>();

  emit(event: TrialEvent): Promise<void> {
    const key = `${event.caseId}:${event.seq}`;
    if (!this.byKey.has(key)) this.byKey.set(key, event);
    return Promise.resolve();
  }

  /** Events for a case ordered by seq. */
  events(caseId?: CaseId): TrialEvent[] {
    return [...this.byKey.values()]
      .filter((e) => caseId === undefined || e.caseId === caseId)
      .sort((a, b) => a.seq - b.seq);
  }
}
