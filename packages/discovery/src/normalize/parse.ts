import type { VulnClass } from '@affidavit/contracts';
import { classOf, cweNumbers } from './classify.js';
import { Guard, LIMITS, isObj, own, safeRepoPath, type Obj, type SourceTool } from './guards.js';

/** One finding from one tool, before deduplication. */
export interface RawFinding {
  tool: SourceTool;
  ruleId: string;
  cls: VulnClass;
  /** Repo-relative path, no `/src/` prefix. */
  file: string;
  startLine: number;
  endLine: number;
  /** OSV only: the package the advisory applies to. */
  pkg?: { name: string; version: string };
}

export type SkipReason = 'unmapped-class' | 'no-location' | 'no-region' | 'unsafe-path';

/** A finding that was read but not turned into a Candidate. Surfaced, never silently dropped. */
export interface SkippedFinding {
  tool: SourceTool;
  ruleId: string;
  reason: SkipReason;
  /** Absent for `no-location` and `unsafe-path` (an unsafe path is never echoed). */
  file?: string;
  /** The region the tool reported, when one was read (`unmapped-class` from SARIF). */
  startLine?: number;
  endLine?: number;
  /** CWE numbers the tool attached, sorted. Empty when it attached none. */
  cwe: number[];
}

export interface Parsed {
  findings: RawFinding[];
  skipped: SkippedFinding[];
}

function tagStrings(g: Guard, v: unknown, pointer: string): string[] {
  const list = g.optArr(v, pointer, LIMITS.tags);
  // Tags are only read for CWE numbers. A non-string or over-long tag cannot name one.
  return list.filter((t): t is string => typeof t === 'string' && t.length <= LIMITS.string);
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

/** A SARIF tool component: the driver, or one of `tool.extensions` (CodeQL puts its rules there). */
interface Component {
  name: string | undefined;
  ids: (string | undefined)[];
  tags: string[][];
  byId: Map<string, number>;
}

function readComponent(
  g: Guard,
  raw: unknown,
  pointer: string,
  budget: { left: number },
): Component {
  const c = g.obj(raw, pointer);
  const name = own(c, 'name');
  const rules = g.optArr(own(c, 'rules'), `${pointer}/rules`, LIMITS.rules);
  budget.left -= rules.length;
  if (budget.left < 0) g.fail('too-many', `${pointer}/rules`, 'too many rules across components');
  const out: Component = {
    name: typeof name === 'string' ? name : undefined,
    ids: [],
    tags: [],
    byId: new Map(),
  };
  rules.forEach((r, i) => {
    const pp = `${pointer}/rules/${i}`;
    const rule = g.obj(r, pp);
    const id = own(rule, 'id');
    const s = id === undefined ? undefined : g.str(id, `${pp}/id`, LIMITS.ruleId);
    out.ids.push(s);
    if (s !== undefined && !out.byId.has(s)) out.byId.set(s, i);
    out.tags.push(propsTags(g, rule, pp));
  });
  return out;
}

function index(g: Guard, v: unknown, pointer: string): number | undefined {
  if (v === undefined || v === -1) return undefined;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    g.fail('bad-rule', pointer, 'expected a non-negative integer');
  }
  return v;
}

/**
 * Parses a SARIF 2.1.0 document from Semgrep or CodeQL. Structure errors throw
 * MalformedReportError. A result with an unsafe path, no usable location, or outside the MVP
 * classes is returned in `skipped`. Result messages, snippets and suppressions are never read: a
 * repo's own comments (for example `nosemgrep`) cannot hide a finding.
 *
 * Rules are looked up in the driver and in `tool.extensions`, because CodeQL lists its query rules
 * only in an extension and points at them with `result.rule.{id,index,toolComponent}`.
 */
export function parseSarif(tool: 'semgrep' | 'codeql', doc: unknown): Parsed {
  const g: Guard = new Guard(tool);
  const decode = tool === 'codeql';
  const root = g.obj(doc, '');
  if (own(root, 'version') !== '2.1.0') g.fail('wrong-version', '/version', 'expected "2.1.0"');
  const runs = g.arr(own(root, 'runs'), '/runs', LIMITS.runs);
  const findings: RawFinding[] = [];
  const skipped: SkippedFinding[] = [];
  let total = 0;

  runs.forEach((runRaw, ri) => {
    const rp = `/runs/${ri}`;
    const run = g.obj(runRaw, rp);
    const toolObj = g.obj(own(run, 'tool'), `${rp}/tool`);
    const budget = { left: LIMITS.rules };
    const components: Component[] = [
      readComponent(g, own(toolObj, 'driver'), `${rp}/tool/driver`, budget),
    ];
    g.optArr(own(toolObj, 'extensions'), `${rp}/tool/extensions`, 256).forEach((e, i) => {
      components.push(readComponent(g, e, `${rp}/tool/extensions/${i}`, budget));
    });

    // Absent `results` is an empty run; present but not an array (for example null) is an error.
    const results = g.optArr(own(run, 'results'), `${rp}/results`, LIMITS.results);
    results.forEach((resRaw, i) => {
      const pp = `${rp}/results/${i}`;
      total += 1;
      if (total > LIMITS.results) g.fail('too-many', pp, 'too many results across runs');
      const res = g.obj(resRaw, pp);

      const refRaw = own(res, 'rule');
      const ref = refRaw === undefined ? undefined : g.obj(refRaw, `${pp}/rule`);
      let component = components[0] as Component;
      if (ref !== undefined && own(ref, 'toolComponent') !== undefined) {
        const tc = g.obj(own(ref, 'toolComponent'), `${pp}/rule/toolComponent`);
        const tci = index(g, own(tc, 'index'), `${pp}/rule/toolComponent/index`);
        const tcn = own(tc, 'name');
        if (tci !== undefined) {
          const found = components[tci + 1];
          if (found === undefined)
            g.fail('bad-rule', `${pp}/rule/toolComponent/index`, 'no such extension');
          component = found;
        } else if (typeof tcn === 'string') {
          component = components.find((c, k) => k > 0 && c.name === tcn) ?? component;
        }
      }
      const ruleIndex =
        index(g, ref === undefined ? undefined : own(ref, 'index'), `${pp}/rule/index`) ??
        index(g, own(res, 'ruleIndex'), `${pp}/ruleIndex`);

      let ruleId: string | undefined;
      const rid = own(res, 'ruleId');
      if (rid !== undefined) ruleId = g.str(rid, `${pp}/ruleId`, LIMITS.ruleId);
      else if (ref !== undefined && own(ref, 'id') !== undefined) {
        ruleId = g.str(own(ref, 'id'), `${pp}/rule/id`, LIMITS.ruleId);
      }
      if (ruleId === undefined && ruleIndex !== undefined) ruleId = component.ids[ruleIndex];
      if (ruleId === undefined) g.fail('bad-rule', pp, 'result has no rule id');

      let ruleTags: string[] = [];
      // A stale index (missing slot, or a slot naming another rule) falls back to a search by id.
      let at =
        ruleIndex !== undefined && component.ids[ruleIndex] === ruleId ? ruleIndex : undefined;
      at ??= component.byId.get(ruleId);
      if (at !== undefined) ruleTags = component.tags[at] ?? [];
      else {
        for (const c of components) {
          const k = c.byId.get(ruleId);
          if (k !== undefined) {
            ruleTags = c.tags[k] ?? [];
            break;
          }
        }
      }
      const cwe = cweNumbers([...ruleTags, ...propsTags(g, res, pp)]);

      // The first location that names a file. Later ones are a fallback, not extra findings.
      const locs = g.optArr(own(res, 'locations'), `${pp}/locations`, 1_000);
      let phys: Obj | undefined;
      let uri: unknown;
      let lp = '';
      for (const [k, loc] of locs.entries()) {
        const p = isObj(loc) ? own(loc, 'physicalLocation') : undefined;
        const art = isObj(p) ? own(p, 'artifactLocation') : undefined;
        const u = isObj(art) ? own(art, 'uri') : undefined;
        if (u !== undefined) {
          phys = p as Obj;
          uri = u;
          lp = `${pp}/locations/${k}/physicalLocation`;
          break;
        }
      }
      if (phys === undefined) {
        skipped.push({ tool, ruleId, reason: 'no-location', cwe });
        return;
      }
      const path = safeRepoPath(g.raw(uri, `${lp}/artifactLocation/uri`), decode);
      if (!path.ok) {
        skipped.push({ tool, ruleId, reason: 'unsafe-path', cwe });
        return;
      }
      const file = path.path;
      const region = own(phys, 'region');
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
        skipped.push({ tool, ruleId, reason: 'unmapped-class', file, startLine, endLine, cwe });
        return;
      }
      findings.push({ tool, ruleId, cls, file, startLine, endLine });
    });
  });
  return { findings, skipped };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Parses OSV-Scanner `--format json`. The report has no line numbers, so a finding is located at
 * line 1 of its lockfile. The class comes from `database_specific.cwe_ids`; an advisory without a
 * CWE in the MVP classes is returned in `skipped`.
 *
 * One advisory can appear under several ids (a GHSA id and its CVE alias). OSV groups those in
 * `packages[].groups[].ids`; each group is one finding, named by its lowest id (bytewise) among
 * the vulnerabilities present, with the CWEs of all its members. The same advisory on two packages
 * is two findings that later merge into one candidate while both packages stay on record.
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
    const path = safeRepoPath(g.raw(own(source, 'path'), `${rp}/source/path`), false);
    const pkgs = g.optArr(own(r, 'packages'), `${rp}/packages`, LIMITS.osvPackages);
    pkgTotal += pkgs.length;
    if (pkgTotal > LIMITS.osvPackages) g.fail('too-many', `${rp}/packages`, 'too many packages');

    // Union-find over advisory ids for this lockfile: ids named together in any package's group are
    // one advisory, so a GHSA id on one package and its CVE alias on another collapse too.
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let root = x;
      for (let up = parent.get(root); up !== undefined && up !== root; up = parent.get(root)) {
        root = up;
      }
      parent.set(x, root);
      return root;
    };
    const union = (a: string, b: string): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(cmp(ra, rb) < 0 ? rb : ra, cmp(ra, rb) < 0 ? ra : rb);
    };

    const infos = pkgs.map((pRaw, pi) => {
      const pp = `${rp}/packages/${pi}`;
      const p = g.obj(pRaw, pp);
      const pk = g.obj(own(p, 'package'), `${pp}/package`);
      const name = own(pk, 'name');
      const version = own(pk, 'version');
      const pkg = {
        name: typeof name === 'string' ? name.slice(0, LIMITS.ruleId) : '',
        version: typeof version === 'string' ? version.slice(0, LIMITS.ruleId) : '',
      };
      const vulns = g.optArr(own(p, 'vulnerabilities'), `${pp}/vulnerabilities`, LIMITS.osvVulns);
      vulnTotal += vulns.length;
      if (vulnTotal > LIMITS.osvVulns) g.fail('too-many', `${pp}/vulnerabilities`, 'too many');
      const items = vulns.map((vRaw, vi) => {
        const vp = `${pp}/vulnerabilities/${vi}`;
        const v = g.obj(vRaw, vp);
        const id = g.str(own(v, 'id'), `${vp}/id`, LIMITS.ruleId);
        const ds = own(v, 'database_specific');
        const ids = isObj(ds) ? own(ds, 'cwe_ids') : undefined;
        const cwe =
          ids === undefined
            ? []
            : g
                .arr(ids, `${vp}/database_specific/cwe_ids`, LIMITS.osvCwe)
                .filter((t): t is string => typeof t === 'string' && t.length <= LIMITS.string);
        find(id);
        return { id, cwe };
      });
      g.optArr(own(p, 'groups'), `${pp}/groups`, LIMITS.osvVulns).forEach((gr, gi) => {
        const ids = g
          .optArr(
            own(g.obj(gr, `${pp}/groups/${gi}`), 'ids'),
            `${pp}/groups/${gi}/ids`,
            LIMITS.osvVulns,
          )
          .filter((x): x is string => typeof x === 'string' && x.length <= LIMITS.ruleId);
        for (const id of ids) union(ids[0] as string, id);
      });
      return { pkg, items };
    });

    // One advisory per union-find component: named by its lowest id among the vulnerabilities
    // present in the lockfile, with the CWEs of all its members.
    const names = new Map<string, string>();
    const cwes = new Map<string, number[]>();
    for (const { items } of infos) {
      for (const { id, cwe } of items) {
        const root = find(id);
        const cur = names.get(root);
        if (cur === undefined || cmp(id, cur) < 0) names.set(root, id);
        cwes.set(root, [...(cwes.get(root) ?? []), ...cweNumbers(cwe)]);
      }
    }
    for (const { pkg, items } of infos) {
      const seen = new Set<string>();
      for (const { id } of items) {
        const root = find(id);
        if (seen.has(root)) continue;
        seen.add(root);
        const ruleId = names.get(root) as string;
        const cwe = [...new Set(cwes.get(root))].sort((a, b) => a - b);
        const cls = classOf(cwe);
        if (!path.ok) {
          skipped.push({ tool: 'osv', ruleId, reason: 'unsafe-path', cwe });
        } else if (cls === undefined) {
          skipped.push({ tool: 'osv', ruleId, reason: 'unmapped-class', file: path.path, cwe });
        } else {
          findings.push({
            tool: 'osv',
            ruleId,
            cls,
            file: path.path,
            startLine: 1,
            endLine: 1,
            pkg,
          });
        }
      }
    }
  });
  return { findings, skipped };
}
