import { describe, expect, it } from 'vitest';
import {
  asRunId,
  baselineAccuracy,
  compareToBaseline,
  computeReport,
  costPerVerdict,
  createEvalRun,
  juryAccuracy,
  jurorAgreement,
  jurorCorrelation,
  tagReplay,
  type Metric,
} from './calibration.js';
import { makeRun, replay } from './test-helpers.js';

const value = (m: Metric): number => {
  if (m.status !== 'measured') throw new Error(`unmeasured: ${m.reason}`);
  return m.value;
};

describe('run construction', () => {
  it('requires a run id', () => {
    expect(() => asRunId('  ')).toThrow();
  });

  it('refuses replays tagged with another run id', () => {
    const other = tagReplay(asRunId('other'), replay('c1', 'proven-fixed', []));
    expect(() =>
      createEvalRun({
        manifest: {
          runId: asRunId('mine'),
          startedAt: 'x',
          labelsSource: { kind: 'corpus', ref: 'r' },
          modelIds: {},
          promptVersions: {},
        },
        labels: [],
        replays: [other],
      }),
    ).toThrow(/tagged other/);
  });

  it('metrics carry the run id', () => {
    const run = makeRun({
      runId: 'run-a',
      labels: [['c1', 'proven-fixed']],
      replays: [replay('c1', 'proven-fixed', [])],
    });
    const m = juryAccuracy(run);
    expect(m.status === 'measured' && m.runId).toBe('run-a');
  });
});

describe('accuracy', () => {
  const labels: [string, 'proven-fixed' | 'not-proven'][] = [
    ['c1', 'proven-fixed'],
    ['c2', 'not-proven'],
    ['c3', 'proven-fixed'],
    ['c4', 'not-proven'],
  ];

  it('computes jury and baseline accuracy', () => {
    const run = makeRun({
      labels,
      replays: [
        replay('c1', 'proven-fixed', []),
        replay('c2', 'not-proven', []),
        replay('c3', 'proven-fixed', []),
        replay('c4', 'proven-fixed', []),
      ],
      baseline: [
        ['c1', 'proven-fixed'],
        ['c2', 'proven-fixed'],
        ['c3', 'not-proven'],
        ['c4', 'not-proven'],
      ],
    });
    expect(value(juryAccuracy(run))).toBe(0.75);
    expect(value(baselineAccuracy(run))).toBe(0.5);
  });

  it('counts a missing replay as wrong and is unmeasured without labels or baseline', () => {
    const run = makeRun({ labels, replays: [replay('c1', 'proven-fixed', [])] });
    expect(value(juryAccuracy(run))).toBe(0.25);
    expect(baselineAccuracy(run).status).toBe('unmeasured');
    expect(juryAccuracy(makeRun({ labels: [], replays: [] })).status).toBe('unmeasured');
  });
});

describe('juror agreement and correlation', () => {
  const run = makeRun({
    labels: [
      ['right', 'proven-fixed'],
      ['wrong1', 'not-proven'],
      ['wrong2', 'not-proven'],
    ],
    replays: [
      // jurors disagree on the case the jury got right
      replay('right', 'proven-fixed', ['low', 'high', 'critical']),
      // identical votes on the cases the jury got wrong
      replay('wrong1', 'proven-fixed', ['high', 'high', 'high']),
      replay('wrong2', 'proven-fixed', ['low', 'low', 'low']),
    ],
  });

  it('computes pairwise agreement overall and on wrong cases', () => {
    // right: 0 of 3 pairs agree; wrong1 and wrong2: 6 of 6 agree
    expect(value(jurorAgreement(run))).toBeCloseTo(6 / 9);
    expect(value(jurorAgreement(run, { onlyWrong: true }))).toBe(1);
  });

  it('computes correlation, high on wrong cases', () => {
    expect(value(jurorCorrelation(run, { onlyWrong: true }))).toBeCloseTo(1);
    expect(value(jurorCorrelation(run))).toBeLessThan(1);
  });

  it('is unmeasured with no variance or no pairs', () => {
    const flat = makeRun({
      labels: [['c', 'proven-fixed']],
      replays: [replay('c', 'proven-fixed', ['high', 'high'])],
    });
    expect(jurorCorrelation(flat).status).toBe('unmeasured');
    expect(jurorAgreement(makeRun({ labels: [], replays: [] })).status).toBe('unmeasured');
  });

  it('detects negative correlation', () => {
    const neg = makeRun({
      labels: [],
      replays: [
        replay('a', 'proven-fixed', ['low', 'critical']),
        replay('b', 'proven-fixed', ['critical', 'low']),
        replay('c', 'proven-fixed', ['medium', 'medium']),
        replay('d', 'proven-fixed', ['high', 'low']),
      ],
    });
    expect(value(jurorCorrelation(neg))).toBeLessThan(0);
  });
});

describe('cost per verdict', () => {
  it('averages usd over replays with a verdict only', () => {
    const run = makeRun({
      labels: [],
      replays: [
        replay('a', 'proven-fixed', [], 1),
        replay('b', 'proven-fixed', [], 3),
        replay('c', 'escalated', [], 100, false),
      ],
    });
    expect(value(costPerVerdict(run))).toBe(2);
  });

  it('is unmeasured with no verdicts', () => {
    expect(costPerVerdict(makeRun({ labels: [], replays: [] })).status).toBe('unmeasured');
  });
});

describe('compareToBaseline', () => {
  const m = (v: number, synthetic = false): Metric => ({
    status: 'measured',
    value: v,
    n: 10,
    runId: asRunId('r'),
    synthetic,
  });

  it('supports only when accuracy is higher and wrong-case correlation is low', () => {
    expect(compareToBaseline(m(0.9), m(0.8), m(0.2), 0.5)).toBe('supported');
    expect(compareToBaseline(m(0.9), m(0.8), m(0.9), 0.5)).toBe('not-supported');
    expect(compareToBaseline(m(0.9), m(0.8), { status: 'unmeasured', reason: 'x' }, 0.5)).toBe(
      'not-supported',
    );
    expect(compareToBaseline(m(0.7), m(0.8), m(0.1), 0.5)).toBe('not-supported');
  });

  it('is unmeasured for synthetic or missing inputs', () => {
    expect(compareToBaseline(m(0.9, true), m(0.8), m(0.1), 0.5)).toBe('unmeasured');
    expect(compareToBaseline(m(0.9), { status: 'unmeasured', reason: 'x' }, m(0.1), 0.5)).toBe(
      'unmeasured',
    );
  });

  it('computeReport marks synthetic runs unmeasured end to end', () => {
    const run = makeRun({
      kind: 'synthetic',
      labels: [['c', 'proven-fixed']],
      replays: [replay('c', 'proven-fixed', [])],
      baseline: [['c', 'not-proven']],
    });
    expect(computeReport(run).juryVsBaseline).toBe('unmeasured');
  });
});
