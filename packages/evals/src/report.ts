import type { CalibrationReport, Metric, RunId } from './calibration.js';

const PLACEHOLDER = '[metric]';

function isBacked(m: Metric, runId: RunId): boolean {
  return m.status === 'measured' && !m.synthetic && m.runId === runId && runId.trim() !== '';
}

/**
 * A number is printed only when it is backed by this report's run id on real (non-synthetic)
 * labels. Anything else renders as the placeholder.
 */
function fmt(m: Metric, runId: RunId, kind: 'ratio' | 'usd' = 'ratio'): string {
  if (m.status !== 'measured' || !isBacked(m, runId)) return PLACEHOLDER;
  const v = kind === 'usd' ? `$${m.value.toFixed(4)}` : m.value.toFixed(3);
  return `${v} (n=${m.n}, run ${m.runId})`;
}

/** Markdown for the calibration document. Pure; the caller decides where to write it. */
export function renderReport(r: CalibrationReport): string {
  const runId = r.manifest.runId;
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
  const anyBacked = metrics.some((m) => isBacked(m, runId));
  const synthetic = r.manifest.labelsSource.kind === 'synthetic';

  let comparison: string;
  if (r.juryVsBaseline === 'supported') {
    comparison =
      'On this run the jury scored higher than the single reviewer and its jurors were not highly correlated on cases it got wrong. Both conditions held.';
  } else if (r.juryVsBaseline === 'not-supported') {
    comparison =
      'The jury does not beat the single reviewer on this run, because accuracy and juror independence together do not support it. The simpler single-reviewer design is recommended.';
  } else if (r.juryVsBaseline === 'undetermined') {
    comparison =
      'The comparison is undetermined. Juror independence on wrong cases could not be assessed from enough observations, so no claim is made that the jury beats the single reviewer.';
  } else {
    comparison =
      'No run-backed comparison exists yet, so no claim is made about the jury versus a single reviewer.';
  }

  const lines = [
    '# Calibration',
    '',
    `Run id: ${anyBacked ? runId : PLACEHOLDER}`,
    `Labels: ${synthetic ? 'synthetic, so no numbers are reported' : 'corpus'}`,
    `Labels source: ${synthetic ? PLACEHOLDER : r.manifest.labelsSource.ref}`,
    `Started: ${anyBacked ? r.manifest.startedAt : PLACEHOLDER}`,
    '',
    '## Accuracy against labels',
    '',
    `- Jury: ${fmt(r.juryAccuracy, runId)}`,
    `- Single reviewer baseline: ${fmt(r.baselineAccuracy, runId)}`,
    '',
    '## Inter-juror votes',
    '',
    `- Pairwise agreement, all cases: ${fmt(r.agreementAll, runId)}`,
    `- Vote correlation, all cases: ${fmt(r.correlationAll, runId)}`,
    `- Pairwise agreement, wrong cases only: ${fmt(r.agreementWrong, runId)}`,
    `- Vote correlation, wrong cases only: ${fmt(r.correlationWrong, runId)}`,
    '',
    '## Cost',
    '',
    `- Cost per verdict: ${fmt(r.costPerVerdict, runId, 'usd')} (counts only cases that wrote a verdict; spend on escalated and dismissed cases is excluded)`,
    `- Cost per case: ${fmt(r.costPerCase, runId, 'usd')} (all cases)`,
    '',
    '## Jury versus single reviewer',
    '',
    comparison,
    '',
  ];
  if (anyBacked) {
    lines.push(
      'Policy parameters (choices, not measurements):',
      `- Maximum wrong-case correlation: ${r.policy.maxWrongCaseCorrelation}`,
      `- Minimum cases before a win may be claimed: ${r.policy.minCases}`,
      '',
    );
  }
  return lines.join('\n');
}
