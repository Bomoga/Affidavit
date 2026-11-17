// Follow-ups from the L1-03 review: skipped tie-break, colons in ids, original OSV ids, and the
// maxReportBytes check. Kept apart from normalize.test.ts.
import { describe, expect, it } from 'vitest';
import type { ToolRunResult } from '../tools/index.js';
import { normalizeReports, readToolRunReports, type ReportInput } from './index.js';

const result = (ruleId: string, startLine: number, uri = '/src/a.js') => ({
  ruleId,
  locations: [
    {
      physicalLocation: {
        artifactLocation: { uri },
        region: { startLine, endLine: startLine },
      },
    },
  ],
});

const sarif = (results: unknown[], rules: unknown[] = []) => ({
  version: '2.1.0',
  runs: [{ tool: { driver: { name: 'x', rules } }, results }],
});

describe('skipped order', () => {
  it('breaks ties on lines and CWEs, so input order never shows in the output', () => {
    // Same tool, file, rule and reason; only the region (and CWE tags) differ.
    const rules = [{ id: 'r.x', properties: { tags: ['CWE-79'] } }];
    const results = [result('r.x', 30), result('r.x', 4), result('r.x', 17)];
    const forward = normalizeReports([{ tool: 'semgrep', doc: sarif(results, rules) }]);
    const backward = normalizeReports([
      { tool: 'semgrep', doc: sarif([...results].reverse(), rules) },
    ]);
    expect(forward.skipped.map((s) => s.startLine)).toEqual([4, 17, 30]);
    expect(backward.skipped).toEqual(forward.skipped);
  });

  it('breaks a tie between two CWE sets on the CWE list', () => {
    const rules = [
      { id: 'r.a', properties: { tags: ['CWE-79'] } },
      { id: 'r.b', properties: { tags: ['CWE-22'] } },
    ];
    const a = { tool: 'semgrep', doc: sarif([result('r.a', 1)], rules) } as const;
    const b = { tool: 'semgrep', doc: sarif([result('r.b', 1)], rules) } as const;
    // Different rule ids, so the rule id decides; same rule id with different tags is impossible in
    // one run, but two reports can disagree.
    const rulesB = [{ id: 'r.a', properties: { tags: ['CWE-22'] } }];
    const c = { tool: 'semgrep', doc: sarif([result('r.a', 1)], rulesB) } as const;
    const one = normalizeReports([a, b, c]).skipped;
    const two = normalizeReports([c, b, a]).skipped;
    expect(two).toEqual(one);
    expect(one.filter((s) => s.ruleId === 'r.a').map((s) => s.cwe)).toEqual([[22], [79]]);
  });
});

describe('colons in rule names', () => {
  const rules = [
    { id: 'js/a:b', properties: { tags: ['CWE-89'] } },
    { id: 'js/a', properties: { tags: ['CWE-89'] } },
    { id: 'js/a:b:c', properties: { tags: ['CWE-639'] } },
  ];

  it('keeps rule ids that contain colons intact and distinct in candidates and merged records', () => {
    const doc = sarif([result('js/a:b', 5), result('js/a', 5), result('js/a:b:c', 20)], rules);
    const out = normalizeReports([{ tool: 'codeql', doc }]);
    expect(out.candidates).toHaveLength(2);
    expect(new Set(out.candidates.map((c) => c.id)).size).toBe(2);
    const members = out.merged.flatMap((m) => m.members.map((x) => x.ruleId)).sort();
    expect(members).toEqual(['js/a', 'js/a:b', 'js/a:b:c']);
  });

  it('does not merge OSV advisories whose ids differ only around a colon', () => {
    const pkg = (id: string) => ({
      package: { name: 'p', version: '1' },
      vulnerabilities: [{ id, database_specific: { cwe_ids: ['CWE-89'] } }],
      groups: [{ ids: [id] }],
    });
    const doc = {
      results: [
        { source: { path: '/src/package-lock.json' }, packages: [pkg('A:B'), pkg('A'), pkg('B')] },
      ],
    };
    const out = normalizeReports([{ tool: 'osv', doc }]);
    expect(out.candidates.map((c) => c.ruleId).sort()).toEqual(['A', 'A:B', 'B']);
  });
});

describe('original OSV ids in the merged record', () => {
  const lock = (packages: unknown[]) => ({
    results: [{ source: { path: '/src/package-lock.json' }, packages }],
  });
  const vuln = (id: string) => ({ id, database_specific: { cwe_ids: ['CWE-89'] } });

  it('keeps the id each package reported, not only the group name', () => {
    const doc = lock([
      {
        package: { name: 'p', version: '1' },
        vulnerabilities: [vuln('GHSA-1')],
        groups: [{ ids: ['GHSA-1', 'CVE-1'] }],
      },
      {
        package: { name: 'q', version: '2' },
        vulnerabilities: [vuln('CVE-1')],
        groups: [{ ids: ['CVE-1'] }],
      },
    ]);
    const out = normalizeReports([{ tool: 'osv', doc }]);
    expect(out.candidates.map((c) => c.ruleId)).toEqual(['CVE-1']);
    const byPackage: Record<string, string[] | undefined> = Object.fromEntries(
      (out.merged[0]?.members ?? []).map((m) => [m.package?.name ?? '', m.osvIds] as const),
    );
    // p reported only GHSA-1; q reported CVE-1, which is the group name, so nothing extra.
    expect(byPackage).toEqual({ p: ['GHSA-1'], q: undefined });
  });

  it('lists every alias a package reported, sorted', () => {
    const doc = lock([
      {
        package: { name: 'p', version: '1' },
        vulnerabilities: [vuln('GHSA-1'), vuln('CVE-1'), vuln('OSV-1')],
        groups: [{ ids: ['GHSA-1', 'CVE-1', 'OSV-1'] }],
      },
    ]);
    const out = normalizeReports([{ tool: 'osv', doc }]);
    expect(out.merged[0]?.members[0]?.osvIds).toEqual(['CVE-1', 'GHSA-1', 'OSV-1']);
  });
});

describe('maxReportBytes', () => {
  const run = { name: 'semgrep', reports: [] } as unknown as ToolRunResult;

  it.each([0, -1, 1.5, Number.NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 2])(
    'rejects %s with a RangeError before reading anything',
    async (max) => {
      await expect(readToolRunReports(run, { maxReportBytes: max })).rejects.toBeInstanceOf(
        RangeError,
      );
    },
  );

  it('accepts a positive integer', async () => {
    const inputs: ReportInput[] = await readToolRunReports(run, { maxReportBytes: 1 });
    expect(inputs).toEqual([]);
  });
});
