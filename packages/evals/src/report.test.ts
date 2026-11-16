import { describe, expect, it } from 'vitest';
import { asRunId, computeReport } from './calibration.js';
import { renderReport } from './report.js';
import { makeRun, replay } from './synthetic.test-helpers.js';

const EM_DASH = '—';

describe('renderReport', () => {
  it('renders only placeholders for an empty run, with no digits', () => {
    const md = renderReport(computeReport(makeRun({ labels: [], replays: [] })));
    expect(md).toContain('[metric]');
    expect(md).not.toMatch(/\d/);
    expect(md).not.toContain(EM_DASH);
    expect(md).toContain('No run-backed comparison exists yet');
  });

  it('never renders a number for synthetic labels', () => {
    const run = makeRun({
      kind: 'synthetic',
      runId: 'synthetic-run',
      labels: [['c', 'proven-fixed']],
      replays: [replay('c', 'proven-fixed', ['low', 'high'], 2)],
      baseline: [['c', 'proven-fixed']],
    });
    const md = renderReport(computeReport(run));
    expect(md).not.toMatch(/\d/);
    expect(md).not.toContain('synthetic-run');
    expect(md).not.toContain(EM_DASH);
  });

  it('prints numbers with run ids for corpus labels, and says when the jury does not beat the baseline', () => {
    const run = makeRun({
      kind: 'corpus',
      runId: 'run-abc',
      labels: [
        ['a', 'proven-fixed'],
        ['b', 'not-proven'],
      ],
      replays: [
        replay('a', 'proven-fixed', ['high', 'high'], 1),
        replay('b', 'proven-fixed', ['low', 'low'], 3),
      ],
      baseline: [
        ['a', 'proven-fixed'],
        ['b', 'not-proven'],
      ],
    });
    const md = renderReport(computeReport(run, { minCases: 1 }));
    expect(md).toContain('run run-abc');
    expect(md).toContain('Run id: run-abc');
    expect(md).toContain('$2.0000');
    expect(md).toContain('The jury does not beat the single reviewer');
    expect(md).not.toContain(EM_DASH);
  });

  it('claims a win only when supported', () => {
    const run = makeRun({
      kind: 'corpus',
      runId: 'run-win',
      labels: [
        ['a', 'proven-fixed'],
        ['b', 'not-proven'],
        ['c', 'proven-fixed'],
        ['d', 'proven-fixed'],
      ],
      replays: [
        replay('a', 'proven-fixed', ['low', 'critical']),
        replay('b', 'not-proven', ['low', 'critical']),
        replay('c', 'not-proven', ['critical', 'low']),
        replay('d', 'not-proven', ['low', 'critical']),
      ],
      baseline: [
        ['a', 'not-proven'],
        ['b', 'not-proven'],
        ['c', 'not-proven'],
        ['d', 'not-proven'],
      ],
    });
    expect(computeReport(run).juryVsBaseline).toBe('undetermined');
    const report = computeReport(run, { minCases: 1 });
    expect(report.juryVsBaseline).toBe('supported');
    const md = renderReport(report);
    expect(md).toContain('Both conditions held');
    expect(md).toContain('Minimum cases before a win may be claimed: 1');
  });

  it('says undetermined, not "does not beat", when wrong-case votes cannot be assessed', () => {
    const run = makeRun({
      kind: 'corpus',
      runId: 'run-none',
      labels: [['a', 'proven-fixed']],
      replays: [replay('a', 'proven-fixed', ['low', 'high'])],
      baseline: [['a', 'not-proven']],
    });
    const md = renderReport(computeReport(run, { minCases: 1 }));
    expect(md).toContain('The comparison is undetermined');
    expect(md).not.toContain('does not beat');
  });

  it('renders the placeholder for a metric tagged with another run id', () => {
    const run = makeRun({
      kind: 'corpus',
      runId: 'run-mine',
      labels: [['a', 'proven-fixed']],
      replays: [replay('a', 'proven-fixed', ['low', 'high'], 1)],
    });
    const report = computeReport(run);
    const foreign = { ...report.juryAccuracy };
    if (foreign.status !== 'measured') throw new Error('expected measured');
    const tampered = { ...report, juryAccuracy: { ...foreign, runId: asRunId('run-other') } };
    const md = renderReport(tampered);
    expect(md).toContain('- Jury: [metric]');
    expect(md).not.toContain('run-other');
  });

  it('does not trust a stored supported call', () => {
    const run = makeRun({
      kind: 'corpus',
      runId: 'run-forge',
      labels: [['a', 'proven-fixed']],
      replays: [replay('a', 'proven-fixed', ['low', 'high'])],
    });
    const forged = { ...computeReport(run), juryVsBaseline: 'supported' as const };
    const md = renderReport(forged);
    expect(md).not.toContain('jury scored higher');
    expect(md).toContain('undetermined');
  });

  it('renders placeholders only for a hand-built report, even if every field looks real', () => {
    const real = makeRun({
      kind: 'corpus',
      runId: 'run-real',
      labels: [['a', 'proven-fixed']],
      replays: [replay('a', 'proven-fixed', ['low', 'high'], 1)],
    });
    const good = computeReport(real, { minCases: 1 });
    const metric = (v: number) =>
      ({
        status: 'measured',
        value: v,
        n: 20,
        cases: 20,
        runId: asRunId('run-real'),
        synthetic: false,
      }) as const;
    const forged = {
      manifest: {
        ...good.manifest,
        labelsSource: { kind: 'synthetic' as const, ref: 'fake' },
      },
      juryAccuracy: metric(0.9),
      baselineAccuracy: metric(0.5),
      agreementAll: metric(0.5),
      correlationAll: metric(0.1),
      agreementWrong: metric(0.5),
      correlationWrong: metric(0.1),
      costPerVerdict: metric(1),
      costPerCase: metric(1),
      juryVsBaseline: 'supported' as const,
      policy: { minCases: 1, maxWrongCaseCorrelation: 0.5 },
    };
    for (const report of [forged, { ...forged, manifest: good.manifest }]) {
      const md = renderReport(report);
      expect(md).not.toMatch(/\d/);
      expect(md).not.toContain('jury scored higher');
      expect(md).toContain('undetermined');
    }
  });

  it('never yields a win for invalid policies', () => {
    const run = makeRun({
      kind: 'corpus',
      runId: 'run-pol',
      labels: [['a', 'proven-fixed']],
      replays: [replay('a', 'not-proven', ['low', 'high'])],
      baseline: [['a', 'not-proven']],
    });
    for (const policy of [{ minCases: Number.NaN }, { minCases: 0 }]) {
      expect(renderReport(computeReport(run, policy))).not.toContain('jury scored higher');
    }
  });

  it('escapes newlines and markdown in free-text fields', () => {
    const run = makeRun({
      kind: 'corpus',
      runId: 'run-esc',
      labels: [['a', 'proven-fixed']],
      replays: [replay('a', 'proven-fixed', ['low', 'high'], 1)],
      ref: 'corpus\n# Injected heading\n- [x](http://evil)',
      startedAt: 'now\n## Another',
    });
    const md = renderReport(computeReport(run));
    expect(md.split('\n').filter((l) => l.startsWith('#'))).toEqual([
      '# Calibration',
      '## Accuracy against labels',
      '## Inter-juror votes',
      '## Cost',
      '## Jury versus single reviewer',
    ]);
    expect(md).toContain('corpus \\# Injected heading');
  });

  it('notes that cost per verdict excludes escalated and dismissed spend', () => {
    const run = makeRun({
      kind: 'corpus',
      runId: 'run-cost',
      labels: [],
      replays: [replay('a', 'proven-fixed', [], 2), replay('b', 'escalated', [], 6, false)],
    });
    const md = renderReport(computeReport(run));
    expect(md).toContain('Cost per verdict: $2.0000');
    expect(md).toContain('Cost per case: $4.0000');
    expect(md).toContain('excluded');
  });
});
