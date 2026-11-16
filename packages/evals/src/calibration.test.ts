import { Ballot } from '@affidavit/contracts';
import { describe, expect, it } from 'vitest';
import {
  VOTE_SCALES,
  validatePolicy,
  asRunId,
  baselineAccuracy,
  compareToBaseline,
  computeReport,
  costPerCase,
  costPerVerdict,
  createEvalRun,
  juryAccuracy,
  jurorAgreement,
  jurorCorrelation,
  tagReplay,
  type Metric,
} from './calibration.js';
import { ballot, cid, makeRun, replay } from './synthetic.test-helpers.js';

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

describe('correlation robustness', () => {
  type V = 'low' | 'medium' | 'high' | 'critical';
  const runOf = (cases: V[][]) =>
    makeRun({
      labels: [],
      replays: cases.map((v, i) => replay(`c${i}`, 'proven-fixed', v)),
    });

  it('is unmeasured for constant votes (identical pairs, float residue)', () => {
    const run = runOf(Array.from({ length: 7 }, () => ['medium', 'medium', 'medium'] as V[]));
    expect(jurorCorrelation(run).status).toBe('unmeasured');
    const three = runOf([
      ['medium', 'medium'],
      ['medium', 'medium'],
      ['medium', 'medium'],
    ]);
    expect(jurorCorrelation(three).status).toBe('unmeasured');
  });

  it('does not depend on juror order', () => {
    const cases: V[][] = [
      ['low', 'low', 'high'],
      ['high', 'critical', 'medium'],
      ['medium', 'low', 'low'],
      ['critical', 'high', 'high'],
    ];
    const base = jurorCorrelation(runOf(cases));
    const swapped = jurorCorrelation(runOf(cases.map((c) => [...c].reverse())));
    const rotated = jurorCorrelation(runOf(cases.map((c) => [c[1], c[2], c[0]] as V[])));
    expect(base.status).toBe('measured');
    expect(value(swapped)).toBeCloseTo(value(base));
    expect(value(rotated)).toBeCloseTo(value(base));
  });

  it('reports n as unordered pairs', () => {
    const m = jurorCorrelation(
      runOf([
        ['low', 'high', 'critical'],
        ['low', 'low', 'high'],
      ]),
    );
    expect(m.status === 'measured' && m.n).toBe(6);
  });

  it('rejects duplicate case ids', () => {
    expect(() =>
      makeRun({
        labels: [
          ['a', 'proven-fixed'],
          ['a', 'not-proven'],
        ],
        replays: [],
      }),
    ).toThrow(/duplicate caseId/);
    expect(() =>
      makeRun({
        labels: [],
        replays: [replay('a', 'proven-fixed', []), replay('a', 'proven-fixed', [])],
      }),
    ).toThrow(/duplicate caseId/);
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

  it('excludes escalated and dismissed replays even when they carry a closing verdict', () => {
    const run = makeRun({
      labels: [],
      replays: [
        replay('a', 'proven-fixed', [], 2),
        replay('b', 'escalated', [], 50),
        replay('c', 'dismissed', [], 50),
      ],
    });
    expect(value(costPerVerdict(run))).toBe(2);
    expect(value(costPerCase(run))).toBe(34);
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
    cases: 10,
    runId: asRunId('r'),
    synthetic,
  });

  const policy = { maxWrongCaseCorrelation: 0.5, minCases: 10 };
  const none: Metric = { status: 'unmeasured', reason: 'x' };

  it('supports only when accuracy is higher and wrong-case correlation is low', () => {
    expect(compareToBaseline(m(0.9), m(0.8), m(0.2), policy)).toBe('supported');
    expect(compareToBaseline(m(0.9), m(0.8), m(0.9), policy)).toBe('not-supported');
    expect(compareToBaseline(m(0.7), m(0.8), m(0.1), policy)).toBe('not-supported');
  });

  it('is undetermined when wrong-case correlation cannot be measured or n is small', () => {
    expect(compareToBaseline(m(0.9), m(0.8), none, policy)).toBe('undetermined');
    expect(compareToBaseline(m(0.9), m(0.8), m(0.1), { ...policy, minCases: 11 })).toBe(
      'undetermined',
    );
  });

  it('is unmeasured for synthetic or missing inputs', () => {
    expect(compareToBaseline(m(0.9, true), m(0.8), m(0.1), policy)).toBe('unmeasured');
    expect(compareToBaseline(none, m(0.8), m(0.1), policy)).toBe('unmeasured');
  });

  it('is undetermined when the baseline is missing', () => {
    expect(compareToBaseline(m(0.9), none, m(0.1), policy)).toBe('undetermined');
  });

  it('a partial baseline never yields a win', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `c${i}`);
    const run = makeRun({
      kind: 'corpus',
      labels: ids.map((id) => [id, 'proven-fixed']),
      replays: ids.map((id, i) =>
        replay(id, i < 6 ? 'proven-fixed' : 'not-proven', ['low', 'critical']),
      ),
      baseline: [['c0', 'proven-fixed']],
    });
    expect(baselineAccuracy(run).status).toBe('unmeasured');
    expect(computeReport(run).juryVsBaseline).toBe('undetermined');
  });

  it('gates on distinct wrong cases, not juror pairs', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `c${i}`);
    const run = makeRun({
      kind: 'corpus',
      labels: ids.map((id) => [id, 'proven-fixed']),
      replays: ids.map((id, i) =>
        i === 0
          ? replay(id, 'not-proven', ['low', 'critical', 'low', 'critical', 'medium'])
          : replay(id, 'proven-fixed', ['high', 'high']),
      ),
      baseline: ids.map((id) => [id, 'not-proven']),
    });
    const corr = jurorCorrelation(run, { onlyWrong: true });
    expect(corr.status === 'measured' && corr.n).toBe(10);
    expect(corr.status === 'measured' && corr.cases).toBe(1);
    expect(computeReport(run).juryVsBaseline).toBe('undetermined');
  });

  it('refuses runs not built by createEvalRun', () => {
    const real = makeRun({ labels: [['a', 'proven-fixed']], replays: [] });
    const forged = { ...real };
    expect(() => juryAccuracy(forged)).toThrow(/createEvalRun/);
  });

  it('never supports a win under an invalid policy', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `c${i}`);
    const run = makeRun({
      kind: 'corpus',
      labels: ids.map((id) => [id, 'proven-fixed']),
      replays: ids.map((id, i) =>
        i < 2
          ? replay(id, 'not-proven', i === 0 ? ['low', 'critical'] : ['critical', 'low'])
          : replay(id, 'proven-fixed', ['high', 'high']),
      ),
      baseline: ids.map((id) => [id, 'not-proven']),
    });
    for (const bad of [
      { minCases: Number.NaN },
      { minCases: 0 },
      { minCases: 1.5 },
      { maxWrongCaseCorrelation: Number.POSITIVE_INFINITY },
      { maxWrongCaseCorrelation: 1 },
      { maxWrongCaseCorrelation: Number.NaN },
    ]) {
      expect(computeReport(run, bad).juryVsBaseline).not.toBe('supported');
    }
    // A valid policy with the same data can support, so the guard is what blocks the others.
    expect(computeReport(run, { minCases: 2 }).juryVsBaseline).toBe('supported');
    expect(validatePolicy({ minCases: 10, maxWrongCaseCorrelation: 0.5 })).toBe(true);
    expect(validatePolicy({ minCases: 10, maxWrongCaseCorrelation: -1 })).toBe(true);
  });

  it('applies the minimum-sample gate before the accuracy comparison', () => {
    const lower = compareToBaseline(
      { status: 'measured', value: 0.1, n: 1, cases: 1, runId: asRunId('r'), synthetic: false },
      { status: 'measured', value: 0.9, n: 1, cases: 1, runId: asRunId('r'), synthetic: false },
      { status: 'unmeasured', reason: 'x' },
      { minCases: 10, maxWrongCaseCorrelation: 0.5 },
    );
    expect(lower).toBe('undetermined');
  });

  it('is not affected by mutating inputs after the run is built', () => {
    const manifest = {
      runId: asRunId('run-mut'),
      startedAt: 'x',
      labelsSource: { kind: 'synthetic' as 'synthetic' | 'corpus', ref: 'r' },
      modelIds: {},
      promptVersions: {},
    };
    const run = createEvalRun({
      manifest,
      labels: [{ caseId: cid('a'), expected: 'proven-fixed' }],
      replays: [],
    });
    manifest.labelsSource.kind = 'corpus';
    expect(run.manifest.labelsSource.kind).toBe('synthetic');
    expect(() => {
      (run.manifest.labelsSource as { kind: string }).kind = 'corpus';
    }).toThrow(TypeError);
    const m = juryAccuracy(run);
    expect(m.status === 'measured' && m.synthetic).toBe(true);
  });

  it('rejects unsafe run ids', () => {
    expect(() => asRunId('run\n# injected')).toThrow();
    expect(() => asRunId('a'.repeat(129))).toThrow();
    expect(asRunId('run-1.2:x_y')).toBe('run-1.2:x_y');
  });

  it('rejects two ballots from one juror on one question and unknown votes', () => {
    const dup = replay('a', 'proven-fixed', ['low', 'high']);
    dup.ballots = [ballot('same', 'low'), ballot('same', 'high')];
    expect(() => makeRun({ labels: [], replays: [dup] })).toThrow(/voted twice/);
    const bad = replay('b', 'proven-fixed', []);
    bad.ballots = [{ ...ballot('j', 'low'), vote: 'bogus' } as unknown as Ballot];
    expect(() => makeRun({ labels: [], replays: [bad] })).toThrow(/unknown vote/);
  });

  it('keeps vote scales a permutation of the contract enums', () => {
    for (const opt of Ballot.options) {
      const q = opt.shape.question.value;
      expect([...VOTE_SCALES[q]].sort()).toEqual([...opt.shape.vote.options].sort());
    }
  });

  it('treats partial replays as unmeasured for cost', () => {
    const partial = replay('a', 'proven-fixed', [], 2);
    partial.complete = false;
    partial.opensAt = 'verify';
    const run = makeRun({ labels: [], replays: [partial] });
    const a = costPerVerdict(run);
    const b = costPerCase(run);
    expect(a.status === 'unmeasured' && a.reason).toBe('partial replay');
    expect(b.status === 'unmeasured' && b.reason).toBe('partial replay');
  });

  it('labels non-finite values distinctly', () => {
    const run = makeRun({ labels: [], replays: [replay('a', 'proven-fixed', [], Number.NaN)] });
    const m = costPerCase(run);
    expect(m.status === 'unmeasured' && m.reason).toBe('non-finite value');
  });

  it('reports undetermined when the jury makes no errors', () => {
    const run = makeRun({
      kind: 'corpus',
      labels: [['a', 'proven-fixed']],
      replays: [replay('a', 'proven-fixed', ['low', 'high'])],
      baseline: [['a', 'not-proven']],
    });
    expect(computeReport(run, { minCases: 1 }).juryVsBaseline).toBe('undetermined');
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
