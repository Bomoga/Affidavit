import {
  compareToBaseline,
  isComputedReport,
  validatePolicy,
  type CalibrationReport,
  type JuryVsBaseline,
  type Metric,
  type RunId,
} from './calibration.js';

const PLACEHOLDER = '[metric]';

/**
 * Run metadata as an inline code span: whitespace collapses to one line, invisible format
 * characters are dropped and backticks are replaced, so the value cannot break out, autolink or
 * start a block.
 */
function inline(s: string): string {
  const flat = s
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/`/g, "'")
    .trim();
  return `\`${flat}\``;
}

/**
 * Whether a metric may be printed as a number: the report must come from `computeReport`, the
 * labels must be real corpus labels, and the metric must carry this report's run id.
 */
function isBacked(m: Metric, runId: RunId, trusted: boolean): boolean {
  return (
    trusted && m.status === 'measured' && !m.synthetic && m.runId === runId && runId.trim() !== ''
  );
}

function fmt(
  m: Metric,
  runId: RunId,
  trusted: boolean,
  kind: 'ratio' | 'usd' = 'ratio',
  showCases = false,
): string {
  if (m.status !== 'measured' || !isBacked(m, runId, trusted)) return PLACEHOLDER;
  const v = kind === 'usd' ? `$${m.value.toFixed(4)}` : m.value.toFixed(3);
  const cases = showCases ? `, cases=${m.cases}` : '';
  return `${v} (n=${m.n}${cases}, run ${inline(m.runId)})`;
}

/**
 * Markdown for the calibration document. Pure; the caller decides where to write it. A report
 * that did not come from `computeReport`, or that has synthetic labels, renders placeholders only.
 */
export function renderReport(r: CalibrationReport): string {
  const runId = r.manifest.runId;
  const synthetic = r.manifest.labelsSource.kind !== 'corpus';
  const computed = isComputedReport(r);
  const trusted = computed && !synthetic;
  const metrics = [
    r.juryAccuracy,
    r.baselineAccuracy,
    r.agreementAll,
    r.correlationAll,
    r.agreementWrong,
    r.correlationWrong,
    r.costPerVerdict,
    r.costPerCase,
  ];
  const anyBacked = metrics.some((m) => isBacked(m, runId, trusted));

  // Never trust the stored call: recompute it from metrics that belong to this report's run.
  const sameRun = (m: Metric): Metric =>
    m.status === 'measured' && m.runId !== runId
      ? { status: 'unmeasured', reason: 'run id mismatch' }
      : m;
  // Only a trusted report (computed, exactly corpus labels) may print a win or a recommendation.
  const call: JuryVsBaseline = !computed
    ? 'undetermined'
    : !trusted
      ? 'unmeasured'
      : compareToBaseline(
          sameRun(r.juryAccuracy),
          sameRun(r.baselineAccuracy),
          sameRun(r.correlationWrong),
          r.policy,
        );

  let comparison: string;
  if (call === 'supported') {
    comparison =
      'On this run the jury scored higher than the single reviewer and its jurors were not highly correlated on cases it got wrong. Both conditions held.';
  } else if (call === 'not-supported') {
    comparison =
      'The jury does not beat the single reviewer on this run, because accuracy and juror independence together do not support it. The simpler single-reviewer design is recommended.';
  } else if (call === 'undetermined') {
    comparison =
      'The comparison is undetermined. The evidence needed is not available or not trusted here: the baseline may not cover every labelled case, there may be too few cases, juror independence on wrong cases may not be assessable, or the policy or report may be invalid. No claim is made that the jury beats the single reviewer.';
  } else {
    comparison =
      'No run-backed comparison exists yet, so no claim is made about the jury versus a single reviewer.';
  }

  const lines = [
    '# Calibration',
    '',
    `Run id: ${anyBacked ? inline(runId) : PLACEHOLDER}`,
    `Labels: ${synthetic ? 'synthetic, so no numbers are reported' : 'corpus'}`,
    `Labels source: ${synthetic || !trusted ? PLACEHOLDER : inline(r.manifest.labelsSource.ref)}`,
    `Started: ${anyBacked ? inline(r.manifest.startedAt) : PLACEHOLDER}`,
    '',
    '## Accuracy against labels',
    '',
    `- Jury: ${fmt(r.juryAccuracy, runId, trusted)}`,
    `- Single reviewer baseline: ${fmt(r.baselineAccuracy, runId, trusted)}`,
    '',
    '## Inter-juror votes',
    '',
    `- Pairwise agreement, all cases: ${fmt(r.agreementAll, runId, trusted, 'ratio', true)}`,
    `- Vote correlation, all cases: ${fmt(r.correlationAll, runId, trusted, 'ratio', true)}`,
    `- Pairwise agreement, wrong cases only: ${fmt(r.agreementWrong, runId, trusted, 'ratio', true)}`,
    `- Vote correlation, wrong cases only: ${fmt(r.correlationWrong, runId, trusted, 'ratio', true)}`,
    '',
    '## Cost',
    '',
    `- Cost per verdict: ${fmt(r.costPerVerdict, runId, trusted, 'usd')} (counts only cases that wrote a verdict; spend on escalated and dismissed cases is excluded)`,
    `- Cost per case: ${fmt(r.costPerCase, runId, trusted, 'usd')} (all cases)`,
    '',
    '## Jury versus single reviewer',
    '',
    comparison,
    '',
  ];
  if (anyBacked) {
    lines.push(
      'Policy parameters (choices, not measurements):',
      validatePolicy(r.policy)
        ? `- Maximum wrong-case correlation: ${r.policy.maxWrongCaseCorrelation}`
        : '- Policy is invalid, so no comparison is made',
      ...(validatePolicy(r.policy)
        ? [`- Minimum cases before a win may be claimed: ${r.policy.minCases}`]
        : []),
      '',
    );
  }
  return lines.join('\n');
}
