import { Candidate, Dismissal } from '@affidavit/contracts';
import { describe, expect, it } from 'vitest';
import type { CandidateReachability, DataAccessCall } from '../map/index.js';
import {
  arraign,
  arraignConfigFrom,
  DEFAULT_ARRAIGN_CONFIG,
  scoreFacts,
  SCORE_WEIGHTS,
  sinkClassOf,
  type ArraignConfig,
  type ScoreFacts,
} from './index.js';

function cand(over: Partial<Candidate> = {}): Candidate {
  return Candidate.parse({
    schemaVersion: 1,
    id: 'cand-a',
    tool: 'semgrep',
    ruleId: 'affidavit.injection.nosql-where-template',
    cls: 'injection',
    file: 'app/data/allocations-dao.js',
    range: { startLine: 77, endLine: 79 },
    reachability: 'unknown',
    score: 0,
    scoreInputs: {},
    toolAgreement: 1,
    ...over,
  });
}

function reach(
  candidateId: string,
  reachability: CandidateReachability['reachability'],
  authRequired: boolean | 'unknown' = 'unknown',
  reason: CandidateReachability['reason'] = reachability === 'reachable'
    ? 'route-path'
    : reachability === 'unreachable'
      ? 'unreferenced'
      : 'repo-incomplete',
): CandidateReachability {
  return {
    candidateId,
    reachability,
    reason,
    detail: `detail for ${candidateId}`,
    paths:
      reachability === 'reachable'
        ? [
            {
              method: 'GET',
              path: '/x',
              handlerFile: 'app/routes/x.js',
              functions: [],
              middleware: authRequired === true ? ['isLoggedIn'] : [],
              authRequired,
            },
          ]
        : [],
    authRequired,
    pathsComplete: true,
  };
}

const facts = (over: Partial<ScoreFacts> = {}): ScoreFacts => ({
  cls: 'injection',
  reachability: 'reachable',
  sink: 'nosql-where',
  authRequired: true,
  toolAgreement: 1,
  ...over,
});

describe('scoreFacts: a pure, deterministic table', () => {
  // [name, facts, expected score]. Weights: reachability 0.4, sinkType 0.3, noAuthOnPath 0.1,
  // toolAgreement 0.2. toolAgreement input is 1 - 0.5^tools.
  const table: [string, ScoreFacts, number][] = [
    ['gate shape: reachable $where, login on path, one tool', facts(), 0.77],
    ['same without auth on the path', facts({ authRequired: false }), 0.87],
    ['auth unknown', facts({ authRequired: 'unknown' }), 0.82],
    ['two tools agree', facts({ toolAgreement: 2 }), 0.82],
    ['three tools agree', facts({ toolAgreement: 3 }), 0.845],
    ['reachability unknown', facts({ reachability: 'unknown' }), 0.57],
    ['unreachable', facts({ reachability: 'unreachable' }), 0.37],
    [
      'code execution sink, no auth, two tools',
      facts({ sink: 'code-exec', authRequired: false, toolAgreement: 2 }),
      0.95,
    ],
    [
      'dependency, unknown reachability',
      facts({ sink: 'dependency', reachability: 'unknown', authRequired: 'unknown' }),
      0.47,
    ],
    [
      'idor: a login guard neither lowers nor raises it',
      facts({ cls: 'idor', sink: 'data-access', authRequired: true }),
      0.76,
    ],
    [
      'idor without guard scores the same',
      facts({ cls: 'idor', sink: 'data-access', authRequired: false }),
      0.76,
    ],
    ['no tool at all', facts({ toolAgreement: 0 }), 0.67],
  ];

  it.each(table)('%s', (_name, f, expected) => {
    const r = scoreFacts(f);
    expect(r.score).toBeCloseTo(expected, 10);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
  });

  it('records every input it used, under stable names, each in 0..1', () => {
    const r = scoreFacts(facts());
    expect(Object.keys(r.scoreInputs).sort()).toEqual(
      ['noAuthOnPath', 'reachability', 'sinkType', 'toolAgreement'].sort(),
    );
    for (const v of Object.values(r.scoreInputs)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // The score is the weighted sum of the recorded inputs, so a reader can recompute it.
    const sum = Object.entries(SCORE_WEIGHTS).reduce(
      (acc, [k, w]) => acc + w * ((r.scoreInputs as Record<string, number>)[k] ?? NaN),
      0,
    );
    expect(r.score).toBeCloseTo(sum, 4);
  });

  it('gives the same output for the same input, every time', () => {
    const outs = new Set<string>();
    for (let i = 0; i < 50; i++) outs.add(JSON.stringify(scoreFacts(facts({ toolAgreement: 2 }))));
    expect(outs.size).toBe(1);
  });

  it('weights sum to 1, so the score stays in 0..1', () => {
    const total = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('rejects a tool agreement that is not a whole number of tools', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => scoreFacts(facts({ toolAgreement: bad }))).toThrow(RangeError);
    }
  });
});

describe('sinkClassOf', () => {
  const da = (over: Partial<DataAccessCall>): DataAccessCall => ({
    kind: 'mongo',
    method: 'find',
    file: 'app/data/allocations-dao.js',
    startLine: 80,
    endLine: 80,
    fn: { file: 'app/data/allocations-dao.js', name: 'f', startLine: 1, endLine: 99 },
    basis: 'value',
    ...over,
  });

  it.each([
    ['affidavit.injection.nosql-where-template', 'semgrep', 'nosql-where'],
    ['affidavit.injection.nosql-operator-request', 'semgrep', 'nosql-operator'],
    ['affidavit.injection.sql-concat', 'semgrep', 'sql'],
    ['affidavit.injection.sql-request-taint', 'semgrep', 'sql'],
    ['affidavit.idor.route-param-to-data-access', 'semgrep', 'data-access'],
    ['GHSA-xxxx', 'osv', 'dependency'],
    ['some.other.rule', 'codeql', 'unclassified'],
  ] as const)('rule %s from %s is %s', (ruleId, tool, sink) => {
    expect(sinkClassOf(cand({ ruleId, tool }), [])).toBe(sink);
  });

  it('a map data-access call inside the range can raise the sink, never lower it', () => {
    const c = cand({ ruleId: 'some.other.rule', range: { startLine: 79, endLine: 81 } });
    expect(sinkClassOf(c, [da({ kind: 'code-eval', method: 'eval' })])).toBe('code-exec');
    expect(sinkClassOf(c, [da({ kind: 'sql', method: 'query' })])).toBe('sql');
    expect(sinkClassOf(c, [da({ kind: 'mongo' })])).toBe('data-access');
    // Outside the range or in another file: ignored.
    expect(sinkClassOf(c, [da({ kind: 'code-eval', startLine: 90, endLine: 90 })])).toBe(
      'unclassified',
    );
    expect(sinkClassOf(c, [da({ kind: 'code-eval', file: 'other.js' })])).toBe('unclassified');
    // A $where rule next to a plain mongo call stays nosql-where.
    expect(sinkClassOf(cand({ range: { startLine: 79, endLine: 81 } }), [da({})])).toBe(
      'nosql-where',
    );
  });
});

describe('arraign', () => {
  const config: ArraignConfig = { escalationFloor: 0.7, dismissBelow: 0 };

  it('scores a reachable candidate, fills reachability and scoreInputs, and sends it to trial', () => {
    const c = cand();
    const r = arraign({ candidates: [c], reachability: [reach(c.id, 'reachable', true)], config });
    expect(r.dismissed).toEqual([]);
    expect(r.review).toEqual([]);
    expect(r.toTrial).toHaveLength(1);
    const t = r.toTrial[0];
    expect(t?.candidate.reachability).toBe('reachable');
    expect(t?.candidate.score).toBeCloseTo(0.77, 10);
    expect(t?.candidate.scoreInputs).toEqual(scoreFacts(facts()).scoreInputs);
    expect(t?.escalationFloor).toBe(0.7);
    expect(Candidate.safeParse(t?.candidate).success).toBe(true);
    // The input is not mutated.
    expect(c.score).toBe(0);
  });

  it('dismisses an unreachable candidate with reason unreachable and the map detail', () => {
    const c = cand();
    const r = arraign({ candidates: [c], reachability: [reach(c.id, 'unreachable')], config });
    expect(r.toTrial).toEqual([]);
    expect(r.dismissed.map((d) => [d.schemaVersion, d.candidateId, d.reason])).toEqual([
      [1, c.id, 'unreachable'],
    ]);
    expect(r.dismissed[0]?.detail).toContain('unreferenced');
    for (const d of r.dismissed) expect(Dismissal.safeParse(d).success).toBe(true);
  });

  it('never dismisses an unknown candidate', () => {
    const c = cand();
    const r = arraign({
      candidates: [c],
      reachability: [reach(c.id, 'unknown')],
      config: { escalationFloor: 0.9, dismissBelow: 0.65 },
    });
    expect(r.dismissed).toEqual([]);
    expect(r.toTrial.map((t) => t.candidate.id)).toEqual([c.id]);
  });

  it('treats a candidate the map has no answer for as unknown, never as unreachable', () => {
    const c = cand();
    const r = arraign({ candidates: [c], reachability: [], config });
    expect(r.dismissed).toEqual([]);
    expect(r.toTrial[0]?.candidate.reachability).toBe('unknown');
    expect(r.toTrial[0]?.reach.detail).toMatch(/no map answer/);
  });

  it('records an OSV candidate with no reachable path as osv-no-path and never sends it to trial', () => {
    const c = cand({
      id: 'cand-osv',
      tool: 'osv',
      ruleId: 'GHSA-1',
      file: 'package-lock.json',
      range: { startLine: 1, endLine: 1 },
    });
    for (const rv of ['unknown', 'unreachable'] as const) {
      const r = arraign({ candidates: [c], reachability: [reach(c.id, rv)], config });
      expect(r.toTrial).toEqual([]);
      expect(r.dismissed.map((d) => d.reason)).toEqual(['osv-no-path']);
    }
  });

  it('dismisses below the threshold only when reachability is known', () => {
    const cfg = { escalationFloor: 0.9, dismissBelow: 0.8 };
    const low = cand({ id: 'cand-low' });
    const unk = cand({ id: 'cand-unk' });
    const r = arraign({
      candidates: [low, unk],
      reachability: [reach(low.id, 'reachable', true), reach(unk.id, 'unknown')],
      config: cfg,
    });
    expect(r.dismissed.map((d) => [d.candidateId, d.reason])).toEqual([
      ['cand-low', 'below-threshold'],
    ]);
    expect(r.toTrial.map((t) => t.candidate.id)).toEqual(['cand-unk']);
  });

  it('dismisses a candidate on a known negative control', () => {
    const c = cand({ range: { startLine: 114, endLine: 118 } });
    const r = arraign({
      candidates: [c],
      reachability: [reach(c.id, 'unknown')],
      negativeControls: [
        {
          id: 'nc-1',
          tree: { commit: 'a'.repeat(40), patches: [] },
          ruleId: c.ruleId,
          cls: c.cls,
          file: c.file,
          range: { startLine: 110, endLine: 120 },
        },
      ],
      tree: { commit: 'a'.repeat(40), patches: [] },
      config,
    });
    expect(r.dismissed.map((d) => d.reason)).toEqual(['negative-control']);
    expect(r.dismissed[0]?.detail).toContain('nc-1');
  });

  it('never silently dismisses at or above the escalation floor: it holds the candidate for review', () => {
    // A low floor puts an unreachable candidate's score above it.
    const c = cand();
    const r = arraign({
      candidates: [c],
      reachability: [reach(c.id, 'unreachable', false)],
      config: { escalationFloor: 0.3, dismissBelow: 0 },
    });
    expect(r.dismissed).toEqual([]);
    expect(r.toTrial).toEqual([]);
    expect(r.review).toHaveLength(1);
    expect(r.review[0]?.wouldDismiss).toBe('unreachable');
    expect(r.review[0]?.candidate.score).toBeGreaterThanOrEqual(0.3);
  });

  it('accounts for every candidate exactly once, and every filtered one has a reason', () => {
    const cs = [
      cand({ id: 'c1' }),
      cand({ id: 'c2' }),
      cand({
        id: 'c3',
        tool: 'osv',
        ruleId: 'GHSA-2',
        file: 'package-lock.json',
        range: { startLine: 1, endLine: 1 },
      }),
      cand({ id: 'c4' }),
    ];
    const r = arraign({
      candidates: cs,
      reachability: [
        reach('c1', 'reachable', true),
        reach('c2', 'unreachable'),
        reach('c3', 'unknown'),
      ],
      config,
    });
    const ids = [
      ...r.toTrial.map((t) => t.candidate.id),
      ...r.dismissed.map((d) => d.candidateId),
      ...r.review.map((x) => x.candidate.id),
    ].sort();
    expect(ids).toEqual(['c1', 'c2', 'c3', 'c4']);
    for (const d of r.dismissed) {
      expect(d.reason.length).toBeGreaterThan(0);
      expect(d.detail.length).toBeGreaterThan(0);
    }
  });

  it('is order independent: shuffled input gives the same result', () => {
    const cs = [cand({ id: 'c1' }), cand({ id: 'c2', toolAgreement: 2 }), cand({ id: 'c3' })];
    const rs = [
      reach('c1', 'reachable', true),
      reach('c2', 'reachable', false),
      reach('c3', 'unknown'),
    ];
    const a = arraign({ candidates: cs, reachability: rs, config });
    const b = arraign({ candidates: [...cs].reverse(), reachability: [...rs].reverse(), config });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    // Highest score first.
    expect(a.toTrial.map((t) => t.candidate.id)).toEqual(['c2', 'c1', 'c3']);
  });

  it('rejects duplicate candidate ids instead of guessing', () => {
    expect(() => arraign({ candidates: [cand(), cand()], reachability: [], config })).toThrow(
      /duplicate candidate id/,
    );
  });
});

describe('arraign config', () => {
  it('defaults', () => {
    expect(arraignConfigFrom({})).toEqual(DEFAULT_ARRAIGN_CONFIG);
  });

  it('reads the floor and the dismissal threshold from the environment', () => {
    expect(
      arraignConfigFrom({ AFFIDAVIT_ESCALATION_FLOOR: '0.6', AFFIDAVIT_DISMISS_BELOW: '0.2' }),
    ).toEqual({ escalationFloor: 0.6, dismissBelow: 0.2 });
  });

  it('rejects values outside 0..1, non-numbers, and a threshold above the floor', () => {
    for (const env of [
      { AFFIDAVIT_ESCALATION_FLOOR: '1.5' },
      { AFFIDAVIT_ESCALATION_FLOOR: '-0.1' },
      { AFFIDAVIT_ESCALATION_FLOOR: 'high' },
      { AFFIDAVIT_ESCALATION_FLOOR: '' },
      { AFFIDAVIT_DISMISS_BELOW: 'NaN' },
      { AFFIDAVIT_ESCALATION_FLOOR: '0.5', AFFIDAVIT_DISMISS_BELOW: '0.6' },
    ]) {
      expect(() => arraignConfigFrom(env), JSON.stringify(env)).toThrow(RangeError);
    }
    expect(() =>
      arraign({
        candidates: [],
        reachability: [],
        config: { escalationFloor: 2, dismissBelow: 0 },
      }),
    ).toThrow(RangeError);
  });
});
