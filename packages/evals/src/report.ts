import type { CalibrationReport, Metric } from './calibration.js';

const PLACEHOLDER = '[metric]';

/** A number is printed only when it is backed by a run id on real (non-synthetic) labels. */
function fmt(m: Metric, kind: 'ratio' | 'usd' = 'ratio'): string {
  if (m.status !== 'measured' || m.synthetic || m.runId.trim() === '') return PLACEHOLDER;
  const v = kind === 'usd' ? `$${m.value.toFixed(4)}` : m.value.toFixed(3);
  return `${v} (n=${m.n}, run ${m.runId})`;
}

function backed(m: Metric): boolean {
  return m.status === 'measured' && !m.synthetic;
}

/** Markdown for the calibration document. Pure; the caller decides where to write it. */
export function renderReport(r: CalibrationReport): string {
  const metrics = [
    r.juryAccuracy,
    r.baselineAccuracy,
    r.agreementAll,
    r.correlationAll,
    r.agreementWrong,
    r.correlationWrong,
    r.costPerVerdict,
  ];
  const anyBacked = metrics.some(backed);
  const synthetic = r.manifest.labelsSource.kind === 'synthetic';

  let comparison: string;
  if (r.juryVsBaseline === 'supported') {
    comparison =
      'On this run the jury scored higher than the single reviewer and its jurors were not highly correlated on cases it got wrong. Both conditions held.';
  } else if (r.juryVsBaseline === 'not-supported') {
    comparison =
      'The jury does not beat the single reviewer on this run, because accuracy and juror independence together do not support it. The simpler single-reviewer design is recommended.';
  } else {
    comparison =
      'No run-backed comparison exists yet, so no claim is made about the jury versus a single reviewer.';
  }

  const lines = [
    '# Calibration',
    '',
    `Run id: ${anyBacked ? r.manifest.runId : PLACEHOLDER}`,
    `Labels: ${synthetic ? 'synthetic, so no numbers are reported' : 'corpus'}`,
    `Labels source: ${synthetic ? PLACEHOLDER : r.manifest.labelsSource.ref}`,
    `Started: ${anyBacked ? r.manifest.startedAt : PLACEHOLDER}`,
    '',
    '## Accuracy against labels',
    '',
    `- Jury: ${fmt(r.juryAccuracy)}`,
    `- Single reviewer baseline: ${fmt(r.baselineAccuracy)}`,
    '',
    '## Inter-juror votes',
    '',
    `- Pairwise agreement, all cases: ${fmt(r.agreementAll)}`,
    `- Vote correlation, all cases: ${fmt(r.correlationAll)}`,
    `- Pairwise agreement, wrong cases only: ${fmt(r.agreementWrong)}`,
    `- Vote correlation, wrong cases only: ${fmt(r.correlationWrong)}`,
    '',
    '## Cost',
    '',
    `- Cost per verdict: ${fmt(r.costPerVerdict, 'usd')}`,
    '',
    '## Jury versus single reviewer',
    '',
    comparison,
    '',
  ];
  return lines.join('\n');
}
