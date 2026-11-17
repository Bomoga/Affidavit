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

  it('merges chained overlaps and keeps disjoint ranges apart', () => {
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
      'results missing',
      { tool: 'semgrep', doc: { version: '2.1.0', runs: [{ tool: { driver: {} } }] } },
      'wrong-type',
    ],
    ['results not an array', { tool: 'semgrep', doc: sarif('x') }, 'wrong-type'],
    ['result not an object', { tool: 'semgrep', doc: sarif([null]) }, 'wrong-type'],
    ['result without a rule id', { tool: 'semgrep', doc: sarif([{ locations: [] }]) }, 'bad-rule'],
    ['ruleId not a string', { tool: 'semgrep', doc: sarif([{ ruleId: 5 }]) }, 'wrong-type'],
    ['ruleId with a newline', { tool: 'semgrep', doc: sarif([{ ruleId: 'a\nb' }]) }, 'bad-string'],
    [
      'bad ruleIndex',
      { tool: 'semgrep', doc: sarif([{ ruleIndex: 7, ruleId: 'x' }], sqlRule) },
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
  const run = (uri: unknown) =>
    normalizeReports([{ tool: 'semgrep', doc: sarif([sqlResult(uri)], sqlRule) }]).candidates;

  it('strips /src/ and accepts repo-relative paths', () => {
    expect(run('/src/app/db.js')[0]?.file).toBe('app/db.js');
    expect(run('app/db.js')[0]?.file).toBe('app/db.js');
    expect(run('/src/my%20dir/a.js')[0]?.file).toBe('my dir/a.js');
  });

  it.each([
    '/etc/passwd',
    '/srcx/a.js',
    '/src',
    '/src/',
    '/src/../etc/passwd',
    '../a.js',
    'a/../../b.js',
    './a.js',
    'a//b.js',
    'a/./b.js',
    '%2e%2e/a.js',
    'a/%2E%2e/b.js',
    '%2fetc/passwd',
    'file:///src/a.js',
    'https://example.com/a.js',
    'C:/src/a.js',
    'a\\b.js',
    '/src/a\\..\\b.js',
    '%5c..%5cb.js',
    'bad%zz.js',
    'a%00b.js',
  ])('rejects %j', (uri) => {
    expectMalformed([{ tool: 'semgrep', doc: sarif([sqlResult(uri)], sqlRule) }], 'unsafe-uri');
  });

  it('rejects a raw control character and a non-string uri', () => {
    expectMalformed(
      [{ tool: 'semgrep', doc: sarif([sqlResult('/src/a.js\n')], sqlRule) }],
      'bad-string',
    );
    expectMalformed([{ tool: 'semgrep', doc: sarif([sqlResult(5)], sqlRule) }], 'wrong-type');
  });

  it('rejects an unsafe lockfile path in OSV output', () => {
    const doc = { results: [{ source: { path: '/etc/shadow' }, packages: [] }] };
    expectMalformed([{ tool: 'osv', doc }], 'unsafe-uri');
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
      { tool: 'semgrep', ruleId: 'r.sql', reason: 'unmapped-class', file: 'a.js', cwe: [] },
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
