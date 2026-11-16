import { ExhibitResult } from '@affidavit/contracts';
import type { AdmissibilityRule, ExhibitId, RunRecord } from '@affidavit/contracts';
import { parseResultArtifact } from './artifact.js';
import type { ArtifactParse } from './artifact.js';
import { sha256Hex } from './canonical.js';
import type { Attempt, ExecutionVariant, RawAttempt } from './executor.js';

/** Witness rules in the order they are applied. The first one that fails is recorded. */
export const WITNESS_RULES = [
  'schema',
  'completes',
  'stable-3of3',
  'no-egress',
  'time-budget',
  'differential',
] as const satisfies readonly AdmissibilityRule[];
export type WitnessRule = (typeof WITNESS_RULES)[number];

export const ATTEMPTS: readonly Attempt[] = [1, 2, 3];

/** Configuration, not measurements. Tune per corpus app once real runs exist. */
export interface JudgePolicy {
  /** Hard wall clock per attempt; the executor kills the run here (fails `completes`). */
  hardTimeoutMs: number;
  /** A completed attempt slower than this fails `time-budget`. Must be below `hardTimeoutMs`. */
  timeBudgetMs: number;
  maxArtifactBytes: number;
  /** Largest family the Judge will run; a larger ParamSpace fails `schema` before any run. */
  maxFamilySize: number;
  /** Largest witness or counterexample source, in UTF-8 bytes. */
  maxSourceBytes: number;
  /** Largest parameter space, as canonical JSON in UTF-8 bytes. */
  maxParamsBytes: number;
  /** Diff size cap (L2-07): added plus removed lines, counted from the diff. Over it fails `diff-too-large`. */
  maxPatchLinesChanged: number;
  /** Most files one patch may touch. Over it fails `diff-too-large`. */
  maxPatchFiles: number;
  /**
   * Largest stdout or stderr, each in UTF-8 bytes, an executor may hand back for one attempt.
   * The executor must cap the streams at this size while the run goes; output over it means the
   * executor did not, and the Judge throws instead of judging.
   */
  maxOutputBytes: number;
}

export const DEFAULT_POLICY: Readonly<JudgePolicy> = {
  hardTimeoutMs: 120_000,
  timeBudgetMs: 60_000,
  maxArtifactBytes: 64 * 1024,
  maxFamilySize: 64,
  maxSourceBytes: 256 * 1024,
  maxParamsBytes: 64 * 1024,
  maxPatchLinesChanged: 100,
  maxPatchFiles: 5,
  maxOutputBytes: 1024 * 1024,
};

export interface ObservedAttempt extends RawAttempt {
  variant: ExecutionVariant;
  attempt: Attempt;
}

export interface Evidence {
  exhibitId: ExhibitId;
  /** Number of parameter combinations; already checked against the policy. */
  familySize: number;
  /** Three attempts on `vulnerable`, plus three on `safe` when the case has a safe variant. */
  attempts: readonly ObservedAttempt[];
}

/** Exit code recorded for a run that never exited (killed on timeout or by the OOM killer). */
export const NO_EXIT_CODE = -1;

const allTrue = (xs: readonly boolean[]): boolean => xs.every((x) => x);
const allFalse = (xs: readonly boolean[]): boolean => xs.every((x) => !x);
const sameResults = (a: readonly boolean[], b: readonly boolean[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const isCount = (n: unknown): boolean => Number.isSafeInteger(n) && (n as number) >= 0;

/**
 * The executor is our code, but a bug there must never turn into a wrong verdict: an attempt
 * with a NaN egress count would otherwise slip past `no-egress`. Bad input throws.
 */
function checkAttempt(a: ObservedAttempt, policy: Readonly<JudgePolicy>): void {
  const problems: string[] = [];
  const tooLong = (s: unknown): boolean =>
    typeof s === 'string' && Buffer.byteLength(s, 'utf8') > policy.maxOutputBytes;
  if (tooLong(a.stdout)) problems.push('stdout over maxOutputBytes');
  if (tooLong(a.stderr)) problems.push('stderr over maxOutputBytes');
  if (a.exitCode !== null && !Number.isSafeInteger(a.exitCode)) problems.push('exitCode');
  if (typeof a.timedOut !== 'boolean') problems.push('timedOut');
  if (typeof a.oomKilled !== 'boolean') problems.push('oomKilled');
  if (!(Number.isFinite(a.durationMs) && a.durationMs >= 0)) problems.push('durationMs');
  if (!isCount(a.egressAttempts)) problems.push('egressAttempts');
  if (typeof a.traceTampered !== 'boolean') problems.push('traceTampered');
  if (typeof a.stdout !== 'string') problems.push('stdout');
  if (typeof a.stderr !== 'string') problems.push('stderr');
  if (a.artifact !== null && typeof a.artifact !== 'string') problems.push('artifact');
  if (problems.length > 0) {
    throw new Error(
      `executor returned an invalid ${a.variant} attempt ${a.attempt}: ${problems.join(', ')}`,
    );
  }
}

function checkShape(
  attempts: readonly ObservedAttempt[],
  policy: Readonly<JudgePolicy>,
  required: ExecutionVariant,
): void {
  attempts.forEach((a) => checkAttempt(a, policy));
  const variants = new Set(attempts.map((a) => a.variant));
  if (!variants.has(required)) throw new Error(`evidence has no ${required} runs`);
  for (const v of variants) {
    const seen = attempts
      .filter((a) => a.variant === v)
      .map((a) => a.attempt)
      .sort();
    if (seen.join(',') !== ATTEMPTS.join(',')) {
      throw new Error(`evidence for ${v} must have attempts 1, 2, 3 exactly once`);
    }
  }
}

function toRunRecord(a: ObservedAttempt, art: ArtifactParse | null): RunRecord {
  const completed = a.exitCode !== null && !a.timedOut && !a.oomKilled;
  return {
    variant: a.variant,
    attempt: a.attempt,
    exitCode: a.exitCode ?? NO_EXIT_CODE,
    passed: completed && art !== null && art.ok && allTrue(art.results),
    durationMs: Math.round(a.durationMs),
    stdoutSha256: sha256Hex(a.stdout),
    stderrSha256: sha256Hex(a.stderr),
  };
}

/** Result for an exhibit rejected before anything ran (malformed witness, family too large). */
export function rejectBeforeRunning(exhibitId: ExhibitId, rule: AdmissibilityRule): ExhibitResult {
  return ExhibitResult.parse({
    schemaVersion: 1,
    exhibitId,
    admissible: false,
    rejectedBy: rule,
    runs: [],
    vulnPass: false,
    egressAttempts: 0,
    passed: false,
    durationMs: 0,
  });
}

interface Screened {
  base: Omit<ExhibitResult, 'admissible' | 'rejectedBy' | 'vulnPass' | 'passed'>;
  /** The first rule before `differential` that failed, if any. */
  rejectedBy?: WitnessRule;
  variants: ExecutionVariant[];
  resultsOf: (v: ExecutionVariant, n: Attempt) => boolean[];
}

/**
 * The rules every run is held to before its outcome means anything: `schema`, `completes`,
 * `stable-3of3`, `no-egress` and `time-budget`, in that order. Shared by witnesses,
 * counterexamples and the reruns inside verifyPatch, so a patched target is judged exactly like
 * the vulnerable one.
 */
function screen(
  attempts: readonly ObservedAttempt[],
  exhibitId: ExhibitId,
  familySize: number,
  policy: Readonly<JudgePolicy>,
): Screened {
  const parsed = attempts.map((a) => ({
    a,
    art:
      a.artifact === null
        ? null
        : parseResultArtifact(a.artifact, familySize, policy.maxArtifactBytes),
  }));
  const base = {
    schemaVersion: 1 as const,
    exhibitId,
    runs: parsed.map(({ a, art }) => toRunRecord(a, art)),
    egressAttempts: attempts.reduce((n, a) => n + a.egressAttempts, 0),
    durationMs: attempts.reduce((n, a) => n + Math.round(a.durationMs), 0),
  };
  const results = new Map<string, boolean[]>();
  const resultsOf = (v: ExecutionVariant, n: Attempt): boolean[] => results.get(`${v}:${n}`) ?? [];
  const variants = [...new Set(attempts.map((a) => a.variant))];
  const out = (rejectedBy?: WitnessRule): Screened =>
    rejectedBy === undefined
      ? { base, variants, resultsOf }
      : { base, variants, resultsOf, rejectedBy };

  // schema: every artifact that exists must be well formed.
  if (parsed.some(({ art }) => art !== null && !art.ok)) return out('schema');

  // completes: every attempt exited on its own and left an artifact.
  for (const { a, art } of parsed) {
    if (a.exitCode === null || a.timedOut || a.oomKilled || art === null || !art.ok) {
      return out('completes');
    }
    results.set(`${a.variant}:${a.attempt}`, art.results);
  }

  // stable-3of3: per variant, all three attempts agree on every parameter.
  for (const v of variants) {
    const first = resultsOf(v, 1);
    if (!ATTEMPTS.every((n) => sameResults(first, resultsOf(v, n)))) return out('stable-3of3');
  }

  // no-egress: none recorded, and the record itself is trustworthy. A tampered trace cannot
  // show the absence of egress, so it fails this rule rather than passing it.
  if (base.egressAttempts > 0 || attempts.some((a) => a.traceTampered)) return out('no-egress');

  if (attempts.some((a) => a.durationMs > policy.timeBudgetMs)) return out('time-budget');

  return out();
}

/**
 * Applies the rules of evidence to what the executor observed. Pure: the same evidence always
 * gives the same result, which is what replay (L2-08) relies on.
 *
 * Semantics:
 * - An attempt passes only if every parameter in the family passed.
 * - `vulnPass` is true only when the evidence got as far as `differential` and the whole family
 *   passed on `vulnerable`. Evidence rejected by an earlier rule is not credited.
 * - `differential` needs the whole family to pass on `vulnerable` and, when a safe variant was
 *   run, the whole family to fail on `safe` (F2).
 */
export function judgeEvidence(evidence: Evidence, policy: Readonly<JudgePolicy>): ExhibitResult {
  const { exhibitId, familySize, attempts } = evidence;
  checkShape(attempts, policy, 'vulnerable');
  if (attempts.some((a) => a.variant === 'patched')) {
    throw new Error('patched runs are judged by judgePatchedFamily, not judgeEvidence');
  }
  const { base, rejectedBy, variants, resultsOf } = screen(attempts, exhibitId, familySize, policy);
  if (rejectedBy !== undefined) {
    return ExhibitResult.parse({
      ...base,
      admissible: false,
      rejectedBy,
      vulnPass: false,
      passed: false,
    });
  }

  const vuln = resultsOf('vulnerable', 1);
  const vulnPass = allTrue(vuln);
  const safeVariantFail = variants.includes('safe') ? allFalse(resultsOf('safe', 1)) : undefined;
  const familyResults = vuln.map((passed, paramIndex) => ({ paramIndex, passed }));
  const admissible = vulnPass && safeVariantFail !== false;

  return ExhibitResult.parse({
    ...base,
    admissible,
    ...(admissible ? {} : { rejectedBy: 'differential' }),
    vulnPass,
    ...(safeVariantFail === undefined ? {} : { safeVariantFail }),
    familyResults,
    passed: admissible,
  });
}

export interface FamilyOnPatch {
  /** The whole family passed on `vulnerable` and failed on every parameter on `patched`. */
  familyFlipped: boolean;
  /** Why it did not flip: an earlier rule, or `differential` when the runs were clean. */
  rejectedBy?: WitnessRule;
}

/**
 * verifyPatch's family check (F5): the witness family reruns on the vulnerable commit, where it
 * must still pass on every parameter, and on the patched target, where it must fail on every
 * parameter. A single parameter still passing on the patch means the family did not flip.
 */
export function judgePatchedFamily(
  evidence: Evidence,
  policy: Readonly<JudgePolicy>,
): FamilyOnPatch {
  const { exhibitId, familySize, attempts } = evidence;
  checkShape(attempts, policy, 'vulnerable');
  if (!attempts.some((a) => a.variant === 'patched'))
    throw new Error('evidence has no patched runs');
  if (attempts.some((a) => a.variant === 'safe')) throw new Error('safe runs do not belong here');
  const { rejectedBy, resultsOf } = screen(attempts, exhibitId, familySize, policy);
  if (rejectedBy !== undefined) return { familyFlipped: false, rejectedBy };
  const flipped = allTrue(resultsOf('vulnerable', 1)) && allFalse(resultsOf('patched', 1));
  return flipped ? { familyFlipped: true } : { familyFlipped: false, rejectedBy: 'differential' };
}

/**
 * A counterexample is defeated by the patch only when its runs on the patched target are clean
 * (every screening rule holds) and every parameter fails. Anything else, including a run that
 * never completes, counts as surviving: the Judge cannot show the patch beat it.
 */
export function counterexampleSurvives(evidence: Evidence, policy: Readonly<JudgePolicy>): boolean {
  const { exhibitId, familySize, attempts } = evidence;
  checkShape(attempts, policy, 'patched');
  if (attempts.some((a) => a.variant !== 'patched')) {
    throw new Error('counterexamples are rerun on the patched target only');
  }
  const { rejectedBy, resultsOf } = screen(attempts, exhibitId, familySize, policy);
  return rejectedBy !== undefined || !allFalse(resultsOf('patched', 1));
}
