import { describe, expect, it } from 'vitest';
import { ExhibitResult } from '@affidavit/contracts';
import {
  DEFAULT_POLICY,
  NO_EXIT_CODE,
  WITNESS_RULES,
  judgeEvidence,
  rejectBeforeRunning,
} from './rules.js';
import type { Evidence, ObservedAttempt, WitnessRule } from './rules.js';
import { FIXTURE_EXHIBIT_ID, exhibitResultFixture, observed, thrice } from './test-helpers.js';

const ALL = [true, true, true];
const NONE = [false, false, false];

const evidence = (attempts: ObservedAttempt[], familySize = 3): Evidence => ({
  exhibitId: FIXTURE_EXHIBIT_ID,
  familySize,
  attempts,
});

/** The gate shape: whole family passes 3 of 3 on vulnerable and fails 3 of 3 on safe. */
const gate = (): ObservedAttempt[] => [...thrice('vulnerable', ALL), ...thrice('safe', NONE)];

/** Replaces one attempt of the gate evidence. */
const gateWith = (replacement: ObservedAttempt): ObservedAttempt[] =>
  gate().map((a) =>
    a.variant === replacement.variant && a.attempt === replacement.attempt ? replacement : a,
  );

/** The fields a rule decides. Run hashes and durations come from the evidence, not the fixture. */
const decision = (r: ExhibitResult) => ({
  exhibitId: r.exhibitId,
  admissible: r.admissible,
  rejectedBy: r.rejectedBy,
  vulnPass: r.vulnPass,
  safeVariantFail: r.safeVariantFail,
  egressAttempts: r.egressAttempts,
  passed: r.passed,
});

const table: { rule: WitnessRule; why: string; fixture: string; attempts: ObservedAttempt[] }[] = [
  {
    rule: 'schema',
    why: 'one result artifact is not JSON',
    fixture: 'rejected-schema.json',
    attempts: gateWith(observed('safe', 2, NONE, { artifact: '{not json' })),
  },
  {
    rule: 'completes',
    why: 'one attempt hit the hard wall clock',
    fixture: 'rejected-completes.json',
    attempts: gateWith(
      observed('vulnerable', 3, ALL, { exitCode: null, timedOut: true, artifact: null }),
    ),
  },
  {
    rule: 'stable-3of3',
    why: 'attempt 2 on vulnerable disagrees on one parameter',
    fixture: 'rejected-stable-3of3.json',
    attempts: gateWith(observed('vulnerable', 2, [true, false, true])),
  },
  {
    rule: 'no-egress',
    why: 'one attempt tried to reach the network',
    fixture: 'rejected-no-egress.json',
    attempts: gateWith(observed('vulnerable', 1, ALL, { egressAttempts: 1 })),
  },
  {
    rule: 'time-budget',
    why: 'one attempt completed but over the time budget',
    fixture: 'rejected-time-budget.json',
    attempts: gateWith(observed('safe', 1, NONE, { durationMs: DEFAULT_POLICY.timeBudgetMs + 1 })),
  },
  {
    rule: 'differential',
    why: 'the witness passes on both variants',
    fixture: 'rejected-differential.json',
    attempts: [...thrice('vulnerable', ALL), ...thrice('safe', ALL)],
  },
];

describe('rules of evidence: one table test per witness rule', () => {
  it('covers every witness rule', () => {
    expect(table.map((t) => t.rule)).toEqual([...WITNESS_RULES]);
  });

  it.each(table)('$rule rejects when $why', ({ rule, fixture, attempts }) => {
    const result = judgeEvidence(evidence(attempts), DEFAULT_POLICY);
    expect(result.rejectedBy).toBe(rule);
    expect(decision(result)).toEqual(decision(exhibitResultFixture(fixture)));
  });
});

describe('the gate witness', () => {
  it('is admitted with vulnPass and safeVariantFail, matching the admissible fixture', () => {
    const result = judgeEvidence(evidence(gate()), DEFAULT_POLICY);
    const expected = exhibitResultFixture('admissible.json');
    expect(decision(result)).toEqual(decision(expected));
    expect(result.vulnPass).toBe(true);
    expect(result.safeVariantFail).toBe(true);
    expect(result.familyResults).toEqual(expected.familyResults);
    expect(result.runs).toHaveLength(6);
  });
});

describe('rule order', () => {
  it('records the first failing rule when several fail', () => {
    const attempts = gate().map((a) =>
      a.variant === 'vulnerable' && a.attempt === 2
        ? observed('vulnerable', 2, [false, true, true], { egressAttempts: 4, durationMs: 1e9 })
        : a,
    );
    expect(judgeEvidence(evidence(attempts), DEFAULT_POLICY).rejectedBy).toBe('stable-3of3');
  });

  it('checks schema before completes', () => {
    const attempts = gate().map((a) =>
      a.attempt === 1 && a.variant === 'safe'
        ? observed('safe', 1, NONE, { artifact: '[]' })
        : a.attempt === 1
          ? observed('vulnerable', 1, ALL, { timedOut: true, exitCode: null, artifact: null })
          : a,
    );
    expect(judgeEvidence(evidence(attempts), DEFAULT_POLICY).rejectedBy).toBe('schema');
  });
});

describe('differential', () => {
  const judge = (attempts: ObservedAttempt[]) => judgeEvidence(evidence(attempts), DEFAULT_POLICY);

  it('rejects a witness that fails on the vulnerable variant', () => {
    const r = judge([...thrice('vulnerable', NONE), ...thrice('safe', NONE)]);
    expect(r).toMatchObject({ admissible: false, rejectedBy: 'differential', vulnPass: false });
  });

  it('rejects a family where one parameter does not exploit the vulnerable variant', () => {
    const r = judge([...thrice('vulnerable', [true, false, true]), ...thrice('safe', NONE)]);
    expect(r).toMatchObject({ rejectedBy: 'differential', vulnPass: false, safeVariantFail: true });
    expect(r.familyResults?.map((f) => f.passed)).toEqual([true, false, true]);
  });

  it('rejects when one parameter still passes on the safe variant', () => {
    const r = judge([...thrice('vulnerable', ALL), ...thrice('safe', [false, true, false])]);
    expect(r).toMatchObject({ rejectedBy: 'differential', vulnPass: true, safeVariantFail: false });
  });

  it('admits on vulnerable alone when the case has no safe variant, and says so', () => {
    const r = judge(thrice('vulnerable', ALL));
    expect(r).toMatchObject({ admissible: true, vulnPass: true, passed: true });
    expect(r.safeVariantFail).toBeUndefined();
    expect('safeVariantFail' in r).toBe(false);
  });
});

describe('completes and stable-3of3 details', () => {
  const judge = (attempts: ObservedAttempt[]) => judgeEvidence(evidence(attempts), DEFAULT_POLICY);

  it('treats an OOM kill as not completing', () => {
    const r = judge(gateWith(observed('vulnerable', 1, ALL, { oomKilled: true, exitCode: null })));
    expect(r.rejectedBy).toBe('completes');
    expect(r.runs[0]?.exitCode).toBe(NO_EXIT_CODE);
    expect(r.runs[0]?.passed).toBe(false);
  });

  it.each([
    ['an OOM kill', { oomKilled: true, exitCode: 137 }],
    ['a timeout', { timedOut: true, exitCode: 137 }],
  ])('treats %s as not completing even with an exit code and an artifact', (_name, over) => {
    const r = judge(gateWith(observed('vulnerable', 1, ALL, over)));
    expect(r.rejectedBy).toBe('completes');
    expect(r.runs[0]?.exitCode).toBe(137);
    expect(r.runs[0]?.passed).toBe(false);
  });

  it('treats a run that exited without writing an artifact as not completing', () => {
    expect(judge(gateWith(observed('safe', 3, NONE, { artifact: null }))).rejectedBy).toBe(
      'completes',
    );
  });

  it('accepts a non-zero exit code when the artifact is valid (a failing witness exits 1)', () => {
    expect(judge(gate()).admissible).toBe(true);
  });

  it('checks stability on the safe variant too', () => {
    expect(judge(gateWith(observed('safe', 3, [false, false, true]))).rejectedBy).toBe(
      'stable-3of3',
    );
  });

  it('rejects an artifact that reports the wrong family size under schema', () => {
    expect(judge(gateWith(observed('vulnerable', 1, [true, true]))).rejectedBy).toBe('schema');
  });

  it('rejects an oversized artifact under schema', () => {
    const big = observed('vulnerable', 1, ALL, {
      artifact: ' '.repeat(DEFAULT_POLICY.maxArtifactBytes + 1),
    });
    expect(judge(gateWith(big)).rejectedBy).toBe('schema');
  });

  it('allows a run that takes exactly the time budget', () => {
    const r = judge(
      gateWith(observed('safe', 1, NONE, { durationMs: DEFAULT_POLICY.timeBudgetMs })),
    );
    expect(r.admissible).toBe(true);
  });
});

describe('result shape', () => {
  it('always returns a contract-valid ExhibitResult', () => {
    for (const { attempts } of table) {
      expect(() =>
        ExhibitResult.parse(judgeEvidence(evidence(attempts), DEFAULT_POLICY)),
      ).not.toThrow();
    }
  });

  it('hashes stdout and stderr instead of storing them', () => {
    const r = judgeEvidence(
      evidence(gateWith(observed('vulnerable', 1, ALL, { stdout: 'secret-ish output' }))),
      DEFAULT_POLICY,
    );
    expect(JSON.stringify(r)).not.toContain('secret-ish');
    expect(r.runs[0]?.stdoutSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sums egress attempts and durations across all runs', () => {
    const attempts = gateWith(observed('safe', 2, NONE, { egressAttempts: 2, durationMs: 100 }));
    const r = judgeEvidence(evidence(attempts), DEFAULT_POLICY);
    expect(r.egressAttempts).toBe(2);
    expect(r.durationMs).toBe(812 * 5 + 100);
  });

  it('is deterministic for the same evidence', () => {
    const a = judgeEvidence(evidence(gate()), DEFAULT_POLICY);
    const b = judgeEvidence(evidence(gate()), DEFAULT_POLICY);
    expect(a).toEqual(b);
  });

  it('throws on malformed evidence instead of judging it', () => {
    expect(() => judgeEvidence(evidence(thrice('safe', NONE)), DEFAULT_POLICY)).toThrow(
      /vulnerable/,
    );
    expect(() =>
      judgeEvidence(evidence(thrice('vulnerable', ALL).slice(0, 2)), DEFAULT_POLICY),
    ).toThrow(/attempts 1, 2, 3/);
  });

  it('builds a schema rejection with no runs', () => {
    expect(rejectBeforeRunning(FIXTURE_EXHIBIT_ID, 'schema')).toMatchObject({
      admissible: false,
      rejectedBy: 'schema',
      runs: [],
      vulnPass: false,
    });
  });
});

describe('executor output is checked, never trusted', () => {
  it.each([
    ['a NaN egress count', { egressAttempts: Number.NaN }, /egressAttempts/],
    ['a negative egress count', { egressAttempts: -3 }, /egressAttempts/],
    ['a fractional egress count', { egressAttempts: 0.5 }, /egressAttempts/],
    ['a NaN duration', { durationMs: Number.NaN }, /durationMs/],
    ['a negative duration', { durationMs: -1 }, /durationMs/],
    ['a fractional exit code', { exitCode: 1.5 }, /exitCode/],
    ['a non-string artifact', { artifact: 42 as unknown as string }, /artifact/],
  ])('throws on %s instead of judging it', (_name, over, why) => {
    const attempts = gateWith(observed('vulnerable', 2, ALL, over));
    expect(() => judgeEvidence(evidence(attempts), DEFAULT_POLICY)).toThrow(why);
  });

  it('cannot cancel a real egress attempt with a negative count elsewhere', () => {
    const attempts = gateWith(observed('vulnerable', 1, ALL, { egressAttempts: 1 })).map((a) =>
      a.variant === 'safe' && a.attempt === 1 ? { ...a, egressAttempts: -1 } : a,
    );
    expect(() => judgeEvidence(evidence(attempts), DEFAULT_POLICY)).toThrow(/egressAttempts/);
  });
});
