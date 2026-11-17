import type {
  Budget,
  CaseFile,
  CaseId,
  CaseStage,
  CaseStore,
  EventSink,
  StageCost,
  TrialEvent,
  Verdict,
} from '@affidavit/contracts';

/**
 * Port writes are not fenced by the stage-run lease (packages/db/CLAUDE.md), so a handler whose
 * lease was lost must not write. These wrappers refuse every write once the job's signal aborted.
 */
export class LeaseLostError extends Error {
  constructor() {
    super('lease lost: refusing a port write after the stage signal aborted');
    this.name = 'LeaseLostError';
  }
}

function check(signal: AbortSignal): void {
  if (signal.aborted) throw new LeaseLostError();
}

export class GuardedCaseStore implements CaseStore {
  constructor(
    private readonly inner: CaseStore,
    private readonly signal: AbortSignal,
  ) {}

  open(caseFile: CaseFile, budget: Budget) {
    check(this.signal);
    return this.inner.open(caseFile, budget);
  }
  stage(caseId: CaseId) {
    return this.inner.stage(caseId);
  }
  transition(caseId: CaseId, to: CaseStage) {
    check(this.signal);
    return this.inner.transition(caseId, to);
  }
  chargeBudget(caseId: CaseId, cost: StageCost) {
    check(this.signal);
    return this.inner.chargeBudget(caseId, cost);
  }
  nextSeq(caseId: CaseId) {
    check(this.signal);
    return this.inner.nextSeq(caseId);
  }
  appendVerdict(verdict: Verdict) {
    check(this.signal);
    return this.inner.appendVerdict(verdict);
  }
  getVerdict(caseId: CaseId) {
    return this.inner.getVerdict(caseId);
  }
}

export class GuardedEventSink implements EventSink {
  constructor(
    private readonly inner: EventSink,
    private readonly signal: AbortSignal,
  ) {}

  emit(event: TrialEvent) {
    check(this.signal);
    return this.inner.emit(event);
  }
}
