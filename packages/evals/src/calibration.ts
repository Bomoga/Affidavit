import type { Ballot, CaseId } from '@affidavit/contracts';
import type { ReplayResult, TrialOutcome } from './replay.js';

/** Branded so a bare string cannot stand in for a run id. */
export type RunId = string & { readonly __brand: 'RunId' };

/** Safe characters only, so a run id can never inject markdown or control characters. */
const RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function asRunId(value: string): RunId {
  if (!RUN_ID_PATTERN.test(value)) {
    throw new Error('runId must match ^[A-Za-z0-9._:-]{1,128}$');
  }
  return value as RunId;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

export interface LabelsSource {
  /** `synthetic` labels never produce a reportable number. */
  kind: 'corpus' | 'synthetic';
  /** Where the labels came from, for example a corpus manifest path and revision. */
  ref: string;
}

export interface RunManifest {
  runId: RunId;
  startedAt: string;
  labelsSource: LabelsSource;
  modelIds: Record<string, string>;
  promptVersions: Record<string, string>;
}

export interface CaseLabel {
  caseId: CaseId;
  expected: TrialOutcome;
}

/** A replay result bound to the run that produced it. */
export interface TaggedReplay {
  runId: RunId;
  result: ReplayResult;
}

export function tagReplay(runId: RunId, result: ReplayResult): TaggedReplay {
  return { runId, result };
}

/** What a single-reviewer baseline decided for a case, tagged with its run. */
export interface BaselineDecision {
  runId: RunId;
  caseId: CaseId;
  outcome: TrialOutcome;
}

export interface EvalRun {
  manifest: RunManifest;
  labels: readonly CaseLabel[];
  replays: readonly TaggedReplay[];
  baseline: readonly BaselineDecision[];
}

function assertUnique(what: string, ids: readonly CaseId[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`duplicate caseId ${id} in ${what}`);
    seen.add(id);
  }
}

/**
 * Builds a run; refuses any replay or baseline row that carries a different run id, and any
 * duplicate caseId within replays, labels or baseline.
 */
export function createEvalRun(input: {
  manifest: RunManifest;
  labels: readonly CaseLabel[];
  replays: readonly TaggedReplay[];
  baseline?: readonly BaselineDecision[];
}): EvalRun {
  const { runId } = input.manifest;
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    throw new Error('manifest.runId is required and must match ^[A-Za-z0-9._:-]{1,128}$');
  }
  const baseline = input.baseline ?? [];
  for (const r of input.replays) {
    const seen = new Set<string>();
    for (const b of r.result.ballots) {
      voteIndex(b); // throws on a vote outside the contract scale
      const key = `${b.jurorId}\u0000${b.question}`;
      if (seen.has(key)) {
        throw new Error(`juror ${b.jurorId} voted twice on ${b.question} in ${r.result.caseId}`);
      }
      seen.add(key);
    }
  }
  assertUnique(
    'replays',
    input.replays.map((r) => r.result.caseId),
  );
  assertUnique(
    'labels',
    input.labels.map((l) => l.caseId),
  );
  assertUnique(
    'baseline',
    baseline.map((b) => b.caseId),
  );
  for (const r of input.replays) {
    if (r.runId !== runId)
      throw new Error(`replay for ${r.result.caseId} is tagged ${r.runId}, not ${runId}`);
  }
  for (const b of baseline) {
    if (b.runId !== runId)
      throw new Error(`baseline for ${b.caseId} is tagged ${b.runId}, not ${runId}`);
  }
  // Deep copies, then deep freeze: later mutation of the caller's objects cannot change a run.
  const run: EvalRun = deepFreeze({
    manifest: structuredClone(input.manifest),
    labels: structuredClone([...input.labels]),
    replays: structuredClone([...input.replays]),
    baseline: structuredClone([...baseline]),
  });
  created.add(run);
  return run;
}

/** Runs built by `createEvalRun`; metric functions refuse anything else. */
const created = new WeakSet<object>();

export type Metric =
  | {
      status: 'measured';
      value: number;
      /** Observations (for example juror pairs). */
      n: number;
      /** Distinct cases behind the value; the sample-size gate uses this, not `n`. */
      cases: number;
      runId: RunId;
      synthetic: boolean;
    }
  | { status: 'unmeasured'; reason: string };

function unmeasured(reason: string): Metric {
  return { status: 'unmeasured', reason };
}

function measured(run: EvalRun, value: number, n: number, cases = n): Metric {
  if (!created.has(run)) throw new Error('EvalRun must be built with createEvalRun');
  if (!Number.isFinite(value)) return unmeasured('non-finite value');
  if (n <= 0) return unmeasured('no observations');
  return {
    status: 'measured',
    value,
    n,
    cases,
    runId: run.manifest.runId,
    synthetic: run.manifest.labelsSource.kind === 'synthetic',
  };
}

function accuracyOf(
  run: EvalRun,
  outcomeFor: (caseId: CaseId) => TrialOutcome | undefined,
): Metric {
  if (run.labels.length === 0) return unmeasured('no labels');
  let correct = 0;
  for (const l of run.labels) if (outcomeFor(l.caseId) === l.expected) correct += 1;
  return measured(run, correct / run.labels.length, run.labels.length);
}

/** Share of labelled cases whose jury outcome equals the label. A missing replay counts as wrong. */
export function juryAccuracy(run: EvalRun): Metric {
  const byCase = new Map(run.replays.map((r) => [r.result.caseId, r.result.outcome]));
  return accuracyOf(run, (id) => byCase.get(id));
}

/** Same as `juryAccuracy` for the single-reviewer baseline. */
export function baselineAccuracy(run: EvalRun): Metric {
  if (run.baseline.length === 0) return unmeasured('no baseline decisions');
  const covered = new Set<string>(run.baseline.map((b) => b.caseId));
  if (run.labels.some((l) => !covered.has(l.caseId))) {
    return unmeasured('baseline does not cover every labelled case');
  }
  const byCase = new Map(run.baseline.map((b) => [b.caseId, b.outcome]));
  return accuracyOf(run, (id) => byCase.get(id));
}

/** Case ids the jury got wrong (including labelled cases with no replay). */
export function wrongCases(run: EvalRun): Set<CaseId> {
  const byCase = new Map(run.replays.map((r) => [r.result.caseId, r.result.outcome]));
  return new Set(
    run.labels.filter((l) => byCase.get(l.caseId) !== l.expected).map((l) => l.caseId),
  );
}

type VoteOf<Q extends Ballot['question']> = Extract<Ballot, { question: Q }>['vote'];

/** Ordinal scale per question, typed from the contract's vote types. */
export const VOTE_SCALES: { readonly [Q in Ballot['question']]: readonly VoteOf<Q>[] } = {
  severity: ['low', 'medium', 'high', 'critical'],
  'fix-minimality': ['minimal', 'acceptable', 'excessive'],
  'merge-risk': ['low', 'medium', 'high'],
  'evidence-sufficiency': ['insufficient', 'sufficient'],
};

function voteIndex(b: Ballot): number {
  const scale: readonly string[] = VOTE_SCALES[b.question];
  const i = scale.indexOf(b.vote);
  if (i < 0) throw new Error(`unknown vote ${String(b.vote)} for question ${b.question}`);
  return i;
}

/** Votes mapped onto [0, 1] so questions with different scales can be pooled. */
function numericVote(b: Ballot): number {
  const len = VOTE_SCALES[b.question].length;
  return len > 1 ? voteIndex(b) / (len - 1) : 0;
}

/** One unordered juror pair on one question. */
interface PairObs {
  caseId: CaseId;
  question: Ballot['question'];
  ia: number;
  ib: number;
  a: number;
  b: number;
  agree: boolean;
}

function pairObservations(run: EvalRun, onlyWrong: boolean): PairObs[] {
  const wrong = wrongCases(run);
  const obs: PairObs[] = [];
  for (const { result } of run.replays) {
    if (onlyWrong && !wrong.has(result.caseId)) continue;
    const ballots = result.ballots;
    for (let i = 0; i < ballots.length; i++) {
      for (let j = i + 1; j < ballots.length; j++) {
        const x = ballots[i];
        const y = ballots[j];
        if (x === undefined || y === undefined) continue;
        if (x.jurorId === y.jurorId || x.question !== y.question) continue;
        obs.push({
          caseId: result.caseId,
          question: x.question,
          ia: voteIndex(x),
          ib: voteIndex(y),
          a: numericVote(x),
          b: numericVote(y),
          agree: x.vote === y.vote,
        });
      }
    }
  }
  return obs;
}

/** Fraction of juror pairs (same case, same question) that cast the same vote. */
export function jurorAgreement(run: EvalRun, opts: { onlyWrong?: boolean } = {}): Metric {
  const obs = pairObservations(run, opts.onlyWrong ?? false);
  if (obs.length === 0) return unmeasured('no juror pairs');
  return measured(
    run,
    obs.filter((o) => o.agree).length / obs.length,
    obs.length,
    new Set(obs.map((o) => o.caseId)).size,
  );
}

/**
 * Symmetric (intraclass style) Pearson correlation of paired votes. Jurors are treated as
 * exchangeable raters, so every unordered pair counts in both orders and the result does not
 * depend on juror order. Each vote is centred on its question's mean before pooling, so
 * differences between questions do not inflate r. `n` is the number of unordered pairs.
 * Unmeasured when votes are constant (checked on the raw votes, not on float residue).
 */
export function jurorCorrelation(run: EvalRun, opts: { onlyWrong?: boolean } = {}): Metric {
  const obs = pairObservations(run, opts.onlyWrong ?? false);
  if (obs.length < 2) return unmeasured('fewer than two juror pairs');
  const distinct = new Map<Ballot['question'], Set<number>>();
  const sums = new Map<Ballot['question'], { total: number; count: number }>();
  for (const o of obs) {
    const set = distinct.get(o.question) ?? new Set<number>();
    set.add(o.ia).add(o.ib);
    distinct.set(o.question, set);
    const s = sums.get(o.question) ?? { total: 0, count: 0 };
    s.total += o.a + o.b;
    s.count += 2;
    sums.set(o.question, s);
  }
  if ([...distinct.values()].every((s) => s.size <= 1)) {
    return unmeasured('votes have no variance');
  }
  let cov = 0;
  let variance = 0;
  for (const o of obs) {
    const s = sums.get(o.question);
    if (s === undefined) continue;
    const mean = s.total / s.count;
    const ca = o.a - mean;
    const cb = o.b - mean;
    cov += 2 * ca * cb;
    variance += ca * ca + cb * cb;
  }
  if (variance < 1e-12) return unmeasured('votes have no variance');
  return measured(
    run,
    Math.max(-1, Math.min(1, cov / variance)),
    obs.length,
    new Set(obs.map((o) => o.caseId)).size,
  );
}

/** Mean USD over replays that ended in a written verdict. */
export function costPerVerdict(run: EvalRun): Metric {
  if (run.replays.some((r) => !r.result.complete)) return unmeasured('partial replay');
  // Escalated and dismissed cases can carry a closing verdict; their spend is not verdict cost.
  const withVerdict = run.replays.filter(
    (r) =>
      r.result.verdict !== undefined &&
      r.result.outcome !== 'escalated' &&
      r.result.outcome !== 'dismissed',
  );
  if (withVerdict.length === 0) return unmeasured('no verdicts');
  const total = withVerdict.reduce((s, r) => s + r.result.cost.usd, 0);
  return measured(run, total / withVerdict.length, withVerdict.length);
}

/** Mean USD over every replay, including escalated and dismissed cases. */
export function costPerCase(run: EvalRun): Metric {
  if (run.replays.length === 0) return unmeasured('no replays');
  if (run.replays.some((r) => !r.result.complete)) return unmeasured('partial replay');
  const total = run.replays.reduce((s, r) => s + r.result.cost.usd, 0);
  return measured(run, total / run.replays.length, run.replays.length);
}

export type JuryVsBaseline = 'supported' | 'not-supported' | 'undetermined' | 'unmeasured';

/** Policy parameters for the jury-versus-baseline call. These are choices, not measurements. */
export interface ComparisonPolicy {
  maxWrongCaseCorrelation: number;
  /** Minimum labelled cases, and distinct wrong cases, before `supported` may be claimed. */
  minCases: number;
}

export const DEFAULT_POLICY: ComparisonPolicy = { maxWrongCaseCorrelation: 0.5, minCases: 10 };

export interface CalibrationReport {
  manifest: RunManifest;
  juryAccuracy: Metric;
  baselineAccuracy: Metric;
  agreementAll: Metric;
  correlationAll: Metric;
  agreementWrong: Metric;
  correlationWrong: Metric;
  /** Excludes spend on cases that ended without a written verdict. */
  costPerVerdict: Metric;
  /** Includes every case. */
  costPerCase: Metric;
  juryVsBaseline: JuryVsBaseline;
  policy: ComparisonPolicy;
}

/**
 * The jury is only said to beat the baseline when accuracy is higher AND wrong-case juror
 * correlation is measured and at or below the cap. Anything not measured on real labels is
 * `unmeasured`; lower accuracy, or high correlation, is `not-supported`; independence that
 * cannot be assessed or too small a sample is `undetermined`.
 */
export function compareToBaseline(
  jury: Metric,
  baseline: Metric,
  wrongCorrelation: Metric,
  policy: ComparisonPolicy,
): JuryVsBaseline {
  const real = (m: Metric): m is Extract<Metric, { status: 'measured' }> =>
    m.status === 'measured' && !m.synthetic;
  if (!real(jury)) return 'unmeasured';
  // An invalid policy can never support a claim.
  if (!validatePolicy(policy)) return 'undetermined';
  // Sample size first, so a handful of cases never yields a recommendation either way.
  if (jury.cases < policy.minCases) return 'undetermined';
  // A baseline that is absent or does not cover every labelled case cannot be compared against.
  if (!real(baseline)) return 'undetermined';
  if (jury.value <= baseline.value) return 'not-supported';
  // Accuracy is higher, so the verdict now rests on juror independence. If that cannot be
  // assessed (for example the jury made no errors) or the sample is small, say undetermined.
  if (!real(wrongCorrelation)) return 'undetermined';
  if (wrongCorrelation.cases < policy.minCases) return 'undetermined';
  return wrongCorrelation.value <= policy.maxWrongCaseCorrelation ? 'supported' : 'not-supported';
}

/** minCases must be a finite integer of at least 1; the correlation cap finite and in [-1, 1). */
export function validatePolicy(p: ComparisonPolicy): boolean {
  return (
    Number.isInteger(p.minCases) &&
    p.minCases >= 1 &&
    Number.isFinite(p.maxWrongCaseCorrelation) &&
    p.maxWrongCaseCorrelation >= -1 &&
    p.maxWrongCaseCorrelation < 1
  );
}

/** Reports built by `computeReport`; the renderer refuses anything else. */
const computedReports = new WeakSet<object>();

export function isComputedReport(r: CalibrationReport): boolean {
  return computedReports.has(r);
}

export function computeReport(
  run: EvalRun,
  policyOverride: Partial<ComparisonPolicy> = {},
): CalibrationReport {
  const policy: ComparisonPolicy = { ...DEFAULT_POLICY, ...policyOverride };
  const jury = juryAccuracy(run);
  const baseline = baselineAccuracy(run);
  const correlationWrong = jurorCorrelation(run, { onlyWrong: true });
  const report: CalibrationReport = {
    manifest: run.manifest,
    juryAccuracy: jury,
    baselineAccuracy: baseline,
    agreementAll: jurorAgreement(run),
    correlationAll: jurorCorrelation(run),
    agreementWrong: jurorAgreement(run, { onlyWrong: true }),
    correlationWrong,
    costPerVerdict: costPerVerdict(run),
    costPerCase: costPerCase(run),
    juryVsBaseline: compareToBaseline(jury, baseline, correlationWrong, policy),
    policy,
  };
  deepFreeze(report);
  computedReports.add(report);
  return report;
}
