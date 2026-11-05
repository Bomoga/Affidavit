import type {
  CaseFile,
  Candidate,
  Exhibit,
  ExhibitResult,
  JudgePort,
  PatchExhibit,
  RescanPort,
  TargetVariant,
  VerifyResult,
  Witness,
} from '@affidavit/contracts';

export class NoScriptedResultError extends Error {
  constructor(kind: string, key: string) {
    super(
      `no scripted ${kind} for sha256 ${key}; add it to the fixture set the fake was built from`,
    );
    this.name = 'NoScriptedResultError';
  }
}

export interface JudgeScript {
  /** Keyed by Witness.sha256. */
  witnessResults: Readonly<Record<string, ExhibitResult>>;
  /** Keyed by counterexample Exhibit.sha256. */
  counterexampleResults?: Readonly<Record<string, ExhibitResult>>;
  /** Keyed by PatchExhibit.sha256. */
  verifyResults?: Readonly<Record<string, VerifyResult>>;
}

/** Scripted Judge: returns recorded results. Never runs code, so it needs no sandbox. */
export class FakeJudge implements JudgePort {
  readonly calls: { method: string; sha256: string; variants?: readonly TargetVariant[] }[] = [];

  constructor(private readonly script: JudgeScript) {}

  runWitness(
    _caseFile: CaseFile,
    witness: Witness,
    variants: readonly TargetVariant[] = ['vulnerable'],
  ): Promise<ExhibitResult> {
    this.calls.push({ method: 'runWitness', sha256: witness.sha256, variants });
    const result = this.script.witnessResults[witness.sha256];
    if (!result) return Promise.reject(new NoScriptedResultError('witness result', witness.sha256));
    return Promise.resolve(result);
  }

  runCounterexample(
    _caseFile: CaseFile,
    _witness: Witness,
    counterexample: Exhibit,
  ): Promise<ExhibitResult> {
    this.calls.push({ method: 'runCounterexample', sha256: counterexample.sha256 });
    const result = this.script.counterexampleResults?.[counterexample.sha256];
    if (!result) {
      return Promise.reject(
        new NoScriptedResultError('counterexample result', counterexample.sha256),
      );
    }
    return Promise.resolve(result);
  }

  verifyPatch(_caseFile: CaseFile, patch: PatchExhibit): Promise<VerifyResult> {
    this.calls.push({ method: 'verifyPatch', sha256: patch.sha256 });
    const result = this.script.verifyResults?.[patch.sha256];
    if (!result) return Promise.reject(new NoScriptedResultError('verify result', patch.sha256));
    return Promise.resolve(result);
  }
}

export class FakeRescan implements RescanPort {
  constructor(
    private readonly outcome: { clean: boolean; candidates?: readonly Candidate[] } = {
      clean: true,
    },
  ) {}

  rescan(): Promise<{ clean: boolean; candidates: readonly Candidate[] }> {
    return Promise.resolve({
      clean: this.outcome.clean,
      candidates: this.outcome.candidates ?? [],
    });
  }
}
