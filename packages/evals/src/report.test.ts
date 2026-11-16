import { describe, expect, it } from 'vitest';
import { asRunId, computeReport } from './calibration.js';
import { renderReport } from './report.js';
import { makeRun, replay, winRun } from './synthetic.test-helpers.js';

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
    const ids = Array.from({ length: 10 }, (_, i) => `c${i}`);
    const run = makeRun({
      kind: 'corpus',
      runId: 'run-abc',
      labels: ids.map((id) => [id, 'proven-fixed']),
      replays: ids.map((id, i) =>
        replay(id, i < 5 ? 'proven-fixed' : 'not-proven', ['high', 'high'], 2),
      ),
      baseline: ids.map((id) => [id, 'proven-fixed']),
    });
    const md = renderReport(computeReport(run));
    expect(md).toContain('run `run-abc`');
    expect(md).toContain('Run id: `run-abc`');
    expect(md).toContain('$2.0000');
    expect(md).toContain('The jury does not beat the single reviewer');
    expect(md).not.toContain(EM_DASH);
  });

  it('claims a win only when supported', () => {
    const report = computeReport(winRun('run-win', 12));
    expect(report.juryVsBaseline).toBe('supported');
    const md = renderReport(report);
    expect(md).toContain('Both conditions held');
    expect(md).toContain('Minimum cases before a win may be claimed: 10');
    expect(md).toContain('cases=12');
    // Too few wrong cases for the default policy: no claim.
    const few = renderReport(computeReport(winRun('run-few', 3)));
    expect(few).not.toContain('Both conditions held');
    expect(few).toContain('undetermined');
  });

  it('says undetermined, not "does not beat", when wrong-case votes cannot be assessed', () => {
    const run = makeRun({
      kind: 'corpus',
      runId: 'run-none',
      labels: [['a', 'proven-fixed']],
      replays: [replay('a', 'proven-fixed', ['low', 'high'])],
      baseline: [['a', 'not-proven']],
    });
    const md = renderReport(computeReport(run));
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
    const good = computeReport(real);
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
    expect(md).toContain('`corpus # Injected heading - [x](http://evil)`');
    expect(md).toContain('`now ## Another`');
  });

  it('strips invisible format characters and backticks from metadata', () => {
    const run = makeRun({
      kind: 'corpus',
      runId: 'run-fmt',
      labels: [['a', 'proven-fixed']],
      replays: [replay('a', 'proven-fixed', ['low', 'high'], 1)],
      ref: 'a​b`c',
      startedAt: 'ok',
    });
    const md = renderReport(computeReport(run));
    expect(md).toContain("`ab'c`");
  });

  it('never prints a win or recommendation for an unexpected labels kind', () => {
    const good = computeReport(winRun('run-kind', 12));
    for (const kind of ['Corpus', undefined, 'other', 'real']) {
      const forged = {
        ...good,
        manifest: { ...good.manifest, labelsSource: { ref: 'x', kind } },
      } as unknown as typeof good;
      const md = renderReport(forged);
      expect(md).not.toContain('jury scored higher');
      expect(md).not.toContain('does not beat');
      expect(md).not.toMatch(/\d/);
    }
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
