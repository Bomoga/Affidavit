import type { Ballot, CaseId } from '@affidavit/contracts';
import type { ReplayResult, TrialOutcome } from './replay.js';

/** Branded so a bare string cannot stand in for a run id. */
export type RunId = string & { readonly __brand: 'RunId' };

export function asRunId(value: string): RunId {
  if (value.trim() === '') throw new Error('runId must be a non-empty string');
  return value as RunId;
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

/** Builds a run; refuses any replay or baseline row that carries a different run id. */
export function createEvalRun(input: {
  manifest: RunManifest;
  labels: readonly CaseLabel[];
  replays: readonly TaggedReplay[];
  baseline?: readonly BaselineDecision[];
}): EvalRun {
  const { runId } = input.manifest;
  if (typeof runId !== 'string' || runId.trim() === '') {
    throw new Error('manifest.runId is required');
  }
  const baseline = input.baseline ?? [];
  for (const r of input.replays) {
    if (r.runId !== runId)
      throw new Error(`replay for ${r.result.caseId} is tagged ${r.runId}, not ${runId}`);
  }
  for (const b of baseline) {
    if (b.runId !== runId)
      throw new Error(`baseline for ${b.caseId} is tagged ${b.runId}, not ${runId}`);
  }
  return { manifest: input.manifest, labels: input.labels, replays: input.replays, baseline };
}

export type Metric =
  | { status: 'measured'; value: number; n: number; runId: RunId; synthetic: boolean }
  | { status: 'unmeasured'; reason: string };

function unmeasured(reason: string): Metric {
  return { status: 'unmeasured', reason };
}

function measured(run: EvalRun, value: number, n: number): Metric {
  if (n <= 0 || !Number.isFinite(value)) return unmeasured('no observations');
  return {
    status: 'measured',
    value,
    n,
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

const ORDINAL: Record<Ballot['question'], readonly string[]> = {
  severity: ['low', 'medium', 'high', 'critical'],
  'fix-minimality': ['minimal', 'acceptable', 'excessive'],
  'merge-risk': ['low', 'medium', 'high'],
  'evidence-sufficiency': ['insufficient', 'sufficient'],
};

/** Votes mapped onto [0, 1] so questions with different scales can be pooled. */
function numericVote(b: Ballot): number {
  const scale = ORDINAL[b.question];
  const i = scale.indexOf(b.vote);
  return scale.length > 1 ? i / (scale.length - 1) : 0;
}

interface PairObs {
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
        obs.push({ a: numericVote(x), b: numericVote(y), agree: x.vote === y.vote });
      }
    }
  }
  return obs;
}

/** Fraction of juror pairs (same case, same question) that cast the same vote. */
export function jurorAgreement(run: EvalRun, opts: { onlyWrong?: boolean } = {}): Metric {
  const obs = pairObservations(run, opts.onlyWrong ?? false);
  if (obs.length === 0) return unmeasured('no juror pairs');
  return measured(run, obs.filter((o) => o.agree).length / obs.length, obs.length);
}

/** Pearson correlation of paired votes; unmeasured when either side has no variance. */
export function jurorCorrelation(run: EvalRun, opts: { onlyWrong?: boolean } = {}): Metric {
  const obs = pairObservations(run, opts.onlyWrong ?? false);
  if (obs.length < 2) return unmeasured('fewer than two juror pairs');
  const n = obs.length;
  const ma = obs.reduce((s, o) => s + o.a, 0) / n;
  const mb = obs.reduce((s, o) => s + o.b, 0) / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (const o of obs) {
    cov += (o.a - ma) * (o.b - mb);
    va += (o.a - ma) ** 2;
    vb += (o.b - mb) ** 2;
  }
  if (va === 0 || vb === 0) return unmeasured('votes have no variance');
  return measured(run, cov / Math.sqrt(va * vb), n);
}

/** Mean USD over replays that ended in a written verdict. */
export function costPerVerdict(run: EvalRun): Metric {
  const withVerdict = run.replays.filter((r) => r.result.verdict !== undefined);
  if (withVerdict.length === 0) return unmeasured('no verdicts');
  const total = withVerdict.reduce((s, r) => s + r.result.cost.usd, 0);
  return measured(run, total / withVerdict.length, withVerdict.length);
}

export type JuryVsBaseline = 'supported' | 'not-supported' | 'unmeasured';

export interface CalibrationReport {
  manifest: RunManifest;
  juryAccuracy: Metric;
  baselineAccuracy: Metric;
  agreementAll: Metric;
  correlationAll: Metric;
  agreementWrong: Metric;
  correlationWrong: Metric;
  costPerVerdict: Metric;
  juryVsBaseline: JuryVsBaseline;
  /** Policy parameter used for `juryVsBaseline`, not a measurement. */
  maxWrongCaseCorrelation: number;
}

/**
 * The jury is only said to beat the baseline when accuracy is higher AND wrong-case juror
 * correlation is measured and at or below the cap. Anything not measured on real labels is
 * `unmeasured`; anything measured but short of both conditions is `not-supported`.
 */
export function compareToBaseline(
  jury: Metric,
  baseline: Metric,
  wrongCorrelation: Metric,
  maxWrongCaseCorrelation: number,
): JuryVsBaseline {
  const real = (m: Metric): m is Extract<Metric, { status: 'measured' }> =>
    m.status === 'measured' && !m.synthetic;
  if (!real(jury) || !real(baseline)) return 'unmeasured';
  if (jury.value <= baseline.value) return 'not-supported';
  if (!real(wrongCorrelation)) return 'not-supported';
  return wrongCorrelation.value <= maxWrongCaseCorrelation ? 'supported' : 'not-supported';
}

export function computeReport(run: EvalRun, maxWrongCaseCorrelation = 0.5): CalibrationReport {
  const jury = juryAccuracy(run);
  const baseline = baselineAccuracy(run);
  const correlationWrong = jurorCorrelation(run, { onlyWrong: true });
  return {
    manifest: run.manifest,
    juryAccuracy: jury,
    baselineAccuracy: baseline,
    agreementAll: jurorAgreement(run),
    correlationAll: jurorCorrelation(run),
    agreementWrong: jurorAgreement(run, { onlyWrong: true }),
    correlationWrong,
    costPerVerdict: costPerVerdict(run),
    juryVsBaseline: compareToBaseline(jury, baseline, correlationWrong, maxWrongCaseCorrelation),
    maxWrongCaseCorrelation,
  };
}
