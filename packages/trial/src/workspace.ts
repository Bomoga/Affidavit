import type {
  CaseId,
  ExhibitId,
  ExhibitResult,
  PatchExhibit,
  VerifyResult,
  Witness,
} from '@affidavit/contracts';

/** A witness the Judge admitted, with the result that admitted it. */
export interface AdmittedWitness {
  witness: Witness;
  result: ExhibitResult;
}

/**
 * Hand-off between stages inside one trial. Lane-internal state, not a contract: it holds contract
 * objects built in code and results returned by the Judge, never agent claims.
 */
export interface TrialWorkspace {
  saveWitness(caseId: CaseId, admitted: AdmittedWitness): Promise<void>;
  getWitness(caseId: CaseId): Promise<AdmittedWitness | undefined>;
  /** Exhibit ids the Judge admitted or verified, in the order they were produced. */
  addExhibit(caseId: CaseId, exhibitId: ExhibitId): Promise<void>;
  getExhibits(caseId: CaseId): Promise<ExhibitId[]>;
  savePatchOutcome(caseId: CaseId, outcome: PatchOutcome): Promise<void>;
  getPatchOutcome(caseId: CaseId): Promise<PatchOutcome | undefined>;
}

/** What Remedy ended with. `accepted` is true only when the Judge's VerifyResult says so. */
export interface PatchOutcome {
  accepted: boolean;
  patch?: PatchExhibit;
  result?: VerifyResult;
  reason: string;
}

export class InMemoryWorkspace implements TrialWorkspace {
  private readonly witnesses = new Map<CaseId, AdmittedWitness>();
  private readonly exhibits = new Map<CaseId, ExhibitId[]>();
  private readonly patches = new Map<CaseId, PatchOutcome>();

  savePatchOutcome(caseId: CaseId, outcome: PatchOutcome): Promise<void> {
    this.patches.set(caseId, outcome);
    return Promise.resolve();
  }

  getPatchOutcome(caseId: CaseId): Promise<PatchOutcome | undefined> {
    return Promise.resolve(this.patches.get(caseId));
  }

  saveWitness(caseId: CaseId, admitted: AdmittedWitness): Promise<void> {
    this.witnesses.set(caseId, admitted);
    return Promise.resolve();
  }

  getWitness(caseId: CaseId): Promise<AdmittedWitness | undefined> {
    return Promise.resolve(this.witnesses.get(caseId));
  }

  addExhibit(caseId: CaseId, exhibitId: ExhibitId): Promise<void> {
    const list = this.exhibits.get(caseId) ?? [];
    if (!list.includes(exhibitId)) list.push(exhibitId);
    this.exhibits.set(caseId, list);
    return Promise.resolve();
  }

  getExhibits(caseId: CaseId): Promise<ExhibitId[]> {
    return Promise.resolve([...(this.exhibits.get(caseId) ?? [])]);
  }
}
