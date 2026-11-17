/**
 * Regression harness for our own Semgrep rules (L1-04).
 *
 * Pure functions only: nothing here starts Docker or touches the network. The Docker test
 * (corpus-regression.docker.test.ts) fetches the corpus trees, runs the pinned Semgrep image
 * through runTool, and hands the parsed findings to `evaluate`. The unit tests feed it synthetic
 * findings.
 *
 * The corpus is read as plain JSON from packages/corpus/data (discovery does not depend on the
 * corpus package). Repo content is untrusted data: only line numbers, rule ids and relative paths
 * are taken from reports, and nothing in a report is executed.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface LineRange {
  startLine: number;
  endLine: number;
}

export interface CorpusLabelLite {
  id: string;
  cls: string;
  file: string;
  range: LineRange;
  source: { file: string; range: LineRange };
}

export interface CorpusLite {
  labels: CorpusLabelLite[];
  /** Safe variants: the label each one fixes. */
  safeVariants: { id: string; fixes: string }[];
  negativeControls: {
    id: string;
    file: string;
    range: LineRange;
    expectedRuleIds: string[];
  }[];
}

export type TreeVariant = 'vulnerable' | 'safe' | 'negative-control';

export interface RuleFinding {
  ruleId: string;
  /** Repo-relative path, posix separators, without the `/src/` mount prefix. */
  file: string;
  startLine: number;
  endLine: number;
}

export interface TreeRun {
  variant: TreeVariant;
  findings: RuleFinding[];
  /** Semgrep notifications (timeouts, parse errors) as plain messages. */
  notifications: string[];
}

export interface Expectations {
  app: string;
  rules: Record<string, { catches: string[]; flagsControls: string[] }>;
  notTargeted: Record<string, string>;
  unlabeledFindings: { ruleId: string; file: string; startLine: number }[];
  allowedNotificationPathPrefixes: string[];
}

export interface RuleRow {
  ruleId: string;
  /** Label ids this rule caught on the vulnerable tree. */
  caught: string[];
  /** Negative control ids this rule flagged on the control tree. */
  controlsFlagged: string[];
  /** Findings on the safe tree inside the fixed label's code. */
  fixedSiteFindingsOnSafe: number;
  /** Findings per tree that overlap no label and no control. */
  unlabeled: Record<TreeVariant, number>;
  /** Total findings per tree. */
  total: Record<TreeVariant, number>;
}

export interface Evaluation {
  rows: RuleRow[];
  /** Labels no rule caught, with the reason recorded in the expectations file. */
  missed: { labelId: string; reason: string }[];
  /** Empty when the run matches the corpus labels and the expectations file. */
  problems: string[];
}

const overlaps = (a: LineRange, b: LineRange): boolean =>
  a.startLine <= b.endLine && b.startLine <= a.endLine;

const range = (f: RuleFinding): LineRange => ({ startLine: f.startLine, endLine: f.endLine });

/** Labels whose sink or source code the finding sits in. */
export function labelsHit(f: RuleFinding, corpus: CorpusLite): string[] {
  return corpus.labels
    .filter(
      (l) =>
        (l.file === f.file && overlaps(range(f), l.range)) ||
        (l.source.file === f.file && overlaps(range(f), l.source.range)),
    )
    .map((l) => l.id);
}

export function controlsHit(f: RuleFinding, corpus: CorpusLite): string[] {
  return corpus.negativeControls
    .filter((c) => c.file === f.file && overlaps(range(f), c.range))
    .map((c) => c.id);
}

const sortedUnique = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  JSON.stringify(sortedUnique(a)) === JSON.stringify(sortedUnique(b));

const showSet = (xs: readonly string[]): string => (xs.length === 0 ? 'none' : xs.join(', '));

/** Path of a repo file named in a Semgrep notification, or undefined if none is named. */
export function notificationPath(message: string): string | undefined {
  const m = /\/src\/([^\s:]+)/.exec(message);
  return m?.[1];
}

/**
 * Compares a full run (all three corpus trees) with the corpus labels and the expectations file.
 * Every difference is a problem string; the caller fails the test when the list is not empty.
 */
export function evaluate(
  corpus: CorpusLite,
  expectations: Expectations,
  ruleIds: readonly string[],
  runs: Readonly<Record<TreeVariant, TreeRun>>,
): Evaluation {
  const problems: string[] = [];
  const labelIds = new Set(corpus.labels.map((l) => l.id));
  const controlIds = new Set(corpus.negativeControls.map((c) => c.id));

  for (const id of ruleIds) {
    if (!(id in expectations.rules)) problems.push(`rule ${id} has no entry in the expectations`);
  }
  for (const id of Object.keys(expectations.rules)) {
    if (!ruleIds.includes(id)) problems.push(`expectations name rule ${id}, which does not exist`);
  }
  for (const [id, e] of Object.entries(expectations.rules)) {
    for (const l of e.catches) if (!labelIds.has(l)) problems.push(`${id}: unknown label ${l}`);
    for (const c of e.flagsControls)
      if (!controlIds.has(c)) problems.push(`${id}: unknown negative control ${c}`);
  }

  const fixed = new Set(corpus.safeVariants.map((v) => v.fixes));
  const rows: RuleRow[] = [];

  for (const ruleId of ruleIds) {
    const expected = expectations.rules[ruleId];
    const caught: string[] = [];
    const controlsFlagged: string[] = [];
    let fixedSiteFindingsOnSafe = 0;
    const unlabeled: Record<TreeVariant, number> = {
      vulnerable: 0,
      safe: 0,
      'negative-control': 0,
    };
    const total: Record<TreeVariant, number> = { vulnerable: 0, safe: 0, 'negative-control': 0 };

    for (const variant of ['vulnerable', 'safe', 'negative-control'] as const) {
      const mine = runs[variant].findings.filter((f) => f.ruleId === ruleId);
      total[variant] = mine.length;
      const hitLabels: string[] = [];
      for (const f of mine) {
        const ls = labelsHit(f, corpus);
        const cs = controlsHit(f, corpus);
        hitLabels.push(...ls);
        if (variant === 'negative-control') controlsFlagged.push(...cs);
        if (variant === 'safe') {
          fixedSiteFindingsOnSafe += ls.filter((l) => fixed.has(l)).length;
        }
        if (ls.length === 0 && cs.length === 0) {
          unlabeled[variant] += 1;
          const known = expectations.unlabeledFindings.some(
            (u) => u.ruleId === ruleId && u.file === f.file && u.startLine === f.startLine,
          );
          if (!known) {
            problems.push(
              `${variant}: ${ruleId} reported ${f.file}:${f.startLine}-${f.endLine}, which is in no labeled issue and no negative control`,
            );
          }
        }
      }
      if (variant === 'vulnerable') caught.push(...hitLabels);
      if (variant !== 'vulnerable' && expected) {
        // The safe patch closes one label. Everything else must behave as on the vulnerable tree.
        const want = expected.catches.filter((l) => !fixed.has(l));
        const got = sortedUnique(hitLabels);
        if (!sameSet(got, want)) {
          problems.push(
            `${variant}: ${ruleId} hit labels [${showSet(got)}], expected [${showSet(want)}]`,
          );
        }
      }
    }

    const caughtSet = sortedUnique(caught);
    const controlSet = sortedUnique(controlsFlagged);
    if (expected) {
      if (!sameSet(caughtSet, expected.catches)) {
        problems.push(
          `vulnerable: ${ruleId} caught [${showSet(caughtSet)}], expected [${showSet(expected.catches)}]`,
        );
      }
      if (!sameSet(controlSet, expected.flagsControls)) {
        problems.push(
          `negative-control: ${ruleId} flagged controls [${showSet(controlSet)}], expected [${showSet(expected.flagsControls)}]`,
        );
      }
    }
    if (fixedSiteFindingsOnSafe > 0) {
      problems.push(
        `safe: ${ruleId} still reports ${fixedSiteFindingsOnSafe} finding(s) in code the safe patch fixed (differential check)`,
      );
    }
    rows.push({
      ruleId,
      caught: caughtSet,
      controlsFlagged: controlSet,
      fixedSiteFindingsOnSafe,
      unlabeled,
      total,
    });
  }

  // The corpus's own claim about each control: these rule ids must flag it.
  for (const c of corpus.negativeControls) {
    for (const id of c.expectedRuleIds) {
      const row = rows.find((r) => r.ruleId === id);
      if (!row) {
        problems.push(`corpus control ${c.id} expects rule ${id}, which does not exist`);
      } else if (!row.controlsFlagged.includes(c.id)) {
        problems.push(`corpus control ${c.id} expects ${id} to flag it, and it did not`);
      }
    }
  }

  // Labels nothing caught must be explained.
  const everCaught = new Set(rows.flatMap((r) => r.caught));
  const missed: Evaluation['missed'] = [];
  for (const l of corpus.labels) {
    if (everCaught.has(l.id)) {
      if (l.id in expectations.notTargeted) {
        problems.push(`label ${l.id} is listed as not targeted but a rule caught it`);
      }
      continue;
    }
    const reason = expectations.notTargeted[l.id];
    if (reason === undefined) {
      problems.push(`label ${l.id} was caught by no rule and is not listed as not targeted`);
    } else {
      missed.push({ labelId: l.id, reason });
    }
  }
  for (const id of Object.keys(expectations.notTargeted)) {
    if (!labelIds.has(id)) problems.push(`notTargeted names unknown label ${id}`);
  }

  // A timeout or parse failure may hide findings. It is allowed only in named vendored paths.
  for (const variant of ['vulnerable', 'safe', 'negative-control'] as const) {
    for (const message of runs[variant].notifications) {
      const p = notificationPath(message);
      const allowed =
        p !== undefined &&
        expectations.allowedNotificationPathPrefixes.some((prefix) => p.startsWith(prefix));
      if (!allowed) {
        problems.push(`${variant}: unexplained Semgrep notification: ${message.slice(0, 200)}`);
      }
    }
  }

  return { rows, missed, problems };
}

/** Rule ids declared in a rules directory (`- id:` lines at rule level). */
export function listRuleIds(rulesDir: string): string[] {
  const ids: string[] = [];
  for (const name of readdirSync(rulesDir).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const text = readFileSync(join(rulesDir, name), 'utf8');
    for (const m of text.matchAll(/^ {2}- id: (\S+)\s*$/gm)) {
      const id = m[1];
      if (id !== undefined) ids.push(id);
    }
  }
  return ids;
}

/** `ruleid:` and `ok:` annotation counts per rule id in a directory of Semgrep test files. */
export function countAnnotations(testsDir: string): Record<string, { ruleid: number; ok: number }> {
  const out: Record<string, { ruleid: number; ok: number }> = {};
  for (const name of readdirSync(testsDir).sort()) {
    const text = readFileSync(join(testsDir, name), 'utf8');
    for (const m of text.matchAll(/^\s*\/\/\s*(ruleid|ok):\s*(.+?)\s*$/gm)) {
      const kind = m[1] as 'ruleid' | 'ok';
      for (const id of (m[2] ?? '').split(',').map((s) => s.trim())) {
        if (!id) continue;
        out[id] ??= { ruleid: 0, ok: 0 };
        out[id][kind] += 1;
      }
    }
  }
  return out;
}

/**
 * Digest over everything a rule change can touch: rule files, Semgrep test files, and the
 * expectations file, with line endings normalised so a Windows checkout hashes the same.
 */
export function rulesDigest(rulesRoot: string): string {
  const h = createHash('sha256');
  const files: string[] = [];
  for (const sub of ['semgrep', 'tests']) {
    for (const name of readdirSync(join(rulesRoot, sub)).sort()) files.push(`${sub}/${name}`);
  }
  files.push('corpus-expectations.json');
  for (const rel of files) {
    const text = readFileSync(join(rulesRoot, rel), 'utf8').replace(/\r\n/g, '\n');
    h.update(`${rel}\n${text.length}\n${text}\n`);
  }
  return h.digest('hex');
}

/** Findings from a Semgrep SARIF document. Anything malformed is skipped, never trusted. */
export function parseSemgrepSarif(doc: unknown): RuleFinding[] {
  const out: RuleFinding[] = [];
  const runs = (doc as { runs?: unknown }).runs;
  if (!Array.isArray(runs)) throw new Error('not a SARIF document: no runs array');
  for (const run of runs as { results?: unknown }[]) {
    if (!Array.isArray(run.results)) continue;
    for (const r of run.results as {
      ruleId?: unknown;
      locations?: {
        physicalLocation?: { artifactLocation?: { uri?: unknown }; region?: unknown };
      }[];
    }[]) {
      const loc = r.locations?.[0]?.physicalLocation;
      const uri = loc?.artifactLocation?.uri;
      const region = loc?.region as { startLine?: unknown; endLine?: unknown } | undefined;
      if (
        typeof r.ruleId !== 'string' ||
        typeof uri !== 'string' ||
        typeof region?.startLine !== 'number'
      ) {
        continue;
      }
      out.push({
        ruleId: r.ruleId,
        file: uri.replace(/^\/src\//, ''),
        startLine: region.startLine,
        endLine: typeof region.endLine === 'number' ? region.endLine : region.startLine,
      });
    }
  }
  return out;
}

/** Plain-text table for a human (and for rules-report.md). */
export function formatEvaluation(e: Evaluation, corpus: CorpusLite): string {
  const label = (id: string): string => (corpus.labels.some((l) => l.id === id) ? id : `?${id}`);
  const lines = [
    '| Rule | Labeled issues caught (vulnerable tree) | Negative controls flagged | Findings on fixed site (safe tree) | Unlabeled findings (vuln / safe / control) |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const r of e.rows) {
    lines.push(
      `| \`${r.ruleId}\` | ${showSet(r.caught.map(label))} | ${showSet(r.controlsFlagged)} | ${r.fixedSiteFindingsOnSafe} | ${r.unlabeled.vulnerable} / ${r.unlabeled.safe} / ${r.unlabeled['negative-control']} |`,
    );
  }
  for (const m of e.missed) lines.push(`\nNot caught by any rule: ${m.labelId} (${m.reason})`);
  return lines.join('\n');
}
