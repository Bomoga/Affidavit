import { describe, expect, it } from 'vitest';
import { computeReport } from './calibration.js';
import { renderReport } from './report.js';
import { makeRun, replay } from './test-helpers.js';

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
    const md = renderReport(computeReport(run));
    expect(md).toContain('run run-abc');
    expect(md).toContain('Run id: run-abc');
    expect(md).toContain('$2.0000');
    expect(md).toContain('The jury does not beat the single reviewer');
    expect(md).not.toContain(EM_DASH);
  });

  it('claims a win only when supported', () => {
    const run = makeRun({
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
    const report = computeReport(run);
    expect(report.juryVsBaseline).toBe('supported');
    expect(renderReport(report)).toContain('Both conditions held');
  });
});
