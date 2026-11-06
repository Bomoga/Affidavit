// INTERIM test fakes. Replace with @affidavit/testing fakes when P0-04 lands.
import {
  isTerminal,
  type CaseStage,
  type CaseStore,
  type ChargeReceipt,
  type Escalation,
  type EventSink,
  type JudgePort,
  type JudgeResult,
  type PatchOutcome,
  type PatchSubmission,
  type TrialWorkspace,
  type VerifyResult,
  type CaseFile,
  type WitnessSubmission,
  type ModelPort,
  type ModelTurnRequest,
  type ModelTurnResult,
  type StageCost,
  type TrialEvent,
} from '../interim/types.js';

const LEGAL: Record<string, readonly CaseStage[]> = {
  intake: ['map'],
  map: ['arraign'],
  arraign: ['defense', 'dismissed'],
  defense: ['prosecution', 'dismissed'],
  prosecution: ['remedy', 'dismissed'],
  remedy: ['verify'],
  verify: ['remedy', 'jury', 'verdict'],
  jury: ['verdict'],
};

export class FakeCaseStore implements CaseStore {
  stage: CaseStage;
  readonly transitions: CaseStage[] = [];
  readonly escalations: Escalation[] = [];
  readonly settled: StageCost[] = [];
  private readonly reservations = new Map<string, StageCost>();
  private spentUsd = 0;
  private spentTokens = 0;
  private seq = 0;
  private charges = 0;

  constructor(
    private readonly log: string[],
    private readonly budget: { usd: number; tokens: number },
    startStage: CaseStage = 'intake',
  ) {
    this.stage = startStage;
  }

  getStage(): Promise<CaseStage> {
    return Promise.resolve(this.stage);
  }

  transition(_caseId: string, to: CaseStage): Promise<void> {
    const legal = LEGAL[this.stage] ?? [];
    const okEscalation = to === 'escalated' && !isTerminal(this.stage);
    if (!legal.includes(to) && !okEscalation) {
      return Promise.reject(new Error(`illegal transition ${this.stage} -> ${to}`));
    }
    this.stage = to;
    this.transitions.push(to);
    return Promise.resolve();
  }

  chargeBudget(_caseId: string, cost: StageCost): Promise<ChargeReceipt> {
    const chargeId = `c${++this.charges}`;
    this.reservations.set(chargeId, cost);
    this.spentUsd += cost.usd;
    this.spentTokens += cost.inputTokens + cost.outputTokens;
    this.log.push(`charge:${cost.stage}:${cost.attempt}`);
    return Promise.resolve({
      chargeId,
      remainingUsd: this.budget.usd - this.spentUsd,
      remainingTokens: this.budget.tokens - this.spentTokens,
    });
  }

  settleCost(_caseId: string, chargeId: string, actual: StageCost): Promise<void> {
    const reserved = this.reservations.get(chargeId);
    if (!reserved) return Promise.reject(new Error(`unknown charge ${chargeId}`));
    this.spentUsd += actual.usd - reserved.usd;
    this.spentTokens +=
      actual.inputTokens + actual.outputTokens - (reserved.inputTokens + reserved.outputTokens);
    this.reservations.delete(chargeId);
    this.settled.push(actual);
    this.log.push(`settle:${actual.stage}:${actual.attempt}`);
    return Promise.resolve();
  }

  recordEscalation(escalation: Escalation): Promise<void> {
    this.escalations.push(escalation);
    return Promise.resolve();
  }

  nextSeq(): Promise<number> {
    return Promise.resolve(++this.seq);
  }
}

export class FakeEventSink implements EventSink {
  readonly events: TrialEvent[] = [];
  emit(event: TrialEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

/** Replays scripted results in order. Never makes a live model call. */
export class FakeModel implements ModelPort {
  readonly requests: ModelTurnRequest[] = [];
  constructor(
    private readonly log: string[],
    private readonly script: ModelTurnResult[],
  ) {}

  runTurn(req: ModelTurnRequest): Promise<ModelTurnResult> {
    this.requests.push(req);
    const next = this.script.shift();
    if (!next) return Promise.reject(new Error('model script exhausted'));
    this.log.push(`model:${next.cost.stage}:${next.cost.attempt}`);
    return Promise.resolve(next);
  }
}

/** Scripted Judge: returns recorded results in order. The only source of pass or fail. */
export class FakeJudge implements JudgePort {
  readonly calls: WitnessSubmission[] = [];
  readonly patches: PatchSubmission[] = [];
  constructor(
    private readonly script: JudgeResult[] = [],
    private readonly verifyScript: VerifyResult[] = [],
  ) {}

  verifyPatch(_caseFile: CaseFile, patch: PatchSubmission): Promise<VerifyResult> {
    this.patches.push(patch);
    const next = this.verifyScript.shift();
    if (!next) return Promise.reject(new Error('verify script exhausted'));
    return Promise.resolve(next);
  }

  runWitness(_caseFile: CaseFile, witness: WitnessSubmission): Promise<JudgeResult> {
    this.calls.push(witness);
    const next = this.script.shift();
    if (!next) return Promise.reject(new Error('judge script exhausted'));
    return Promise.resolve(next);
  }
}

export class InMemoryWorkspace implements TrialWorkspace {
  private witness = new Map<string, WitnessSubmission>();
  private outcome = new Map<string, PatchOutcome>();
  saveWitness(caseId: string, w: WitnessSubmission): Promise<void> {
    this.witness.set(caseId, w);
    return Promise.resolve();
  }
  getWitness(caseId: string): Promise<WitnessSubmission | undefined> {
    return Promise.resolve(this.witness.get(caseId));
  }
  savePatchOutcome(caseId: string, o: PatchOutcome): Promise<void> {
    this.outcome.set(caseId, o);
    return Promise.resolve();
  }
  getPatchOutcome(caseId: string): Promise<PatchOutcome | undefined> {
    return Promise.resolve(this.outcome.get(caseId));
  }
}
