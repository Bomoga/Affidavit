import type { CaseId, ExhibitId, VerifyResult, Witness, PatchExhibit } from '@affidavit/contracts';

/** What Remedy leaves for the verify stage. Acceptance comes only from the Judge's result. */
export interface PatchOutcome {
  accepted: boolean;
  patch?: PatchExhibit;
  result?: VerifyResult;
  reason?: string;
}

/**
 * In-lane handoff between stages: the admitted witness, the exhibits the Judge ruled on, and the
 * patch outcome. The contracts have no port for this yet (see docs/lanes/lane3/contract-requests-trial.md,
 * CR-T6), so it lives here as a small interface the worker can back with the case store later.
 */
export interface TrialWorkspace {
  saveWitness(caseId: CaseId, witness: Witness): Promise<void>;
  getWitness(caseId: CaseId): Promise<Witness | undefined>;
  addExhibit(caseId: CaseId, exhibitId: ExhibitId): Promise<void>;
  getExhibits(caseId: CaseId): Promise<readonly ExhibitId[]>;
  savePatchOutcome(caseId: CaseId, outcome: PatchOutcome): Promise<void>;
  getPatchOutcome(caseId: CaseId): Promise<PatchOutcome | undefined>;
}

export class InMemoryWorkspace implements TrialWorkspace {
  private readonly witnesses = new Map<CaseId, Witness>();
  private readonly exhibits = new Map<CaseId, ExhibitId[]>();
  private readonly outcomes = new Map<CaseId, PatchOutcome>();

  saveWitness(caseId: CaseId, witness: Witness): Promise<void> {
    this.witnesses.set(caseId, witness);
    return Promise.resolve();
  }
  getWitness(caseId: CaseId): Promise<Witness | undefined> {
    return Promise.resolve(this.witnesses.get(caseId));
  }
  addExhibit(caseId: CaseId, exhibitId: ExhibitId): Promise<void> {
    const list = this.exhibits.get(caseId) ?? [];
    if (!list.includes(exhibitId)) list.push(exhibitId);
    this.exhibits.set(caseId, list);
    return Promise.resolve();
  }
  getExhibits(caseId: CaseId): Promise<readonly ExhibitId[]> {
    return Promise.resolve([...(this.exhibits.get(caseId) ?? [])]);
  }
  savePatchOutcome(caseId: CaseId, outcome: PatchOutcome): Promise<void> {
    this.outcomes.set(caseId, outcome);
    return Promise.resolve();
  }
  getPatchOutcome(caseId: CaseId): Promise<PatchOutcome | undefined> {
    return Promise.resolve(this.outcomes.get(caseId));
  }
}
