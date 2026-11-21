import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { build } from '../../rules/generate-idor-rules.mjs';
import { loadToolManifest, repoRoot } from '../tools/index.js';
import {
  countAnnotations,
  evaluate,
  handlerEndLine,
  handlerEndProblems,
  labelsHit,
  listRuleIds,
  parseNotification,
  parseSemgrepSarif,
  regressionInputsDigest,
  type CorpusLite,
  type Expectations,
  type RuleFinding,
  type TreeRun,
  type TreeVariant,
} from './corpus-regression.js';
import { corpusDataDir, loadCorpusLite, loadExpectations, readStamp, rulesRoot } from './load.js';

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
  idorHandlerEnds: { idor: 9 },
  unlabeledFindings: [],
  allowedNotifications: [
    { file: 'app/assets/vendor/jquery.min.js', rule: 'x' },
    { file: 'app/assets/vendor/m.min.js', rule: null },
  ],
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

  it('allows a Semgrep notification only for an exact (file, rule) pair', () => {
    const runs = good();
    runs.vulnerable.notifications = [
      'Timeout when running x on /src/app/assets/vendor/jquery.min.js:',
      'Syntax error at line /src/app/assets/vendor/m.min.js:1:\n `?.8`',
    ];
    expect(evaluate(corpus, expectations, ids, runs).problems).toEqual([]);
    // Same file, a different rule: not allowed.
    runs.vulnerable.notifications = [
      'Timeout when running y on /src/app/assets/vendor/jquery.min.js:',
    ];
    expect(evaluate(corpus, expectations, ids, runs).problems.join('\n')).toContain(
      'unexplained Semgrep notification',
    );
    // A path that climbs out is never allowed, even if its text starts like an allowed one.
    runs.vulnerable.notifications = [
      'Timeout when running x on /src/app/assets/vendor/../../routes/session.js:',
    ];
    expect(evaluate(corpus, expectations, ids, runs).problems.join('\n')).toContain(
      'unexplained Semgrep notification',
    );
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

describe('handlerEndLine and IDOR labels', () => {
  const text = [
    'const x = {', // 1
    '  handler: (req, res) => {', // 2
    '    const { id } = req.params;', // 3
    '    if (a) {', // 4
    '      call(id);', // 5
    '    }', // 6
    '    const s = "}";', // 7  a brace in a string does not count
    '    // } nor in a comment', // 8
    '  },', // 9
    '  other: () => {', // 10
    '  },', // 11
    '};', // 12
  ].join('\n');

  it('finds the line where the function holding the source closes', () => {
    expect(handlerEndLine(text, 3)).toBe(9);
    // From inside a nested block it is that block that closes.
    expect(handlerEndLine(text, 5)).toBe(6);
    expect(handlerEndLine('a\nb', 1)).toBe(2);
  });

  it('counts a call below the labeled source, in the same handler, as a hit', () => {
    const idorLabel = {
      id: 'idor',
      cls: 'idor',
      file: 'h.js',
      range: { startLine: 3, endLine: 3 },
      source: { file: 'h.js', range: { startLine: 3, endLine: 3 } },
    };
    const call = f(IDOR_P, 'h.js', 5, 5);
    const other = f(IDOR_P, 'h.js', 10, 11);
    const without = { ...corpus, labels: [idorLabel] };
    expect(labelsHit(call, without)).toEqual([]);
    const withEnd = { ...corpus, labels: [{ ...idorLabel, handlerEndLine: 9 }] };
    expect(labelsHit(call, withEnd)).toEqual(['idor']);
    expect(labelsHit(other, withEnd)).toEqual([]);
  });
});

describe('handlerEndLine edge cases', () => {
  it('does not read // inside a string as a comment', () => {
    const text = [
      'a = {', // 1
      '  h: () => {', // 2
      '    const u = "http://x"; }', // 3  the } after the string closes h
      '  ,',
      '  g: () => {', // 5
      '  },', // 6
      '};',
    ].join('\n');
    // Stripping the comment before the string would drop the } and run on to line 6.
    expect(handlerEndLine(text, 3)).toBe(3);
  });

  it('measures a source on the handler opening line to that handler, not the next one', () => {
    const text = [
      "app.get('/a/:id', (req, res) => { const id = req.params.id;", // 1
      '  db.find(id);', // 2
      '});', // 3
      "app.get('/b/:id', (req, res) => {", // 4
      '  db.find(1);', // 5
      '});', // 6
    ].join('\n');
    expect(handlerEndLine(text, 1)).toBe(3);
  });

  it('skips braces in a multi-line template literal, also inside ${ }', () => {
    const text = [
      'const h = (req, res) => {', // 1
      '  const id = req.params.id;', // 2
      '  const q = `select {', // 3
      '    ${ JSON.stringify({ a: 1 }) } }', // 4
      '  {{`;', // 5
      '  db.find(id);', // 6
      '};', // 7
      'const other = () => {', // 8
      '};', // 9
    ].join('\n');
    expect(handlerEndLine(text, 2)).toBe(7);
  });

  it('measures a multi-line destructuring source to the handler, not to the destructuring', () => {
    const text = [
      'const h = (req, res) => {', // 1
      '  const {', // 2
      '    id', // 3
      '  } = req.params;', // 4
      '  db.find(id);', // 5
      '};', // 6
      'const other = () => {', // 7
      '};', // 8
    ].join('\n');
    // Labeled range 2-4: the block the first line opens is closed inside the range.
    expect(handlerEndLine(text, 2, 4)).toBe(6);
    // A range on line 2 alone ends inside the destructuring.
    expect(handlerEndLine(text, 2)).toBe(4);
  });

  it('skips braces in block comments', () => {
    const text = ['f = () => {', '  /* } }', '  } */', '  x();', '};'].join('\n');
    expect(handlerEndLine(text, 4)).toBe(5);
  });
});

describe('pinned IDOR handler ends', () => {
  const label = { ...corpus.labels[1]!, handlerEndLine: 9 };
  it('accepts a computed end equal to the pin', () => {
    expect(handlerEndProblems([label], { idorHandlerEnds: { idor: 9 } })).toEqual([]);
  });
  it('fails when the computed end differs, a pin is missing or a pin is stale', () => {
    expect(handlerEndProblems([label], { idorHandlerEnds: { idor: 12 } }).join('\n')).toContain(
      'computed as 9, pinned as 12',
    );
    expect(handlerEndProblems([label], { idorHandlerEnds: {} }).join('\n')).toContain(
      'no pinned handler end',
    );
    expect(
      handlerEndProblems([label], { idorHandlerEnds: { idor: 9, gone: 3 } }).join('\n'),
    ).toContain('names no idor label: gone');
  });
  it('the expectations on disk pin every IDOR label of the corpus', () => {
    const ids = loadCorpusLite()
      .labels.filter((l) => l.cls === 'idor')
      .map((l) => l.id)
      .sort();
    expect(Object.keys(loadExpectations().idorHandlerEnds).sort()).toEqual(ids);
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

describe('parseNotification', () => {
  it('reads timeouts and syntax errors, and refuses everything else', () => {
    expect(parseNotification('Timeout when running r on /src/app/x/y.js:\n ')).toEqual({
      kind: 'timeout',
      rule: 'r',
      file: 'app/x/y.js',
    });
    expect(parseNotification('Syntax error at line /src/app/m.min.js:1:\n `?.8`')).toEqual({
      kind: 'syntax-error',
      rule: null,
      file: 'app/m.min.js',
    });
    expect(parseNotification('nothing here')).toBeUndefined();
    expect(parseNotification('Timeout when running r on /src/../etc/passwd:')).toBeUndefined();
    expect(parseNotification('Timeout when running r on /src//abs/y.js:')).toBeUndefined();
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
    const files = readdirSync(join(root, 'semgrep')).filter((n) => /\.ya?ml$/.test(n));
    expect(files.length).toBe(ruleIds.length);
    for (const name of files) {
      const text = readFileSync(join(root, 'semgrep', name), 'utf8');
      expect(text, name).not.toMatch(/semgrep\.dev|r2c-|returntocorp/i);
      // No registry or auto config reference of any kind.
      expect(text, name).not.toMatch(/^\s*(extends|include):|config:\s*(auto|p\/)/m);
    }
  });

  it('each have Semgrep test cases that must match and must not match', () => {
    const counts = countAnnotations(join(root, 'tests'));
    for (const id of ruleIds) {
      expect(counts[id]?.ruleid ?? 0, `${id} needs ruleid cases`).toBeGreaterThan(0);
      expect(counts[id]?.ok ?? 0, `${id} needs ok cases`).toBeGreaterThan(0);
    }
  });

  it('keep the committed IDOR YAML equal to what the generator produces', () => {
    for (const [rel, text] of Object.entries(build())) {
      const onDisk = readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
      expect(
        onDisk,
        `${rel} differs from rules/generate-idor-rules.mjs output; rerun the generator`,
      ).toBe(text.replace(/\r\n/g, '\n'));
    }
  });

  it('name the CWE that fits the class: idor is CWE-639, injection is CWE-89 or CWE-943', () => {
    for (const name of readdirSync(join(root, 'semgrep')).filter((n) => /\.ya?ml$/.test(n))) {
      const text = readFileSync(join(root, 'semgrep', name), 'utf8');
      const pairs = [...text.matchAll(/^\s+cls:\s*(\w+)\s*\n\s+cwe:\s*'?(CWE-\d+)'?\s*$/gm)];
      expect(pairs.length, `${name} needs cls and cwe`).toBeGreaterThan(0);
      expect(
        [...text.matchAll(/^\s+cwe:/gm)].length,
        `${name}: every cwe line must pair with a cls line`,
      ).toBe(pairs.length);
      for (const [, cls, cwe] of pairs) {
        const ok = cls === 'idor' ? ['CWE-639'] : cls === 'injection' ? ['CWE-89', 'CWE-943'] : [];
        expect(ok, `${name}: unknown class ${String(cls)}`).not.toEqual([]);
        expect(ok.includes(cwe ?? ''), `${name}: ${String(cls)} with ${String(cwe)}`).toBe(true);
      }
      // The id prefix names the class too (affidavit.idor.* or affidavit.injection.*).
      for (const [, cls] of pairs) expect(text).toContain(`id: affidavit.${String(cls)}.`);
    }
  });

  it('are all listed in the corpus expectations', () => {
    expect(Object.keys(expectationsOnDisk.rules).sort()).toEqual([...ruleIds].sort());
  });
});

describe('every rule change runs the corpus regression', () => {
  it('the regression stamp matches the current rules, tests, expectations, corpus pin, harness and wrapper', () => {
    const stamp = readStamp();
    const now = regressionInputsDigest(repoRoot());
    expect(
      stamp.inputsSha256,
      'rules, rule tests, corpus expectations, the NodeGoat pin or labels, the harness or the Semgrep wrapper changed since the last passing corpus regression. Run: ' +
        'AFFIDAVIT_DOCKER_TESTS=1 AFFIDAVIT_RULES_STAMP=write pnpm --filter @affidavit/discovery exec vitest run corpus-regression.docker ' +
        '(needs Docker and network), then commit packages/discovery/rules/regression-stamp.json and update docs/lanes/lane1/rules-report.md',
    ).toBe(now);
  });

  it('the stamp names the pinned Semgrep image and the pinned NodeGoat commit', () => {
    const stamp = readStamp();
    const semgrep = loadToolManifest().tools.find((t) => t.name === 'semgrep');
    expect(stamp.semgrepImage).toBe(semgrep?.reference);
    const pin = JSON.parse(readFileSync(join(corpusDataDir(), 'pin.json'), 'utf8')) as {
      commit: string;
    };
    expect(stamp.nodegoatCommit).toBe(pin.commit);
    expect(stamp.runOutputSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
