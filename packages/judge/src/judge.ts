import { CaseFile, Exhibit, PatchExhibit, VerifyResult, Witness } from '@affidavit/contracts';
import type {
  AdmissibilityRule,
  ExhibitId,
  ExhibitResult,
  JudgePort,
  ParamSpace,
  RescanPort,
  TargetRef,
  TargetVariant,
} from '@affidavit/contracts';
import { familySize } from './artifact.js';
import { EXHIBIT_ID_HEX_CHARS, canonicalJson, mintExhibitId, sha256Hex } from './canonical.js';
import type { ExecutionVariant, WitnessExecutor } from './executor.js';
import { addedLines, parseUnifiedDiff, selectFiles } from './patch/diff.js';
import type { ParsedDiff } from './patch/diff.js';
import {
  findLiteralSpecialCases,
  findSuiteTampering,
  isTestFile,
  testFilesOf,
} from './patch/literal.js';
import type { PatchPlan, PatchWorkbench, PreparedPatch } from './patch/workbench.js';
import {
  ATTEMPTS,
  DEFAULT_POLICY,
  counterexampleSurvives,
  judgeEvidence,
  judgePatchedFamily,
  rejectBeforeRunning,
} from './rules.js';
import type { JudgePolicy, ObservedAttempt } from './rules.js';

/** What verifyPatch needs besides the executor: somewhere to build the patch, and Lane 1's re-scan. */
export interface PatchVerification {
  workbench: PatchWorkbench;
  rescan: RescanPort;
}

/**
 * Exhibit id the Judge assigns to a witness: stable for the same case, template and family.
 * Lane 3 can recompute it from the Witness fields (rules-of-evidence.md, "Exhibit ids").
 */
export function witnessExhibitId(
  witness: Pick<Witness, 'caseId' | 'template' | 'params'>,
): ExhibitId {
  return mintExhibitId('witness', witness.caseId, witness.template, witness.params);
}

/**
 * Exhibit id the Judge assigns to a counterexample, minted the same way as a witness id: from the
 * counterexample's case and code over the family it runs on (the witness's parameter space). The
 * submitted `Exhibit.id` is never echoed back, so a caller cannot choose the id of its own result.
 */
export function counterexampleExhibitId(
  counterexample: Pick<Exhibit, 'caseId' | 'code'>,
  params: ParamSpace,
): ExhibitId {
  return mintExhibitId('counterexample', counterexample.caseId, counterexample.code, params);
}

/**
 * Exhibit id the Judge assigns to a patch: `exhibit-patch-` plus the first 24 hex digits of the
 * SHA-256 of canonical JSON `{caseId, diff, kind: "patch"}`. The same recipe Lane 3 uses to build
 * the PatchExhibit (packages/trial/src/patch.ts), documented in rules-of-evidence.md.
 */
export function patchExhibitId(patch: Pick<PatchExhibit, 'caseId' | 'diff'>): ExhibitId {
  const digest = sha256Hex(
    canonicalJson({ caseId: patch.caseId, diff: patch.diff, kind: 'patch' }),
  );
  return `exhibit-patch-${digest.slice(0, EXHIBIT_ID_HEX_CHARS)}` as ExhibitId;
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
  readonly #verify: PatchVerification | undefined;

  constructor(
    executor: WitnessExecutor,
    policy: Readonly<JudgePolicy> = DEFAULT_POLICY,
    verify?: PatchVerification,
  ) {
    if (policy.timeBudgetMs >= policy.hardTimeoutMs) {
      throw new Error('timeBudgetMs must be below hardTimeoutMs');
    }
    if (!Number.isSafeInteger(policy.maxOutputBytes) || policy.maxOutputBytes < 0) {
      throw new Error('maxOutputBytes must be a non-negative integer');
    }
    this.#executor = executor;
    this.#policy = policy;
    this.#verify = verify;
  }

  async runWitness(
    caseFile: CaseFile,
    witness: Witness,
    variants: readonly TargetVariant[],
  ): Promise<ExhibitResult> {
    const cf = CaseFile.parse(caseFile);
    const targets = this.#targets(cf, variants);
    const w = safely(() => Witness.safeParse(witness));
    if (!w?.success) return rejectBeforeRunning(fallbackId('witness', witness), 'schema');
    const exhibitId = safely(() => witnessExhibitId(w.data));
    if (exhibitId === undefined) {
      return rejectBeforeRunning(fallbackId('witness', witness), 'schema');
    }
    if (!this.#witnessFits(cf, w.data)) return rejectBeforeRunning(exhibitId, 'schema');
    return this.#run(cf, targets, { exhibitId, template: w.data.template, params: w.data.params });
  }

  /**
   * Runs a Prosecution counterexample under the same rules as a witness, over the witness's
   * parameter space so it is not limited to the one input Defense used.
   *
   * For a counterexample, `admissible` (and `passed`, which always equals it) means the
   * counterexample is usable evidence: it passed every rule, so the whole family passes on
   * `vulnerable` and, when a safe variant exists, fails on `safe`. It says nothing about any
   * patch. Whether a counterexample defeats a patch is `VerifyResult.counterexamples[].survived`
   * from `verifyPatch` (L2-07), which only ever reruns admissible counterexamples.
   */
  async runCounterexample(
    caseFile: CaseFile,
    witness: Witness,
    counterexample: Exhibit,
  ): Promise<ExhibitResult> {
    const cf = CaseFile.parse(caseFile);
    const targets = this.#targets(cf, ['vulnerable']);
    const c = safely(() => Exhibit.safeParse(counterexample));
    if (!c?.success) {
      return rejectBeforeRunning(fallbackId('counterexample', counterexample), 'schema');
    }
    const w = safely(() => Witness.safeParse(witness));
    if (!w?.success) {
      return rejectBeforeRunning(fallbackId('counterexample', counterexample), 'schema');
    }
    const exhibitId = safely(() => counterexampleExhibitId(c.data, w.data.params));
    if (exhibitId === undefined) {
      return rejectBeforeRunning(fallbackId('counterexample', counterexample), 'schema');
    }
    if (
      c.data.kind !== 'counterexample' ||
      c.data.caseId !== cf.id ||
      utf8Bytes(c.data.code) > this.#policy.maxSourceBytes ||
      !this.#witnessFits(cf, w.data)
    ) {
      return rejectBeforeRunning(exhibitId, 'schema');
    }
    return this.#run(cf, targets, {
      exhibitId,
      template: c.data.code,
      params: w.data.params,
    });
  }

  /**
   * L2-07, F5. Cheap static rules first, so a bad patch never costs a build:
   * `schema` (unreadable exhibit, witness or diff, a hash or code field that disagrees with the
   * diff, declared counts that disagree with the diff, or a patch that does not apply),
   * `diff-too-large`, `suite-fails` for a patch that weakens the test suite, and
   * `literal-only-patch`. Then the patch is built and every dynamic check runs, so an appeal gets
   * the whole picture: the witness family on the vulnerable commit (must pass) and on the patched
   * target (must fail on every parameter), the target's test suite, every admissible
   * counterexample on the patched target, and the discovery re-scan.
   *
   * Ids are minted by the Judge: the patch from its case and diff (`patchExhibitId`), each
   * counterexample from its case, code and the witness's family (`counterexampleExhibitId`).
   * Submitted ids are never echoed back.
   *
   * A counterexample counts against the patch only once it is admissible: it reruns on
   * `vulnerable` (and `safe`, when the case has one) under every rule of evidence first. An
   * inadmissible or malformed counterexample is reported `survived: false` and is not used. When
   * the patch is refused before any counterexample ran, every readable counterexample is reported
   * as surviving (nothing was shown) and unreadable ones as `survived: false`.
   *
   * `rejectedBy` names the first failed rule in that order. A failed re-scan has no rule of its
   * own in contracts v1.0 and shows only as `rescanClean: false`. When a check never ran, its
   * flag is false.
   */
  async verifyPatch(
    caseFile: CaseFile,
    patch: PatchExhibit,
    witness: Witness,
    counterexamples: readonly Exhibit[],
  ): Promise<VerifyResult> {
    const cf = CaseFile.parse(caseFile);
    const deps = this.#verify;
    if (deps === undefined) throw new Error('verifyPatch needs a PatchWorkbench and a RescanPort');
    const p = safely(() => PatchExhibit.safeParse(patch));
    const minted = p?.success ? safely(() => patchExhibitId(p.data)) : undefined;
    const patchId = minted ?? fallbackId('patch', patch);
    const w = safely(() => Witness.safeParse(witness));
    const params = w?.success ? w.data.params : undefined;
    const counters = counterexamples.map((c) => {
      const parsed = safely(() => Exhibit.safeParse(c));
      const usable =
        parsed?.success === true &&
        parsed.data.kind === 'counterexample' &&
        parsed.data.caseId === cf.id &&
        utf8Bytes(parsed.data.code) <= this.#policy.maxSourceBytes;
      const exhibitId =
        parsed?.success === true && params !== undefined
          ? (safely(() => counterexampleExhibitId(parsed.data, params)) ??
            fallbackId('counterexample', c))
          : fallbackId('counterexample', c);
      return { exhibitId, code: usable && parsed?.success ? parsed.data.code : undefined };
    });
    const reject = (rule: AdmissibilityRule): VerifyResult =>
      VerifyResult.parse({
        schemaVersion: 1,
        patchExhibitId: patchId,
        familyFlipped: false,
        suitePassed: false,
        rescanClean: false,
        counterexamples: counters.map((c) => ({
          exhibitId: c.exhibitId,
          survived: c.code !== undefined,
        })),
        rejectedBy: rule,
      });

    if (
      !p?.success ||
      minted === undefined ||
      p.data.caseId !== cf.id ||
      p.data.author !== 'remedy' ||
      p.data.code !== p.data.diff ||
      p.data.sha256 !== sha256Hex(p.data.diff)
    ) {
      return reject('schema');
    }
    if (utf8Bytes(p.data.diff) > this.#policy.maxSourceBytes) return reject('schema');
    if (!w?.success || !this.#witnessFits(cf, w.data)) return reject('schema');
    const parse = parseUnifiedDiff(p.data.diff);
    if (!parse.ok || !declaredMatches(p.data, parse.diff)) return reject('schema');
    const diff = parse.diff;
    if (
      diff.linesChanged > this.#policy.maxPatchLinesChanged ||
      diff.files.length > this.#policy.maxPatchFiles
    ) {
      return reject('diff-too-large');
    }
    if (findSuiteTampering(diff).length > 0) return reject('suite-fails');
    if (findLiteralSpecialCases(addedLines(diff), w.data.params, testFilesOf(diff)).length > 0) {
      return reject('literal-only-patch');
    }

    const plan: PatchPlan = {
      full: diff,
      code: selectFiles(diff, (f) => !isTestFile(f.path)),
      tests: selectFiles(diff, (f) => isTestFile(f.path)),
    };
    const outcome = await deps.workbench.prepare(cf, p.data, plan);
    if (!outcome.ok) return reject(outcome.stage === 'apply' ? 'schema' : 'suite-fails');
    const prepared = outcome.prepared;
    try {
      checkPrepared(cf, prepared);
      const params = w.data.params;
      const size = familySize(params);
      const family = judgePatchedFamily(
        {
          exhibitId: patchId,
          familySize: size,
          attempts: await this.#attempts(
            cf,
            [
              ['vulnerable', cf.target],
              ['patched', prepared.target],
            ],
            w.data.template,
            params,
          ),
        },
        this.#policy,
      );
      // The vulnerable commit's own suite, on the same build the witness ran against. The
      // patch's own tests are an extra check: a failure counts, a pass is never required.
      const ownSuite = await deps.workbench.runSuite(cf, prepared);
      const addedTests =
        plan.tests.files.length === 0 ? null : await deps.workbench.runAddedTests(cf, prepared);
      const suite = { passed: ownSuite.passed === true && addedTests?.passed !== false };
      const results: VerifyResult['counterexamples'] = [];
      for (const { exhibitId, code } of counters) {
        if (code === undefined) {
          results.push({ exhibitId, survived: false });
          continue;
        }
        // Admissibility first, on the same variants runCounterexample uses: only usable
        // evidence may count against the patch.
        const admitted = judgeEvidence(
          {
            exhibitId,
            familySize: size,
            attempts: await this.#attempts(cf, this.#targets(cf, ['vulnerable']), code, params),
          },
          this.#policy,
        );
        if (!admitted.admissible) {
          results.push({ exhibitId, survived: false });
          continue;
        }
        const attempts = await this.#attempts(cf, [['patched', prepared.target]], code, params);
        const survived = counterexampleSurvives(
          { exhibitId, familySize: size, attempts },
          this.#policy,
        );
        results.push({ exhibitId, survived });
      }
      const rescan = await deps.rescan.rescan(cf, prepared.workspacePath);

      const rejectedBy: AdmissibilityRule | undefined =
        family.rejectedBy ??
        (!suite.passed
          ? 'suite-fails'
          : results.some((c) => c.survived)
            ? 'counterexample-survives'
            : undefined);
      return VerifyResult.parse({
        schemaVersion: 1,
        patchExhibitId: patchId,
        familyFlipped: family.familyFlipped,
        suitePassed: suite.passed === true,
        rescanClean: rescan.clean === true,
        counterexamples: results,
        ...(rejectedBy === undefined ? {} : { rejectedBy }),
      });
    } finally {
      await deps.workbench.release(prepared);
    }
  }

  /** Checks a parsed witness against this case and the policy's size limits. */
  #witnessFits(cf: CaseFile, w: Witness): boolean {
    const p = this.#policy;
    const paramsBytes = safely(() => utf8Bytes(canonicalJson(w.params)));
    return (
      w.caseId === cf.id &&
      w.cls === cf.candidate.cls &&
      utf8Bytes(w.template) <= p.maxSourceBytes &&
      paramsBytes !== undefined &&
      paramsBytes <= p.maxParamsBytes &&
      familySize(w.params) <= p.maxFamilySize
    );
  }

  /**
   * The variants that will actually run. `vulnerable` is required. When the case file has a safe
   * variant it is always run, whatever the caller asked for, so differential proof cannot be
   * skipped (F2). Asking for a safe variant that does not exist, or for `patched`, is a caller bug.
   */
  #targets(cf: CaseFile, variants: readonly TargetVariant[]): [ExecutionVariant, TargetRef][] {
    if (variants.includes('patched')) {
      throw new Error('the patched variant is judged by verifyPatch, not runWitness');
    }
    if (!variants.includes('vulnerable')) throw new Error('the vulnerable variant must be run');
    if (variants.includes('safe') && cf.safeVariant === undefined) {
      throw new Error(`case ${cf.id} has no safe variant`);
    }
    const out: [ExecutionVariant, TargetRef][] = [['vulnerable', cf.target]];
    if (cf.safeVariant !== undefined) out.push(['safe', cf.safeVariant]);
    return out;
  }

  /** Runs attempts one at a time so one run cannot disturb another's timing or state. */
  async #attempts(
    caseFile: CaseFile,
    targets: readonly [ExecutionVariant, TargetRef][],
    template: string,
    params: ParamSpace,
  ): Promise<ObservedAttempt[]> {
    const attempts: ObservedAttempt[] = [];
    for (const [variant, target] of targets) {
      for (const attempt of ATTEMPTS) {
        const raw = await this.#executor.execute({
          maxOutputBytes: this.#policy.maxOutputBytes,
          caseFile,
          variant,
          target,
          attempt,
          template,
          params,
          timeoutMs: this.#policy.hardTimeoutMs,
          maxArtifactBytes: this.#policy.maxArtifactBytes,
        });
        attempts.push({ ...raw, variant, attempt });
      }
    }
    return attempts;
  }

  async #run(
    caseFile: CaseFile,
    targets: readonly [ExecutionVariant, TargetRef][],
    r: Runnable,
  ): Promise<ExhibitResult> {
    const attempts = await this.#attempts(caseFile, targets, r.template, r.params);
    return judgeEvidence(
      { exhibitId: r.exhibitId, familySize: familySize(r.params), attempts },
      this.#policy,
    );
  }
}

/** The author's `filesTouched` and `linesChanged` must be exactly what the diff contains. */
function declaredMatches(patch: PatchExhibit, diff: ParsedDiff): boolean {
  const declared = [...new Set(patch.filesTouched)].sort();
  const actual = diff.files.map((f) => f.path).sort();
  return (
    declared.length === patch.filesTouched.length &&
    declared.join('\n') === actual.join('\n') &&
    patch.linesChanged === diff.linesChanged
  );
}

/** A workbench that hands back the wrong target is our bug, never the patch author's. */
function checkPrepared(cf: CaseFile, prepared: PreparedPatch): void {
  const t = prepared.target;
  if (t.variant !== 'patched' || t.repo !== cf.target.repo) {
    throw new Error(`workbench returned a target that is not the patched ${cf.target.repo}`);
  }
}

/** Id for an exhibit too malformed to read its fields; stable for the same input when hashable. */
function fallbackId(kind: 'witness' | 'counterexample' | 'patch', value: unknown): ExhibitId {
  const digest = safely(() => sha256Hex(canonicalJson(value)).slice(0, 24)) ?? 'unhashable';
  return `exhibit-${kind}-invalid-${digest}` as ExhibitId;
}

const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * Runs validation that may blow the stack on hostile input (deeply nested or cyclic values).
 * Any throw means "not readable", which the caller turns into a `schema` rejection.
 */
function safely<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
