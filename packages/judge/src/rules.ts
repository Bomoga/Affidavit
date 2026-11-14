import { ExhibitResult } from '@affidavit/contracts';
import type { AdmissibilityRule, ExhibitId, RunRecord } from '@affidavit/contracts';
import { parseResultArtifact } from './artifact.js';
import type { ArtifactParse } from './artifact.js';
import { sha256Hex } from './canonical.js';
import type { Attempt, EvidenceVariant, RawAttempt } from './executor.js';

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
}

export const DEFAULT_POLICY: Readonly<JudgePolicy> = {
  hardTimeoutMs: 120_000,
  timeBudgetMs: 60_000,
  maxArtifactBytes: 64 * 1024,
  maxFamilySize: 64,
  maxSourceBytes: 256 * 1024,
  maxParamsBytes: 64 * 1024,
};

export interface ObservedAttempt extends RawAttempt {
  variant: EvidenceVariant;
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
function checkAttempt(a: ObservedAttempt): void {
  const problems: string[] = [];
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

function checkShape(attempts: readonly ObservedAttempt[]): void {
  attempts.forEach(checkAttempt);
  const variants = new Set(attempts.map((a) => a.variant));
  if (!variants.has('vulnerable')) throw new Error('evidence has no vulnerable runs');
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
  checkShape(attempts);

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
  const reject = (rule: WitnessRule): ExhibitResult =>
    ExhibitResult.parse({
      ...base,
      admissible: false,
      rejectedBy: rule,
      vulnPass: false,
      passed: false,
    });

  // schema: every artifact that exists must be well formed.
  if (parsed.some(({ art }) => art !== null && !art.ok)) return reject('schema');

  // completes: every attempt exited on its own and left an artifact.
  const results = new Map<string, boolean[]>();
  for (const { a, art } of parsed) {
    if (a.exitCode === null || a.timedOut || a.oomKilled || art === null || !art.ok) {
      return reject('completes');
    }
    results.set(`${a.variant}:${a.attempt}`, art.results);
  }
  const resultsOf = (v: EvidenceVariant, n: Attempt): boolean[] => results.get(`${v}:${n}`) ?? [];

  // stable-3of3: per variant, all three attempts agree on every parameter.
  const variants = [...new Set(attempts.map((a) => a.variant))];
  for (const v of variants) {
    const first = resultsOf(v, 1);
    if (!ATTEMPTS.every((n) => sameResults(first, resultsOf(v, n)))) return reject('stable-3of3');
  }

  // no-egress: none recorded, and the record itself is trustworthy. A tampered trace cannot
  // show the absence of egress, so it fails this rule rather than passing it.
  if (base.egressAttempts > 0 || attempts.some((a) => a.traceTampered)) return reject('no-egress');

  if (attempts.some((a) => a.durationMs > policy.timeBudgetMs)) return reject('time-budget');

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
