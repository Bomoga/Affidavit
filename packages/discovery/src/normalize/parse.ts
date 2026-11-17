import type { VulnClass } from '@affidavit/contracts';
import { classOf, cweNumbers } from './classify.js';
import {
  Guard,
  LIMITS,
  isObj,
  own,
  repoRelativePath,
  type Obj,
  type SourceTool,
} from './guards.js';

/** One finding from one tool, before deduplication. */
export interface RawFinding {
  tool: SourceTool;
  ruleId: string;
  cls: VulnClass;
  /** Repo-relative path, no `/src/` prefix. */
  file: string;
  startLine: number;
  endLine: number;
}

export type SkipReason = 'unmapped-class' | 'no-location' | 'no-region';

/** A finding that was read but not turned into a Candidate. Surfaced, never silently dropped. */
export interface SkippedFinding {
  tool: SourceTool;
  ruleId: string;
  reason: SkipReason;
  file?: string;
  /** CWE numbers the tool attached, sorted. Empty when it attached none. */
  cwe: number[];
}

export interface Parsed {
  findings: RawFinding[];
  skipped: SkippedFinding[];
}

function tagStrings(g: Guard, v: unknown, pointer: string): string[] {
  const list = g.optArr(v, pointer, LIMITS.tags);
  return list.filter((t): t is string => typeof t === 'string' && t.length <= 256);
}

function propsTags(g: Guard, holder: Obj, pointer: string): string[] {
  const props = own(holder, 'properties');
  if (props === undefined) return [];
  return tagStrings(
    g,
    own(g.obj(props, `${pointer}/properties`), 'tags'),
    `${pointer}/properties/tags`,
  );
}

/**
 * Parses a SARIF 2.1.0 document from Semgrep or CodeQL. Structure errors and unsafe paths throw
 * MalformedReportError. A result with no usable location, or outside the MVP classes, is returned
 * in `skipped`. Result messages, snippets and suppressions are never read: a repo's own comments
 * (for example `nosemgrep`) cannot hide a finding.
 */
export function parseSarif(tool: 'semgrep' | 'codeql', doc: unknown): Parsed {
  const g: Guard = new Guard(tool);
  const root = g.obj(doc, '');
  if (own(root, 'version') !== '2.1.0') g.fail('wrong-version', '/version', 'expected "2.1.0"');
  const runs = g.arr(own(root, 'runs'), '/runs', LIMITS.runs);
  const findings: RawFinding[] = [];
  const skipped: SkippedFinding[] = [];
  let total = 0;

  runs.forEach((runRaw, ri) => {
    const rp = `/runs/${ri}`;
    const run = g.obj(runRaw, rp);
    const driver = g.obj(own(g.obj(own(run, 'tool'), `${rp}/tool`), 'driver'), `${rp}/tool/driver`);
    const rulesRaw = g.optArr(own(driver, 'rules'), `${rp}/tool/driver/rules`, LIMITS.rules);
    const ruleTags: string[][] = [];
    const ruleIndexById = new Map<string, number>();
    const ruleIdByIndex: (string | undefined)[] = [];
    rulesRaw.forEach((r, i) => {
      const pp = `${rp}/tool/driver/rules/${i}`;
      const rule = g.obj(r, pp);
      const id = own(rule, 'id');
      const s = id === undefined ? undefined : g.str(id, `${pp}/id`, LIMITS.ruleId);
      ruleIdByIndex.push(s);
      if (s !== undefined && !ruleIndexById.has(s)) ruleIndexById.set(s, i);
      ruleTags.push(propsTags(g, rule, pp));
    });

    const results = g.arr(own(run, 'results'), `${rp}/results`, LIMITS.results);
    results.forEach((resRaw, i) => {
      const pp = `${rp}/results/${i}`;
      total += 1;
      if (total > LIMITS.results) g.fail('too-many', pp, 'too many results across runs');
      const res = g.obj(resRaw, pp);

      let ruleIndex: number | undefined;
      const ri2 = own(res, 'ruleIndex');
      if (ri2 !== undefined && ri2 !== -1) {
        if (typeof ri2 !== 'number' || !Number.isSafeInteger(ri2) || ri2 < 0) {
          g.fail('bad-rule', `${pp}/ruleIndex`, 'expected a non-negative integer');
        }
        if (rulesRaw.length > 0 && ri2 >= rulesRaw.length) {
          g.fail('bad-rule', `${pp}/ruleIndex`, 'index outside the rules array');
        }
        ruleIndex = rulesRaw.length > 0 ? ri2 : undefined;
      }
      let ruleId: string | undefined;
      const rid = own(res, 'ruleId');
      if (rid !== undefined) ruleId = g.str(rid, `${pp}/ruleId`, LIMITS.ruleId);
      else {
        const ref = own(res, 'rule');
        if (ref !== undefined) {
          const id = own(g.obj(ref, `${pp}/rule`), 'id');
          if (id !== undefined) ruleId = g.str(id, `${pp}/rule/id`, LIMITS.ruleId);
        }
      }
      if (ruleId === undefined && ruleIndex !== undefined) ruleId = ruleIdByIndex[ruleIndex];
      if (ruleId === undefined) g.fail('bad-rule', pp, 'result has no rule id');
      ruleIndex ??= ruleIndexById.get(ruleId);

      const tags = [
        ...(ruleIndex === undefined ? [] : (ruleTags[ruleIndex] ?? [])),
        ...propsTags(g, res, pp),
      ];
      const cwe = cweNumbers(tags);

      const locs = g.optArr(own(res, 'locations'), `${pp}/locations`, 1_000);
      const first = locs[0];
      const phys = isObj(first) ? own(first, 'physicalLocation') : undefined;
      const art = isObj(phys) ? own(phys, 'artifactLocation') : undefined;
      const uri = isObj(art) ? own(art, 'uri') : undefined;
      if (uri === undefined) {
        skipped.push({ tool, ruleId, reason: 'no-location', cwe });
        return;
      }
      const lp = `${pp}/locations/0/physicalLocation`;
      const file = repoRelativePath(g, uri, `${lp}/artifactLocation/uri`);
      const region = own(phys as Obj, 'region');
      const startRaw = isObj(region) ? own(region, 'startLine') : undefined;
      if (startRaw === undefined) {
        skipped.push({ tool, ruleId, reason: 'no-region', file, cwe });
        return;
      }
      const startLine = g.line(startRaw, `${lp}/region/startLine`);
      const endRaw = own(region as Obj, 'endLine');
      const endLine = endRaw === undefined ? startLine : g.line(endRaw, `${lp}/region/endLine`);
      if (endLine < startLine) g.fail('bad-region', `${lp}/region`, 'endLine before startLine');

      const cls = classOf(cwe);
      if (cls === undefined) {
        skipped.push({ tool, ruleId, reason: 'unmapped-class', file, cwe });
        return;
      }
      findings.push({ tool, ruleId, cls, file, startLine, endLine });
    });
  });
  return { findings, skipped };
}

/**
 * Parses OSV-Scanner `--format json`. The report has no line numbers, so a finding is located at
 * line 1 of its lockfile. The class comes from `database_specific.cwe_ids`; an advisory without a
 * CWE in the MVP classes is returned in `skipped`.
 */
export function parseOsv(doc: unknown): Parsed {
  const g: Guard = new Guard('osv');
  const root = g.obj(doc, '');
  const results = g.arr(own(root, 'results'), '/results', LIMITS.osvResults);
  const findings: RawFinding[] = [];
  const skipped: SkippedFinding[] = [];
  let pkgTotal = 0;
  let vulnTotal = 0;

  results.forEach((rRaw, ri) => {
    const rp = `/results/${ri}`;
    const r = g.obj(rRaw, rp);
    const source = g.obj(own(r, 'source'), `${rp}/source`);
    const file = repoRelativePath(g, own(source, 'path'), `${rp}/source/path`);
    const pkgs = g.optArr(own(r, 'packages'), `${rp}/packages`, LIMITS.osvPackages);
    pkgTotal += pkgs.length;
    if (pkgTotal > LIMITS.osvPackages) g.fail('too-many', `${rp}/packages`, 'too many packages');
    pkgs.forEach((pRaw, pi) => {
      const pp = `${rp}/packages/${pi}`;
      const p = g.obj(pRaw, pp);
      g.obj(own(p, 'package'), `${pp}/package`);
      const vulns = g.optArr(own(p, 'vulnerabilities'), `${pp}/vulnerabilities`, LIMITS.osvVulns);
      vulnTotal += vulns.length;
      if (vulnTotal > LIMITS.osvVulns) g.fail('too-many', `${pp}/vulnerabilities`, 'too many');
      vulns.forEach((vRaw, vi) => {
        const vp = `${pp}/vulnerabilities/${vi}`;
        const v = g.obj(vRaw, vp);
        const ruleId = g.str(own(v, 'id'), `${vp}/id`, LIMITS.ruleId);
        const ds = own(v, 'database_specific');
        const ids = isObj(ds) ? own(ds, 'cwe_ids') : undefined;
        const cwe = cweNumbers(
          ids === undefined
            ? []
            : g
                .arr(ids, `${vp}/database_specific/cwe_ids`, LIMITS.osvCwe)
                .filter((t): t is string => typeof t === 'string' && t.length <= 256),
        );
        const cls = classOf(cwe);
        if (cls === undefined) {
          skipped.push({ tool: 'osv', ruleId, reason: 'unmapped-class', file, cwe });
          return;
        }
        findings.push({ tool: 'osv', ruleId, cls, file, startLine: 1, endLine: 1 });
      });
    });
  });
  return { findings, skipped };
}
