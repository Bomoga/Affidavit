import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  countAnnotations,
  evaluate,
  listRuleIds,
  notificationPath,
  parseSemgrepSarif,
  rulesDigest,
  type CorpusLite,
  type Expectations,
  type RuleFinding,
  type TreeRun,
  type TreeVariant,
} from './corpus-regression.js';
import { loadCorpusLite, loadExpectations, readStamp, rulesRoot } from './load.js';

const NOSQL = 'affidavit.injection.nosql-where-template';
const IDOR_P = 'affidavit.idor.route-param-to-data-access';
const IDOR_B = 'affidavit.idor.request-id-to-data-access';

const corpus: CorpusLite = {
  labels: [
    {
      id: 'gate',
      cls: 'injection',
      file: 'dao.js',
      range: { startLine: 77, endLine: 79 },
      source: { file: 'route.js', range: { startLine: 19, endLine: 21 } },
    },
    {
      id: 'idor',
      cls: 'idor',
      file: 'route.js',
      range: { startLine: 16, endLine: 18 },
      source: { file: 'route.js', range: { startLine: 16, endLine: 18 } },
    },
    {
      id: 'eval',
      cls: 'injection',
      file: 'c.js',
      range: { startLine: 32, endLine: 34 },
      source: { file: 'c.js', range: { startLine: 32, endLine: 34 } },
    },
  ],
  safeVariants: [{ id: 'safe-gate', fixes: 'gate' }],
  negativeControls: [
    { id: 'nc', file: 'dao.js', range: { startLine: 114, endLine: 118 }, expectedRuleIds: [NOSQL] },
  ],
};

const expectations: Expectations = {
  app: 'x',
  rules: {
    [NOSQL]: { catches: ['gate'], flagsControls: ['nc'] },
    [IDOR_P]: { catches: ['idor'], flagsControls: [] },
  },
  notTargeted: { eval: 'not an MVP class' },
  unlabeledFindings: [],
  allowedNotificationPathPrefixes: ['app/assets/vendor/'],
};

const f = (ruleId: string, file: string, startLine: number, endLine = startLine): RuleFinding => ({
  ruleId,
  file,
  startLine,
  endLine,
});

const good = (): Record<TreeVariant, TreeRun> => ({
  vulnerable: {
    variant: 'vulnerable',
    findings: [f(NOSQL, 'dao.js', 77, 79), f(IDOR_P, 'route.js', 16, 18)],
    notifications: [],
  },
  safe: { variant: 'safe', findings: [f(IDOR_P, 'route.js', 16, 18)], notifications: [] },
  'negative-control': {
    variant: 'negative-control',
    findings: [f(IDOR_P, 'route.js', 16, 18), f(NOSQL, 'dao.js', 115, 117)],
    notifications: [],
  },
});

const ids = [NOSQL, IDOR_P];

describe('evaluate', () => {
  it('passes when every rule matches the labels', () => {
    const e = evaluate(corpus, expectations, ids, good());
    expect(e.problems).toEqual([]);
    expect(e.rows.find((r) => r.ruleId === NOSQL)).toMatchObject({
      caught: ['gate'],
      controlsFlagged: ['nc'],
      fixedSiteFindingsOnSafe: 0,
    });
    expect(e.missed).toEqual([{ labelId: 'eval', reason: 'not an MVP class' }]);
  });

  it('fails when a rule stops catching its labeled issue', () => {
    const runs = good();
    runs.vulnerable.findings = [f(IDOR_P, 'route.js', 16, 18)];
    const { problems } = evaluate(corpus, expectations, ids, runs);
    expect(problems.join('\n')).toContain(`vulnerable: ${NOSQL} caught [none], expected [gate]`);
  });

  it('fails when a rule still reports the site the safe patch fixed', () => {
    const runs = good();
    runs.safe.findings.push(f(NOSQL, 'dao.js', 77, 79));
    const { problems } = evaluate(corpus, expectations, ids, runs);
    expect(problems.join('\n')).toContain('differential check');
  });

  it('fails when a negative control is no longer flagged', () => {
    const runs = good();
    runs['negative-control'].findings = [f(IDOR_P, 'route.js', 16, 18)];
    const { problems } = evaluate(corpus, expectations, ids, runs);
    const text = problems.join('\n');
    expect(text).toContain('expects ' + NOSQL + ' to flag it');
    expect(text).toContain(`flagged controls [none], expected [nc]`);
  });

  it('fails on a finding in no labeled issue (a new false positive)', () => {
    const runs = good();
    runs.vulnerable.findings.push(f(NOSQL, 'other.js', 5, 6));
    const { problems } = evaluate(corpus, expectations, ids, runs);
    expect(problems.join('\n')).toContain('other.js:5-6');
  });

  it('accepts a finding listed in the expectations as a known unlabeled finding', () => {
    const runs = good();
    runs.vulnerable.findings.push(f(NOSQL, 'other.js', 5, 6));
    const known: Expectations = {
      ...expectations,
      unlabeledFindings: [{ ruleId: NOSQL, file: 'other.js', startLine: 5 }],
    };
    expect(evaluate(corpus, known, ids, runs).problems).toEqual([]);
  });

  it('fails when a label is missed and not explained, or explained and caught', () => {
    const noReason: Expectations = { ...expectations, notTargeted: {} };
    expect(evaluate(corpus, noReason, ids, good()).problems.join('\n')).toContain(
      'label eval was caught by no rule and is not listed as not targeted',
    );
    const stale: Expectations = {
      ...expectations,
      notTargeted: { eval: 'x', gate: 'x' },
    };
    expect(evaluate(corpus, stale, ids, good()).problems.join('\n')).toContain(
      'label gate is listed as not targeted but a rule caught it',
    );
  });

  it('fails when a rule has no expectations entry, or the entry has no rule', () => {
    const p1 = evaluate(corpus, expectations, [...ids, IDOR_B], good()).problems.join('\n');
    expect(p1).toContain(`rule ${IDOR_B} has no entry`);
    const p2 = evaluate(corpus, expectations, [NOSQL], good()).problems.join('\n');
    expect(p2).toContain(`expectations name rule ${IDOR_P}, which does not exist`);
  });

  it('allows a Semgrep notification only for the named vendored paths', () => {
    const runs = good();
    runs.vulnerable.notifications = [
      'Timeout when running x on /src/app/assets/vendor/jquery.min.js:',
    ];
    expect(evaluate(corpus, expectations, ids, runs).problems).toEqual([]);
    runs.vulnerable.notifications = ['Timeout when running x on /src/app/routes/session.js:'];
    expect(evaluate(corpus, expectations, ids, runs).problems.join('\n')).toContain(
      'unexplained Semgrep notification',
    );
    runs.vulnerable.notifications = ['something with no path'];
    expect(evaluate(corpus, expectations, ids, runs).problems.join('\n')).toContain(
      'unexplained Semgrep notification',
    );
  });
});

describe('parseSemgrepSarif', () => {
  it('reads rule id, repo-relative file and lines, and skips malformed results', () => {
    const doc = {
      runs: [
        {
          results: [
            {
              ruleId: NOSQL,
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: '/src/app/data/a.js' },
                    region: { startLine: 3, endLine: 5 },
                  },
                },
              ],
            },
            { ruleId: NOSQL, locations: [] },
            { locations: [] },
          ],
        },
      ],
    };
    expect(parseSemgrepSarif(doc)).toEqual([f(NOSQL, 'app/data/a.js', 3, 5)]);
  });

  it('rejects a document with no runs', () => {
    expect(() => parseSemgrepSarif({})).toThrow(/no runs/);
  });
});

describe('notificationPath', () => {
  it('extracts the path named in a notification', () => {
    expect(notificationPath('Timeout when running r on /src/app/x/y.js:')).toBe('app/x/y.js');
    expect(notificationPath('nothing here')).toBeUndefined();
  });
});

describe('the rule files', () => {
  const root = rulesRoot();
  const ruleIds = listRuleIds(join(root, 'semgrep'));
  const expectationsOnDisk = loadExpectations();

  it('are our own, with the ids the corpus expects, and no registry reference', () => {
    expect(ruleIds.length).toBeGreaterThanOrEqual(6);
    expect(new Set(ruleIds).size).toBe(ruleIds.length);
    for (const id of ruleIds) expect(id).toMatch(/^affidavit\.(injection|idor)\.[a-z0-9-]+$/);
    const corpus = loadCorpusLite();
    for (const c of corpus.negativeControls) {
      for (const id of c.expectedRuleIds) expect(ruleIds).toContain(id);
    }
    for (const name of ['injection-sql-concat.yaml', 'idor-route-param.yaml']) {
      const text = readFileSync(join(root, 'semgrep', name), 'utf8');
      expect(text).not.toMatch(/semgrep\.dev|r2c-|returntocorp/i);
    }
  });

  it('each have Semgrep test cases that must match and must not match', () => {
    const counts = countAnnotations(join(root, 'tests'));
    for (const id of ruleIds) {
      expect(counts[id]?.ruleid ?? 0, `${id} needs ruleid cases`).toBeGreaterThan(0);
      expect(counts[id]?.ok ?? 0, `${id} needs ok cases`).toBeGreaterThan(0);
    }
  });

  it('are all listed in the corpus expectations', () => {
    expect(Object.keys(expectationsOnDisk.rules).sort()).toEqual([...ruleIds].sort());
  });
});

describe('every rule change runs the corpus regression', () => {
  it('the regression stamp matches the current rules, tests and expectations', () => {
    const stamp = readStamp();
    const now = rulesDigest(rulesRoot());
    expect(
      stamp.rulesSha256,
      'rules, rule tests or corpus expectations changed since the last passing corpus regression. Run: ' +
        'AFFIDAVIT_DOCKER_TESTS=1 AFFIDAVIT_RULES_STAMP=write pnpm --filter @affidavit/discovery exec vitest run corpus-regression.docker ' +
        '(needs Docker and network), then commit packages/discovery/rules/regression-stamp.json and update docs/lanes/lane1/rules-report.md',
    ).toBe(now);
  });
});
