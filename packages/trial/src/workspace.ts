import type {
  CaseId,
  Dismissal,
  Exhibit,
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

/** A counterexample the Judge found admissible, with the result that says so. */
export interface AdmittedCounterexample {
  exhibit: Exhibit;
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
  /** Admissible counterexamples in submission order. Remedy hands them to verifyPatch. */
  addCounterexample(caseId: CaseId, admitted: AdmittedCounterexample): Promise<void>;
  getCounterexamples(caseId: CaseId): Promise<AdmittedCounterexample[]>;
  savePatchOutcome(caseId: CaseId, outcome: PatchOutcome): Promise<void>;
  getPatchOutcome(caseId: CaseId): Promise<PatchOutcome | undefined>;
  /** The contract Dismissal recorded for the case, so a new instance can repair its verdict. */
  saveDismissal(caseId: CaseId, dismissal: Dismissal): Promise<void>;
  getDismissal(caseId: CaseId): Promise<Dismissal | undefined>;
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

  private readonly dismissals = new Map<CaseId, Dismissal>();
  private readonly counterexamples = new Map<CaseId, AdmittedCounterexample[]>();

  addCounterexample(caseId: CaseId, admitted: AdmittedCounterexample): Promise<void> {
    const list = this.counterexamples.get(caseId) ?? [];
    if (!list.some((c) => c.exhibit.id === admitted.exhibit.id)) list.push(admitted);
    this.counterexamples.set(caseId, list);
    return Promise.resolve();
  }

  getCounterexamples(caseId: CaseId): Promise<AdmittedCounterexample[]> {
    return Promise.resolve([...(this.counterexamples.get(caseId) ?? [])]);
  }

  saveDismissal(caseId: CaseId, dismissal: Dismissal): Promise<void> {
    this.dismissals.set(caseId, dismissal);
    return Promise.resolve();
  }

  getDismissal(caseId: CaseId): Promise<Dismissal | undefined> {
    return Promise.resolve(this.dismissals.get(caseId));
  }

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
