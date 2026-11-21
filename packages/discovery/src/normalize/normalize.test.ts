import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Candidate } from '@affidavit/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { repoRoot, type ToolRunResult } from '../tools/index.js';
import { cleanupTmp, put, tmp } from '../tools/testkit.js';
import {
  IDOR_CWES,
  INJECTION_CWES,
  MalformedReportError,
  NORMALIZE_LIMITS,
  classOf,
  cweNumber,
  cweNumbers,
  normalizeReports,
  readToolRunReports,
  type MalformedCode,
  type ReportInput,
} from './index.js';

afterAll(cleanupTmp);

const base = join(repoRoot(), 'fixtures', 'corpus', 'normalize');
const recorded = (name: string): unknown =>
  JSON.parse(readFileSync(join(base, 'recorded', name), 'utf8')) as unknown;

const semgrep: ReportInput = { tool: 'semgrep', doc: recorded('semgrep.sarif.fixture') };
const codeql: ReportInput = { tool: 'codeql', doc: recorded('codeql.sarif') };
const osv1: ReportInput = { tool: 'osv', doc: recorded('osv-AFFIDAVIT-NORM-0001.json.fixture') };
const osv2: ReportInput = { tool: 'osv', doc: recorded('osv-AFFIDAVIT-NORM-0002.json.fixture') };
const all = [semgrep, codeql, osv1, osv2];

function expectMalformed(inputs: ReportInput[], code?: MalformedCode): MalformedReportError {
  try {
    normalizeReports(inputs);
  } catch (e) {
    expect(e).toBeInstanceOf(MalformedReportError);
    if (code) expect((e as MalformedReportError).code).toBe(code);
    return e as MalformedReportError;
  }
  throw new Error('expected MalformedReportError');
}

const sarif = (results: unknown, rules: unknown = []) => ({
  version: '2.1.0',
  runs: [{ tool: { driver: { name: 'x', rules } }, results }],
});

const sqlResult = (uri: unknown, region: unknown = { startLine: 5 }) => ({
  ruleId: 'r.sql',
  locations: [{ physicalLocation: { artifactLocation: { uri }, region } }],
});
const sqlRule = [{ id: 'r.sql', properties: { tags: ['CWE-89'] } }];

describe('golden output over recorded tool runs', () => {
  const goldenFile = join(base, 'golden', 'normalized.golden.json.fixture');

  it('matches the committed golden file', () => {
    const result = normalizeReports(all);
    if (process.env['AFFIDAVIT_UPDATE_GOLDEN'] === '1') {
      writeFileSync(goldenFile, JSON.stringify(result, null, 2) + '\n');
    }
    expect(result).toEqual(JSON.parse(readFileSync(goldenFile, 'utf8')));
  });

  it('is independent of input order and of repeated runs', () => {
    const expected = JSON.stringify(normalizeReports(all));
    expect(JSON.stringify(normalizeReports([osv2, codeql, osv1, semgrep]))).toBe(expected);
    expect(JSON.stringify(normalizeReports(all))).toBe(expected);
  });

  it('produces valid, unique Candidates in deterministic order', () => {
    const { candidates } = normalizeReports(all);
    for (const c of candidates) expect(Candidate.safeParse(c).success).toBe(true);
    expect(new Set(candidates.map((c) => c.id)).size).toBe(candidates.length);
    const keys = candidates.map((c) => `${c.file}:${String(c.range.startLine).padStart(9, '0')}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('merges overlapping findings and counts distinct tools', () => {
    const { candidates } = normalizeReports([semgrep, codeql]);
    const sql = candidates.filter((c) => c.file === 'src/routes.js' && c.range.startLine === 9);
    // Two Semgrep rules and one CodeQL rule on line 9 are one issue, seen by two tools.
    expect(sql).toHaveLength(1);
    // Among equals, the lowest rule id (bytewise) is the primary.
    expect(sql[0]).toMatchObject({
      tool: 'semgrep',
      ruleId: 'affidavit.normalize.query-from-request',
    });
    expect(sql[0]?.toolAgreement).toBe(2);
    const nosql = candidates.find((c) => c.range.startLine === 15);
    expect(nosql?.toolAgreement).toBe(2);
    const idor = candidates.find((c) => c.cls === 'idor');
    expect(idor).toMatchObject({ file: 'src/routes.js', toolAgreement: 1 });
    const cmd = candidates.find((c) => c.file === 'src/admin.js');
    expect(cmd).toMatchObject({
      tool: 'codeql',
      toolAgreement: 1,
      range: { startLine: 3, endLine: 4 },
    });
  });

  it('two rules of one tool on the same lines count as one tool', () => {
    const { candidates } = normalizeReports([semgrep]);
    expect(candidates.find((c) => c.range.startLine === 9)?.toolAgreement).toBe(1);
  });

  it('surfaces findings outside the MVP classes instead of dropping them', () => {
    const { candidates, skipped } = normalizeReports(all);
    expect(skipped.map((s) => `${s.tool}:${s.ruleId}:${s.reason}`)).toEqual([
      'codeql:js/reflected-xss:unmapped-class',
      'osv:AFFIDAVIT-NORM-0002:unmapped-class',
    ]);
    expect(candidates.some((c) => c.ruleId === 'AFFIDAVIT-NORM-0002')).toBe(false);
  });

  it('turns an OSV advisory with an injection CWE into a lockfile candidate', () => {
    const c = normalizeReports([osv1]).candidates;
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({
      tool: 'osv',
      ruleId: 'AFFIDAVIT-NORM-0001',
      cls: 'injection',
      file: 'package-lock.json',
      range: { startLine: 1, endLine: 1 },
      toolAgreement: 1,
    });
  });

  it('keeps distinct OSV advisories in one lockfile apart', () => {
    const doc = (id: string) => ({
      results: [
        {
          source: { path: '/src/package-lock.json', type: 'lockfile' },
          packages: [
            {
              package: { name: 'p', version: '1', ecosystem: 'npm' },
              vulnerabilities: [{ id, database_specific: { cwe_ids: ['CWE-89'] } }],
            },
          ],
        },
      ],
    });
    const out = normalizeReports([
      { tool: 'osv', doc: doc('A-1') },
      { tool: 'osv', doc: doc('A-2') },
      { tool: 'osv', doc: doc('A-1') },
    ]);
    expect(out.candidates.map((c) => c.ruleId).sort()).toEqual(['A-1', 'A-2']);
  });

  it('never carries message text or snippets into a Candidate', () => {
    const text = JSON.stringify(normalizeReports(all));
    expect(text).not.toMatch(/IGNORE PREVIOUS/i);
    expect(text).not.toContain('SELECT');
  });

  it('reports which tools were partial', () => {
    expect(normalizeReports([{ ...semgrep, partial: true }, codeql]).partialTools).toEqual([
      'semgrep',
    ]);
  });

  it('ignores suppressions, so a repo cannot hide a finding', () => {
    const doc = sarif(
      [{ ...sqlResult('/src/a.js'), suppressions: [{ kind: 'inSource' }] }],
      sqlRule,
    );
    expect(normalizeReports([{ tool: 'semgrep', doc }]).candidates).toHaveLength(1);
  });

  it('does not chain overlaps: a wide range cannot bridge two separate issues', () => {
    // Semgrep A at line 10, Semgrep B at line 40, CodeQL C over 10-40, one class, one file.
    const rules = [{ id: 'A', properties: { tags: ['CWE-89'] } }];
    const result = (ruleId: string, region: unknown) => ({
      ...sqlResult('/src/x.js', region),
      ruleId,
    });
    const semgrepDoc = sarif(
      [result('A', { startLine: 10 }), result('B', { startLine: 40 })],
      [...rules, { id: 'B', properties: { tags: ['CWE-89'] } }],
    );
    const codeqlDoc = sarif(
      [result('C', { startLine: 10, endLine: 40 })],
      [{ id: 'C', properties: { tags: ['CWE-89'] } }],
    );
    const out = normalizeReports([
      { tool: 'semgrep', doc: semgrepDoc },
      { tool: 'codeql', doc: codeqlDoc },
    ]);
    expect(
      out.candidates.map((c) => `${c.ruleId}:${c.range.startLine}:${c.toolAgreement}`),
    ).toEqual(['A:10:2', 'B:40:1']);
    // Every input finding is on record in exactly one candidate.
    expect(out.merged.flatMap((m) => m.members.map((x) => x.ruleId)).sort()).toEqual([
      'A',
      'B',
      'C',
    ]);
  });

  it('a wide preferred range does not swallow separate narrow issues', () => {
    const sg = (rule: string, region: unknown) => ({
      ...sqlResult('/src/x.js', region),
      ruleId: rule,
    });
    const rules = ['wide', 'a', 'b'].map((id) => ({ id, properties: { tags: ['CWE-89'] } }));
    const semgrepDoc = sarif([sg('wide', { startLine: 1, endLine: 100 })], rules);
    const codeqlDoc = sarif([sg('a', { startLine: 10 }), sg('b', { startLine: 90 })], rules);
    const out = normalizeReports([
      { tool: 'semgrep', doc: semgrepDoc },
      { tool: 'codeql', doc: codeqlDoc },
    ]);
    expect(out.candidates).toHaveLength(2);
    // The line-90 issue has a candidate of its own, and ids are unique.
    expect(out.merged.some((m) => m.members.some((x) => x.ruleId === 'b'))).toBe(true);
    const own90 = out.merged.find((m) => m.members.some((x) => x.ruleId === 'b'));
    expect(own90?.members.map((x) => x.ruleId)).toEqual(['b']);
    expect(new Set(out.candidates.map((c) => c.id)).size).toBe(2);
    // The displayed rule and range of the merged candidate are the preferred tool's.
    expect(out.candidates[0]).toMatchObject({
      tool: 'semgrep',
      ruleId: 'wide',
      range: { startLine: 1, endLine: 100 },
      toolAgreement: 2,
    });
  });

  it('falls back to a search by id when the rule index is stale', () => {
    const doc = sarif(
      [
        { ...sqlResult('/src/a.js'), ruleIndex: 5 },
        { ...sqlResult('/src/b.js'), ruleIndex: 0 },
      ],
      [{ id: 'other' }, ...sqlRule],
    );
    const out = normalizeReports([{ tool: 'semgrep', doc }]);
    expect(out.candidates.map((c) => c.file)).toEqual(['a.js', 'b.js']);
  });

  it('treats absent results as an empty run', () => {
    const doc = { version: '2.1.0', runs: [{ tool: { driver: {} } }] };
    expect(normalizeReports([{ tool: 'semgrep', doc }]).candidates).toEqual([]);
  });

  it('records the region of a skipped finding', () => {
    const doc = sarif([sqlResult('/src/a.js', { startLine: 4, endLine: 6 })], [{ id: 'r.sql' }]);
    const out = normalizeReports([{ tool: 'semgrep', doc }]);
    expect(out.skipped[0]).toMatchObject({ reason: 'unmapped-class', startLine: 4, endLine: 6 });
  });

  it('keeps disjoint ranges and files apart, and merges direct overlaps', () => {
    const doc = sarif(
      [
        sqlResult('/src/a.js', { startLine: 1, endLine: 3 }),
        sqlResult('/src/a.js', { startLine: 3, endLine: 6 }),
        sqlResult('/src/a.js', { startLine: 7, endLine: 8 }),
        sqlResult('/src/b.js', { startLine: 1, endLine: 3 }),
      ],
      sqlRule,
    );
    const { candidates } = normalizeReports([{ tool: 'semgrep', doc }]);
    expect(candidates.map((c) => `${c.file}:${c.range.startLine}`)).toEqual([
      'a.js:1',
      'a.js:7',
      'b.js:1',
    ]);
  });

  it('records the rules and packages that were merged into a candidate', () => {
    const out = normalizeReports(all);
    const sql = out.merged.find((m) => m.members.some((x) => x.ruleId === 'js/sql-injection'));
    expect(sql?.members.map((x) => `${x.tool}:${x.ruleId}`)).toEqual([
      'semgrep:affidavit.normalize.query-from-request',
      'semgrep:affidavit.normalize.sql-concat',
      'codeql:js/sql-injection',
    ]);
    expect(out.merged.map((m) => m.candidateId)).toEqual(out.candidates.map((c) => c.id));
  });

  it('puts every input finding in exactly one candidate or in skipped (randomised)', () => {
    let seed = 12345;
    const rand = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed % n;
    };
    const files = ['/src/a.js', '/src/b.js', '/etc/x.js'];
    const tags = [['CWE-89'], ['CWE-639'], ['CWE-79'], []];
    for (let round = 0; round < 200; round++) {
      const docs: ReportInput[] = [];
      let expected = 0;
      for (const tool of ['semgrep', 'codeql'] as const) {
        const rules = tags.map((t, i) => ({ id: `r${i}`, properties: { tags: t } }));
        const results = Array.from({ length: rand(25) }, () => {
          const start = 1 + rand(30);
          return {
            ruleId: `r${rand(4)}`,
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: files[rand(3)] },
                  region: { startLine: start, endLine: start + rand(12) },
                },
              },
            ],
          };
        });
        expected += results.length;
        docs.push({ tool, doc: sarif(results, rules) });
      }
      const out = normalizeReports(docs);
      const members = out.merged.reduce((n, m) => n + m.members.length, 0);
      expect(members + out.skipped.length).toBe(expected);
      for (const m of out.merged) expect(m.members.length).toBeGreaterThan(0);
      expect(new Set(out.candidates.map((c) => c.id)).size).toBe(out.candidates.length);
      // Members of one candidate all share a line with each other, not just with a primary.
      for (const m of out.merged) {
        for (const a of m.members) {
          for (const b of m.members) {
            expect(a.startLine <= b.endLine && b.startLine <= a.endLine).toBe(true);
          }
        }
      }
      // The same findings in the other order give the same answer.
      expect(normalizeReports([...docs].reverse())).toEqual(out);
    }
  });

  it('resolves the rule through ruleIndex and rule.id', () => {
    const doc = sarif(
      [
        { ruleIndex: 0, locations: sqlResult('/src/a.js').locations },
        { rule: { id: 'r.sql' }, locations: sqlResult('/src/c.js').locations },
      ],
      sqlRule,
    );
    const { candidates } = normalizeReports([{ tool: 'semgrep', doc }]);
    expect(candidates.map((c) => c.ruleId)).toEqual(['r.sql', 'r.sql']);
  });

  it('returns nothing for an empty but valid report', () => {
    expect(normalizeReports([{ tool: 'semgrep', doc: sarif([]) }]).candidates).toEqual([]);
    expect(normalizeReports([{ tool: 'osv', doc: { results: [] } }]).candidates).toEqual([]);
    expect(normalizeReports([]).candidates).toEqual([]);
  });
});

describe('malformed reports are rejected with a typed error', () => {
  const bad: [string, ReportInput, MalformedCode][] = [
    ['null', { tool: 'semgrep', doc: null }, 'wrong-type'],
    ['a string', { tool: 'codeql', doc: 'x' }, 'wrong-type'],
    ['an array', { tool: 'semgrep', doc: [] }, 'wrong-type'],
    ['an osv array', { tool: 'osv', doc: [] }, 'wrong-type'],
    ['no version', { tool: 'semgrep', doc: { runs: [] } }, 'wrong-version'],
    ['version 2.0.0', { tool: 'semgrep', doc: { version: '2.0.0', runs: [] } }, 'wrong-version'],
    ['no runs', { tool: 'semgrep', doc: { version: '2.1.0' } }, 'wrong-type'],
    ['runs not an array', { tool: 'semgrep', doc: { version: '2.1.0', runs: {} } }, 'wrong-type'],
    ['run not an object', { tool: 'semgrep', doc: { version: '2.1.0', runs: [1] } }, 'wrong-type'],
    [
      'no tool',
      { tool: 'semgrep', doc: { version: '2.1.0', runs: [{ results: [] }] } },
      'wrong-type',
    ],
    [
      'results null',
      {
        tool: 'semgrep',
        doc: { version: '2.1.0', runs: [{ tool: { driver: {} }, results: null }] },
      },
      'wrong-type',
    ],
    ['results not an array', { tool: 'semgrep', doc: sarif('x') }, 'wrong-type'],
    ['result not an object', { tool: 'semgrep', doc: sarif([null]) }, 'wrong-type'],
    ['result without a rule id', { tool: 'semgrep', doc: sarif([{ locations: [] }]) }, 'bad-rule'],
    ['ruleId not a string', { tool: 'semgrep', doc: sarif([{ ruleId: 5 }]) }, 'wrong-type'],
    ['ruleId with a newline', { tool: 'semgrep', doc: sarif([{ ruleId: 'a\nb' }]) }, 'bad-string'],
    [
      'negative ruleIndex',
      { tool: 'semgrep', doc: sarif([{ ruleIndex: -5, ruleId: 'x' }], sqlRule) },
      'bad-rule',
    ],
    ['rules not an array', { tool: 'semgrep', doc: sarif([], 'x') }, 'wrong-type'],
    [
      'startLine zero',
      { tool: 'semgrep', doc: sarif([sqlResult('/src/a.js', { startLine: 0 })], sqlRule) },
      'bad-region',
    ],
    [
      'startLine a string',
      { tool: 'semgrep', doc: sarif([sqlResult('/src/a.js', { startLine: '5' })], sqlRule) },
      'bad-region',
    ],
    [
      'startLine fractional',
      { tool: 'semgrep', doc: sarif([sqlResult('/src/a.js', { startLine: 1.5 })], sqlRule) },
      'bad-region',
    ],
    [
      'endLine before startLine',
      {
        tool: 'semgrep',
        doc: sarif([sqlResult('/src/a.js', { startLine: 5, endLine: 4 })], sqlRule),
      },
      'bad-region',
    ],
    ['osv without results', { tool: 'osv', doc: {} }, 'wrong-type'],
    ['osv result without source', { tool: 'osv', doc: { results: [{}] } }, 'wrong-type'],
    [
      'osv vuln without id',
      {
        tool: 'osv',
        doc: {
          results: [
            { source: { path: '/src/x' }, packages: [{ package: {}, vulnerabilities: [{}] }] },
          ],
        },
      },
      'wrong-type',
    ],
    [
      'osv cwe_ids not an array',
      {
        tool: 'osv',
        doc: {
          results: [
            {
              source: { path: '/src/x' },
              packages: [
                {
                  package: {},
                  vulnerabilities: [{ id: 'A', database_specific: { cwe_ids: 'CWE-89' } }],
                },
              ],
            },
          ],
        },
      },
      'wrong-type',
    ],
  ];
  it.each(bad)('rejects %s', (_name, input, code) => {
    expectMalformed([input], code);
  });

  it('rejects an oversized result list and over-long strings', () => {
    const many = Array.from({ length: NORMALIZE_LIMITS.results + 1 }, () => ({}));
    expectMalformed([{ tool: 'semgrep', doc: sarif(many) }], 'too-many');
    expectMalformed(
      [{ tool: 'semgrep', doc: sarif([{ ruleId: 'x'.repeat(NORMALIZE_LIMITS.ruleId + 1) }]) }],
      'too-large',
    );
  });

  it('names the tool and where in the report', () => {
    const e = expectMalformed([{ tool: 'codeql', doc: sarif([null]) }]);
    expect(e.tool).toBe('codeql');
    expect(e.pointer).toBe('/runs/0/results/0');
  });

  it('survives hostile shapes without throwing anything else', () => {
    const hostile: unknown[] = [
      JSON.parse('{"__proto__":{"runs":[]},"version":"2.1.0"}'),
      JSON.parse(
        '{"version":"2.1.0","runs":[{"tool":{"driver":{"rules":[{"id":"__proto__"}]}},"results":[{"ruleId":"__proto__"}]}]}',
      ),
      { version: '2.1.0', runs: [{ tool: { driver: { rules: [null] } }, results: [] }] },
      { version: '2.1.0', runs: Array.from({ length: 100 }, () => ({})) },
    ];
    for (const doc of hostile) {
      for (const tool of ['semgrep', 'codeql'] as const) {
        try {
          normalizeReports([{ tool, doc }]);
        } catch (e) {
          expect(e).toBeInstanceOf(MalformedReportError);
        }
      }
    }
  });
});

describe('paths', () => {
  const sg = (uri: unknown) =>
    normalizeReports([{ tool: 'semgrep', doc: sarif([sqlResult(uri)], sqlRule) }]);
  const cq = (uri: unknown) =>
    normalizeReports([{ tool: 'codeql', doc: sarif([sqlResult(uri)], sqlRule) }]);

  it('strips /src/ and accepts repo-relative paths', () => {
    expect(sg('/src/app/db.js').candidates[0]?.file).toBe('app/db.js');
    expect(sg('app/db.js').candidates[0]?.file).toBe('app/db.js');
  });

  it('keeps Semgrep file names exactly as written, never URI-decoding them', () => {
    for (const name of ['100%.js', 'a%20b.js', 'a#b?.js', 'a\\b.js', 'é.js', '%2e%2e/x.js']) {
      const out = sg(`/src/${name}`);
      expect(out.skipped).toEqual([]);
      expect(out.candidates[0]?.file).toBe(name);
    }
  });

  it('decodes CodeQL URIs once', () => {
    expect(cq('src/my%20dir/a.js').candidates[0]?.file).toBe('src/my dir/a.js');
    // %2541 decodes to %41, and the result is not decoded again.
    expect(cq('src/%2541.js').candidates[0]?.file).toBe('src/%41.js');
  });

  const unsafe: [string, string][] = [
    ['semgrep', '/etc/passwd'],
    ['semgrep', '/srcx/a.js'],
    ['semgrep', '/src'],
    ['semgrep', '/src/'],
    ['semgrep', '/src/../etc/passwd'],
    ['semgrep', '/src/a\\..\\b.js'],
    ['semgrep', '\\\\host\\share\\x.js'],
    ['codeql', '\\\\host\\share\\x.js'],
    ['semgrep', '../a.js'],
    ['semgrep', 'a/../../b.js'],
    ['semgrep', './a.js'],
    ['semgrep', 'a//b.js'],
    ['semgrep', 'a/./b.js'],
    ['semgrep', 'file:///src/a.js'],
    ['semgrep', 'https://example.com/a.js'],
    ['semgrep', 'C:/src/a.js'],
    ['semgrep', '/src/a\nb.js'],
    ['codeql', '%2e%2e/a.js'],
    ['codeql', 'a/%2E%2e/b.js'],
    ['codeql', '%2fetc/passwd'],
    ['codeql', 'bad%zz.js'],
    ['codeql', 'a%00b.js'],
    ['codeql', '%2e/a.js'],
  ];
  it.each(unsafe)('skips an unsafe %s path %j without failing the report', (tool, uri) => {
    const doc = sarif([sqlResult('/src/ok.js'), sqlResult(uri)], sqlRule);
    const out = normalizeReports([{ tool: tool as 'semgrep' | 'codeql', doc }]);
    expect(out.candidates.map((c) => c.file)).toEqual(['ok.js']);
    expect(out.skipped).toEqual([{ tool, ruleId: 'r.sql', reason: 'unsafe-path', cwe: [89] }]);
  });

  it('still fails the report for a non-string uri', () => {
    expectMalformed([{ tool: 'semgrep', doc: sarif([sqlResult(5)], sqlRule) }], 'wrong-type');
  });

  it('skips an unsafe lockfile path in OSV output', () => {
    const doc = {
      results: [
        {
          source: { path: '/etc/shadow' },
          packages: [
            {
              package: { name: 'p', version: '1' },
              vulnerabilities: [{ id: 'A', database_specific: { cwe_ids: ['CWE-89'] } }],
            },
          ],
        },
      ],
    };
    const out = normalizeReports([{ tool: 'osv', doc }]);
    expect(out.candidates).toEqual([]);
    expect(out.skipped).toEqual([{ tool: 'osv', ruleId: 'A', reason: 'unsafe-path', cwe: [89] }]);
  });

  it('uses a later location when the first has no uri', () => {
    const doc = sarif(
      [
        {
          ruleId: 'r.sql',
          locations: [
            { message: { text: 'x' } },
            {
              physicalLocation: {
                artifactLocation: { uri: '/src/b.js' },
                region: { startLine: 2 },
              },
            },
          ],
        },
      ],
      sqlRule,
    );
    expect(normalizeReports([{ tool: 'semgrep', doc }]).candidates[0]?.file).toBe('b.js');
  });
});

describe('recorded odd file names from the pinned Semgrep image', () => {
  it('yields a candidate for every odd name, with the exact file name', () => {
    const files = normalizeReports([semgrep]).candidates.map((c) => c.file);
    for (const name of ['src/100%.js', 'src/a%20b.js', 'src/a#b.js', 'src/é.js']) {
      expect(files).toContain(name);
    }
  });
});

describe('CodeQL rule references', () => {
  const ext = (rules: unknown[]) => ({
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: { name: 'CodeQL' },
          extensions: [
            { name: 'q1', rules: [] },
            { name: 'q2', rules },
          ],
        },
        results: [
          {
            rule: { id: 'js/sql-injection', index: 0, toolComponent: { name: 'q2', index: 1 } },
            locations: sqlResult('src/a.js').locations,
          },
        ],
      },
    ],
  });

  it('resolves rules in tool.extensions by toolComponent', () => {
    const out = normalizeReports([
      {
        tool: 'codeql',
        doc: ext([{ id: 'js/sql-injection', properties: { tags: ['external/cwe/cwe-089'] } }]),
      },
    ]);
    expect(out.candidates.map((c) => c.ruleId)).toEqual(['js/sql-injection']);
  });

  it('rejects a toolComponent index with no such extension', () => {
    const doc = ext([]);
    (
      doc.runs[0]?.results[0] as { rule: { toolComponent: { index: number } } }
    ).rule.toolComponent.index = 9;
    expectMalformed([{ tool: 'codeql', doc }], 'bad-rule');
  });
});

describe('OSV aliases and packages', () => {
  const pkg = (name: string, ids: string[], groups: string[][], cwe = ['CWE-89']) => ({
    package: { name, version: '1.0.0', ecosystem: 'npm' },
    vulnerabilities: ids.map((id) => ({ id, database_specific: { cwe_ids: cwe } })),
    groups: groups.map((g) => ({ ids: g, aliases: g })),
  });
  const lock = (packages: unknown[]) => ({
    results: [{ source: { path: '/src/package-lock.json', type: 'lockfile' }, packages }],
  });

  it('collapses a GHSA id and its CVE alias on one package into one candidate', () => {
    const out = normalizeReports([
      { tool: 'osv', doc: lock([pkg('p', ['GHSA-1', 'CVE-1'], [['CVE-1', 'GHSA-1']])]) },
    ]);
    expect(out.candidates.map((c) => c.ruleId)).toEqual(['CVE-1']);
    expect(out.merged[0]?.members).toHaveLength(1);
  });

  it('takes the CWEs of every id in the group', () => {
    const doc = lock([
      {
        package: { name: 'p', version: '1' },
        vulnerabilities: [
          { id: 'A', database_specific: { cwe_ids: [] } },
          { id: 'B', database_specific: { cwe_ids: ['CWE-639'] } },
        ],
        groups: [{ ids: ['A', 'B'] }],
      },
    ]);
    const out = normalizeReports([{ tool: 'osv', doc }]);
    expect(out.candidates.map((c) => [c.ruleId, c.cls])).toEqual([['A', 'idor']]);
  });

  it('keeps ungrouped vulnerabilities apart', () => {
    const out = normalizeReports([{ tool: 'osv', doc: lock([pkg('p', ['A', 'B'], [])]) }]);
    expect(out.candidates.map((c) => c.ruleId).sort()).toEqual(['A', 'B']);
  });

  it('collapses a GHSA id on one package and its CVE alias on another in one lockfile', () => {
    const out = normalizeReports([
      {
        tool: 'osv',
        doc: lock([pkg('p', ['GHSA-1'], [['GHSA-1', 'CVE-1']]), pkg('q', ['CVE-1'], [['CVE-1']])]),
      },
    ]);
    expect(out.candidates.map((c) => c.ruleId)).toEqual(['CVE-1']);
    expect(out.merged[0]?.members.map((m) => m.package?.name)).toEqual(['p', 'q']);
  });

  it('records both packages when one advisory hits two packages in one lockfile', () => {
    const out = normalizeReports([
      { tool: 'osv', doc: lock([pkg('p', ['A'], [['A']]), pkg('q', ['A'], [['A']])]) },
    ]);
    expect(out.candidates).toHaveLength(1);
    expect(out.merged[0]?.members.map((m) => m.package?.name)).toEqual(['p', 'q']);
  });
});

describe('limits and error attribution', () => {
  it('keeps a long tag instead of dropping it', () => {
    const rules = [{ id: 'r.sql', properties: { tags: [`CWE-89: ${'x'.repeat(3_000)}`] } }];
    expect(
      normalizeReports([{ tool: 'semgrep', doc: sarif([sqlResult('/src/a.js')], rules) }])
        .candidates,
    ).toHaveLength(1);
  });

  it('attributes a failure to the report that caused it', () => {
    const e = expectMalformed([semgrep, { tool: 'codeql', doc: { version: '2.1.0' } }]);
    expect(e.tool).toBe('codeql');
    const o = expectMalformed([semgrep, codeql, { tool: 'osv', doc: [] }]);
    expect(o.tool).toBe('osv');
  });
});
describe('class mapping', () => {
  it('reads CWE numbers from the tag spellings the tools use', () => {
    expect(cweNumber('CWE-89: Improper Neutralization')).toBe(89);
    expect(cweNumber('external/cwe/cwe-089')).toBe(89);
    expect(cweNumber('CWE_943')).toBe(943);
    expect(cweNumber('security')).toBeUndefined();
    expect(cweNumber('xcwe-89')).toBeUndefined();
    expect(cweNumber('CWE-123456')).toBeUndefined();
    expect(cweNumbers(['CWE-89', 'external/cwe/cwe-089', 'CWE-639'])).toEqual([89, 639]);
  });

  it('maps injection and IDOR, and prefers injection when both appear', () => {
    expect(classOf([89])).toBe('injection');
    expect(classOf([639])).toBe('idor');
    expect(classOf([639, 89])).toBe('injection');
    expect(classOf([79])).toBeUndefined();
    expect(classOf([])).toBeUndefined();
    for (const n of INJECTION_CWES) expect(IDOR_CWES.has(n)).toBe(false);
  });

  it('skips a result with no CWE tag and records why', () => {
    const doc = sarif([sqlResult('/src/a.js')], [{ id: 'r.sql' }]);
    const out = normalizeReports([{ tool: 'semgrep', doc }]);
    expect(out.candidates).toEqual([]);
    expect(out.skipped).toEqual([
      {
        tool: 'semgrep',
        ruleId: 'r.sql',
        reason: 'unmapped-class',
        file: 'a.js',
        startLine: 5,
        endLine: 5,
        cwe: [],
      },
    ]);
  });

  it('skips a result with no location or region and records why', () => {
    const doc = sarif(
      [{ ruleId: 'r.sql' }, { ruleId: 'r.sql', locations: sqlResult('/src/a.js', {}).locations }],
      sqlRule,
    );
    const out = normalizeReports([{ tool: 'semgrep', doc }]);
    expect(out.skipped.map((s) => s.reason)).toEqual(['no-location', 'no-region']);
  });
});

describe('readToolRunReports', () => {
  const run = (over: Partial<ToolRunResult>): ToolRunResult => ({
    name: 'semgrep',
    exitCode: 0,
    empty: false,
    partial: false,
    notifications: [],
    binaryMediaFiles: [],
    windowedFiles: [],
    binaryFontFiles: [],
    windowProvenFiles: [],
    outputPath: '',
    outputFile: '',
    reports: [],
    quarantined: [],
    ...over,
  });

  it('reads the report files of a run and carries the partial flag', async () => {
    const dir = tmp();
    put(dir, 'semgrep.sarif', JSON.stringify(sarif([sqlResult('/src/a.js')], sqlRule)));
    const inputs = await readToolRunReports(
      run({ partial: true, reports: [{ file: join(dir, 'semgrep.sarif'), origin: 'snapshot' }] }),
    );
    expect(inputs).toHaveLength(1);
    const out = normalizeReports(inputs);
    expect(out.candidates).toHaveLength(1);
    expect(out.partialTools).toEqual(['semgrep']);
  });

  it('maps osv-scanner runs to the osv tool and an empty run to nothing', async () => {
    const dir = tmp();
    put(dir, 'o.json', JSON.stringify({ results: [] }));
    const [one] = await readToolRunReports(
      run({ name: 'osv-scanner', reports: [{ file: join(dir, 'o.json'), origin: 'snapshot' }] }),
    );
    expect(one?.tool).toBe('osv');
    expect(await readToolRunReports(run({ name: 'osv-scanner', empty: true }))).toEqual([]);
  });

  it('maps codeql to its own format and rejects unknown tool names', async () => {
    const dir = tmp();
    put(dir, 'c.sarif', JSON.stringify(sarif([])));
    const [one] = await readToolRunReports(
      run({ name: 'codeql', reports: [{ file: join(dir, 'c.sarif'), origin: 'snapshot' }] }),
    );
    expect(one?.tool).toBe('codeql');
    const err: unknown = await readToolRunReports(
      run({ name: 'mystery' as ToolRunResult['name'] }),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MalformedReportError);
    expect((err as MalformedReportError).code).toBe('unsupported-tool');
  });

  it('rejects gitleaks, bad JSON, missing, oversize and non-regular files', async () => {
    const dir = tmp();
    put(dir, 'bad.json', '{"version": "2.1.0", "runs": [');
    put(dir, 'big.json', JSON.stringify(sarif([])));
    const reject = async (r: ToolRunResult, max?: number) => {
      const err: unknown = await readToolRunReports(r, max ? { maxReportBytes: max } : {}).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(MalformedReportError);
      return (err as MalformedReportError).code;
    };
    expect(await reject(run({ name: 'gitleaks' }))).toBe('unsupported-tool');
    expect(
      await reject(run({ reports: [{ file: join(dir, 'bad.json'), origin: 'snapshot' }] })),
    ).toBe('invalid-json');
    expect(
      await reject(run({ reports: [{ file: join(dir, 'nope.json'), origin: 'snapshot' }] })),
    ).toBe('unreadable');
    expect(await reject(run({ reports: [{ file: dir, origin: 'snapshot' }] }))).toBe('unreadable');
    expect(
      await reject(run({ reports: [{ file: join(dir, 'big.json'), origin: 'snapshot' }] }), 10),
    ).toBe('too-large');
  });
});
