import { CaseFile, Exhibit, Witness } from '@affidavit/contracts';
import type {
  ExhibitId,
  ExhibitResult,
  JudgePort,
  ParamSpace,
  TargetRef,
  TargetVariant,
  VerifyResult,
} from '@affidavit/contracts';
import { familySize } from './artifact.js';
import { exhibitDigest, sha256Hex, canonicalJson } from './canonical.js';
import type { EvidenceVariant, WitnessExecutor } from './executor.js';
import { ATTEMPTS, DEFAULT_POLICY, judgeEvidence, rejectBeforeRunning } from './rules.js';
import type { JudgePolicy, ObservedAttempt } from './rules.js';

/** Exhibit id the Judge assigns to a witness: stable for the same template and family. */
export function witnessExhibitId(witness: Pick<Witness, 'template' | 'params'>): ExhibitId {
  return `exhibit-witness-${exhibitDigest('witness', witness.template, witness.params).slice(0, 24)}` as ExhibitId;
}

interface Runnable {
  exhibitId: ExhibitId;
  template: string;
  params: ParamSpace;
}

/**
 * The Judge (L2-06): runs witnesses and counterexamples through a `WitnessExecutor` and applies
 * the rules of evidence. It is code, not an agent, and it trusts neither the submitted exhibit
 * nor the caller's choice of variants.
 */
export class Judge implements JudgePort {
  readonly #executor: WitnessExecutor;
  readonly #policy: Readonly<JudgePolicy>;

  constructor(executor: WitnessExecutor, policy: Readonly<JudgePolicy> = DEFAULT_POLICY) {
    if (policy.timeBudgetMs >= policy.hardTimeoutMs) {
      throw new Error('timeBudgetMs must be below hardTimeoutMs');
    }
    this.#executor = executor;
    this.#policy = policy;
  }

  async runWitness(
    caseFile: CaseFile,
    witness: Witness,
    variants: readonly TargetVariant[],
  ): Promise<ExhibitResult> {
    const cf = CaseFile.parse(caseFile);
    const targets = this.#targets(cf, variants);
    const w = Witness.safeParse(witness);
    if (!w.success) return rejectBeforeRunning(fallbackId('witness', witness), 'schema');
    const exhibitId = witnessExhibitId(w.data);
    if (w.data.caseId !== cf.id || !this.#familyAllowed(w.data.params)) {
      return rejectBeforeRunning(exhibitId, 'schema');
    }
    return this.#run(cf, targets, { exhibitId, template: w.data.template, params: w.data.params });
  }

  /**
   * Runs a Prosecution counterexample under the same rules as a witness, over the witness's
   * parameter space so it is not limited to the one input Defense used.
   */
  async runCounterexample(
    caseFile: CaseFile,
    witness: Witness,
    counterexample: Exhibit,
  ): Promise<ExhibitResult> {
    const cf = CaseFile.parse(caseFile);
    const targets = this.#targets(cf, ['vulnerable']);
    const c = Exhibit.safeParse(counterexample);
    if (!c.success)
      return rejectBeforeRunning(fallbackId('counterexample', counterexample), 'schema');
    const w = Witness.safeParse(witness);
    if (
      c.data.kind !== 'counterexample' ||
      c.data.caseId !== cf.id ||
      !w.success ||
      w.data.caseId !== cf.id ||
      !this.#familyAllowed(w.data.params)
    ) {
      return rejectBeforeRunning(c.data.id, 'schema');
    }
    return this.#run(cf, targets, {
      exhibitId: c.data.id,
      template: c.data.code,
      params: w.data.params,
    });
  }

  verifyPatch(): Promise<VerifyResult> {
    return Promise.reject(new Error('verifyPatch is task L2-07 and is not implemented yet'));
  }

  #familyAllowed(params: ParamSpace): boolean {
    return familySize(params) <= this.#policy.maxFamilySize;
  }

  /**
   * The variants that will actually run. `vulnerable` is required. When the case file has a safe
   * variant it is always run, whatever the caller asked for, so differential proof cannot be
   * skipped (F2). Asking for a safe variant that does not exist, or for `patched`, is a caller bug.
   */
  #targets(cf: CaseFile, variants: readonly TargetVariant[]): [EvidenceVariant, TargetRef][] {
    if (variants.includes('patched')) {
      throw new Error('the patched variant is judged by verifyPatch, not runWitness');
    }
    if (!variants.includes('vulnerable')) throw new Error('the vulnerable variant must be run');
    if (variants.includes('safe') && cf.safeVariant === undefined) {
      throw new Error(`case ${cf.id} has no safe variant`);
    }
    const out: [EvidenceVariant, TargetRef][] = [['vulnerable', cf.target]];
    if (cf.safeVariant !== undefined) out.push(['safe', cf.safeVariant]);
    return out;
  }

  /** Runs attempts one at a time so one run cannot disturb another's timing or state. */
  async #run(
    caseFile: CaseFile,
    targets: readonly [EvidenceVariant, TargetRef][],
    r: Runnable,
  ): Promise<ExhibitResult> {
    const attempts: ObservedAttempt[] = [];
    for (const [variant, target] of targets) {
      for (const attempt of ATTEMPTS) {
        const raw = await this.#executor.execute({
          caseFile,
          variant,
          target,
          attempt,
          template: r.template,
          params: r.params,
          timeoutMs: this.#policy.hardTimeoutMs,
        });
        attempts.push({ ...raw, variant, attempt });
      }
    }
    return judgeEvidence(
      { exhibitId: r.exhibitId, familySize: familySize(r.params), attempts },
      this.#policy,
    );
  }
}

/** Id for an exhibit too malformed to read its fields; still stable for the same input. */
function fallbackId(kind: 'witness' | 'counterexample', value: unknown): ExhibitId {
  return `exhibit-${kind}-invalid-${sha256Hex(canonicalJson(value)).slice(0, 24)}` as ExhibitId;
}
