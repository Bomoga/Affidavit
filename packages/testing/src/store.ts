import {
  IllegalTransitionError,
  MAX_APPEALS,
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
}

export interface FakeCaseStoreOptions {
  /** When false, verify goes straight to verdict and jury is unreachable. Default true. */
  juryEnabled?: boolean;
}

/** In-memory CaseStore that enforces the same rules the Postgres store must. */
export class FakeCaseStore implements CaseStore {
  private readonly cases = new Map<CaseId, CaseRecord>();
  private readonly juryEnabled: boolean;

  constructor(options: FakeCaseStoreOptions = {}) {
    this.juryEnabled = options.juryEnabled ?? true;
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
    if (
      from === 'defense' &&
      to === 'dismissed' &&
      r.caseFile.candidate.score >= r.caseFile.escalationFloor
    ) {
      return fail(
        'score is at or above the escalation floor, so the case cannot be dismissed (F3)',
      );
    }
    if (from === 'verify' && to === 'remedy') {
      if (r.appeals >= MAX_APPEALS) return fail(`appeal limit of ${MAX_APPEALS} reached`);
      r.appeals += 1;
    }
    if (from === 'verify' && to === 'jury' && !this.juryEnabled) return fail('jury is disabled');
    if (from === 'verify' && to === 'verdict' && this.juryEnabled && r.appeals < MAX_APPEALS) {
      return fail(
        'jury is enabled and appeals remain; verify must go to jury, remedy, or escalated',
      );
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
