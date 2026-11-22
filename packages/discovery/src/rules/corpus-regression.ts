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
  /** Set by the Docker test for IDOR labels: last line of the handler that holds the source. */
  handlerEndLine?: number;
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
  /** Pinned last line of the handler that holds each IDOR label's source (see handlerEndLine). */
  idorHandlerEnds: Record<string, number>;
  unlabeledFindings: { ruleId: string; file: string; startLine: number }[];
  /** Exact (file, rule) pairs of tolerated Semgrep notifications. */
  allowedNotifications: { file: string; rule: string | null }[];
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
        (l.source.file === f.file && overlaps(range(f), l.source.range)) ||
        // IDOR findings sit on the data-access call, which can be a few lines below the labeled
        // source (where the identifier is read). They count when they are in the same handler:
        // from the labeled source to the end of the function that holds it.
        (l.handlerEndLine !== undefined &&
          l.source.file === f.file &&
          f.startLine >= l.source.range.startLine &&
          f.endLine <= l.handlerEndLine),
    )
    .map((l) => l.id);
}

/**
 * Brace depth at the start and at the end of every line. One pass over the whole text, so a string
 * is recognised before a comment (`"http://x"` is not a comment), a template literal can span
 * lines and hold `${ ... }` expressions, and a block comment can too. Braces inside strings,
 * templates and comments do not count. Regular expression literals are not recognised.
 */
function lineDepths(text: string): { start: number[]; end: number[] } {
  const start: number[] = [0];
  const end: number[] = [];
  let mode: 'code' | 'single' | 'double' | 'template' | 'line' | 'block' = 'code';
  let depth = 0;
  // Brace depth at which each open `${` started; the `}` that returns to it closes the expression.
  const templateStack: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '\n') {
      end.push(depth);
      start.push(depth);
      // A quote not closed on its line ends there; a line comment ends too.
      if (mode === 'single' || mode === 'double' || mode === 'line') mode = 'code';
      continue;
    }
    if (mode === 'line') continue;
    if (mode === 'block') {
      if (c === '*' && next === '/') {
        mode = 'code';
        i++;
      }
      continue;
    }
    if (mode === 'single' || mode === 'double' || mode === 'template') {
      if (c === '\\') {
        // The escaped character is skipped, unless it is the newline (counted above).
        if (next !== undefined && next !== '\n') i++;
      } else if (mode === 'single' && c === "'") mode = 'code';
      else if (mode === 'double' && c === '"') mode = 'code';
      else if (mode === 'template') {
        if (c === '`') mode = 'code';
        else if (c === '$' && next === '{') {
          templateStack.push(depth);
          mode = 'code';
          i++;
        }
      }
      continue;
    }
    if (c === '/' && next === '/') mode = 'line';
    else if (c === '/' && next === '*') {
      mode = 'block';
      i++;
    } else if (c === "'") mode = 'single';
    else if (c === '"') mode = 'double';
    else if (c === '`') mode = 'template';
    else if (c === '{') depth++;
    else if (c === '}') {
      if (templateStack.length > 0 && templateStack[templateStack.length - 1] === depth) {
        templateStack.pop();
        mode = 'template';
      } else depth--;
    }
  }
  end.push(depth);
  return { start, end };
}

/**
 * Last line of the block that holds the labeled source (for a source read directly in a handler
 * body, the handler). Two cases, decided by the labeled range `startLine` to `endLine`:
 *  - the range ends inside a block that its first line opened (`app.get(p, (req, res) => { const
 *    id = ...`): that block is the handler, and it ends on the first line that brings the depth
 *    back to where the range started. A multi-line destructuring (`const {\n id\n} = req.params`)
 *    opens and closes inside the range, so it is the second case;
 *  - otherwise the innermost block that holds the line: the first line, from `startLine` on, where
 *    the depth drops below the depth at the start of that line.
 * Strings (also multi-line templates with `${ }`), line comments and block comments are skipped;
 * regular expression literals are not. Returns the last line of the file if no end is found.
 */
export function handlerEndLine(text: string, startLine: number, endLine = startLine): number {
  const { start, end } = lineDepths(text.replace(/\r\n/g, '\n'));
  const at = Math.max(0, startLine - 1);
  const base = start[at] ?? 0;
  const opens = (end[Math.max(at, endLine - 1)] ?? 0) > base;
  for (let i = opens ? at + 1 : at; i < end.length; i++) {
    const d = end[i] ?? 0;
    if (opens ? d <= base : d < base) return i + 1;
  }
  return end.length;
}

/**
 * Problems when the handler end computed for an IDOR label differs from the one pinned in the
 * expectations, when an IDOR label has no pin, or when a pin names no IDOR label. An unpinned or
 * drifting end would silently widen or narrow which findings count for the label.
 */
export function handlerEndProblems(
  labels: readonly CorpusLabelLite[],
  expectations: Pick<Expectations, 'idorHandlerEnds'>,
): string[] {
  const problems: string[] = [];
  const pins = expectations.idorHandlerEnds;
  const idor = labels.filter((l) => l.cls === 'idor');
  for (const l of idor) {
    const pinned = pins[l.id];
    if (pinned === undefined) {
      problems.push(`idor label ${l.id} has no pinned handler end in the expectations`);
    } else if (l.handlerEndLine !== pinned) {
      problems.push(
        `idor label ${l.id}: handler end computed as ${String(l.handlerEndLine)}, pinned as ${String(pinned)}`,
      );
    }
  }
  for (const id of Object.keys(pins)) {
    if (!idor.some((l) => l.id === id)) problems.push(`idorHandlerEnds names no idor label: ${id}`);
  }
  return problems;
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

export interface ParsedNotification {
  kind: 'timeout' | 'syntax-error';
  /** Repo-relative path. */
  file: string;
  /** Rule that timed out; null for a parse error, which is not tied to a rule. */
  rule: string | null;
}

/**
 * Reads the two Semgrep notification shapes the regression tolerates. Anything else, including a
 * path that is absolute or climbs out with `..`, is undefined and so never allowed.
 */
export function parseNotification(message: string): ParsedNotification | undefined {
  const first = message.split('\n')[0] ?? '';
  const timeout = /^Timeout when running (\S+) on \/src\/(\S+?):$/.exec(first);
  const syntax = /^Syntax error at line \/src\/(\S+?):\d+:$/.exec(first);
  const parsed: ParsedNotification | undefined = timeout
    ? { kind: 'timeout', rule: timeout[1] ?? '', file: timeout[2] ?? '' }
    : syntax
      ? { kind: 'syntax-error', rule: null, file: syntax[1] ?? '' }
      : undefined;
  if (!parsed) return undefined;
  if (parsed.file.startsWith('/') || parsed.file.split('/').includes('..')) return undefined;
  return parsed;
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

  // A timeout or parse failure may hide findings. Each one must be an exact (file, rule) pair the
  // expectations name. A path with `..` or a leading slash is never accepted.
  for (const variant of ['vulnerable', 'safe', 'negative-control'] as const) {
    for (const message of runs[variant].notifications) {
      const n = parseNotification(message);
      const allowed =
        n !== undefined &&
        expectations.allowedNotifications.some((a) => a.file === n.file && a.rule === n.rule);
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
 * Digest over everything that decides what the regression result means, with line endings
 * normalised so a Windows checkout hashes the same:
 *  - our rule files, their Semgrep test files, the IDOR generator and the expectations file;
 *  - the Semgrep entry of docker/tools/tools.json (image reference and exit-code policy);
 *  - the NodeGoat pin (commit, tree, archive and patch hashes), the patch files and the corpus
 *    labels (app.json);
 *  - the harness (this file, load.ts, the Docker test, the corpus fetch script) and the wrapper
 *    that builds the Semgrep command line (invocations.ts, run.ts, quarantine.ts).
 * A change to any of them needs a new real run before `pnpm test` passes again.
 */
export function regressionInputsDigest(repo: string): string {
  const h = createHash('sha256');
  const add = (name: string, text: string): void => {
    h.update(`${name}\n${text.length}\n${text}\n`);
  };
  const readText = (rel: string): string =>
    readFileSync(join(repo, rel), 'utf8').replace(/\r\n/g, '\n');

  const rules = 'packages/discovery/rules';
  const files: string[] = [];
  for (const sub of ['semgrep', 'tests']) {
    for (const name of readdirSync(join(repo, rules, sub)).sort()) {
      files.push(`${rules}/${sub}/${name}`);
    }
  }
  files.push(`${rules}/corpus-expectations.json`, `${rules}/generate-idor-rules.mjs`);
  // The Semgrep liveness canary runs next to every scan and decides whether a report counts.
  files.push(
    'packages/discovery/canary/semgrep/canary.yaml',
    'packages/discovery/canary/semgrep/canary.js',
  );

  const nodegoat = 'packages/corpus/data/nodegoat';
  files.push(`${nodegoat}/pin.json`, `${nodegoat}/app.json`);
  for (const name of readdirSync(join(repo, nodegoat, 'patches')).sort()) {
    files.push(`${nodegoat}/patches/${name}`);
  }
  files.push('packages/corpus/scripts/fetch-pinned.mjs');

  const src = 'packages/discovery/src';
  files.push(
    `${src}/rules/corpus-regression.ts`,
    `${src}/rules/load.ts`,
    `${src}/rules/corpus-regression.docker.test.ts`,
    `${src}/tools/invocations.ts`,
    `${src}/tools/run.ts`,
    `${src}/tools/quarantine.ts`,
    `${src}/tools/manifest.ts`,
    `${src}/tools/walk.ts`,
    `${src}/tools/index.ts`,
    `${src}/tools/lockfiles.ts`,
    `${src}/tools/unscannable.ts`,
    `${src}/tools/windows.ts`,
    `${src}/tools/fonts.ts`,
    `${src}/tools/windowproof.ts`,
  );
  for (const rel of files) add(rel, readText(rel));

  const tools = JSON.parse(readText('docker/tools/tools.json')) as {
    tools: { name: string }[];
  };
  add(
    'docker/tools/tools.json#semgrep',
    JSON.stringify(tools.tools.find((t) => t.name === 'semgrep')),
  );
  return h.digest('hex');
}

/**
 * Digest of the normalised run output: every finding on every tree, sorted, plus the per-rule
 * table. Notifications are left out because timeouts depend on machine speed.
 */
export function runOutputDigest(
  runs: Readonly<Record<TreeVariant, TreeRun>>,
  evaluation: Evaluation,
): string {
  const lines: string[] = [];
  for (const variant of ['vulnerable', 'safe', 'negative-control'] as const) {
    for (const f of runs[variant].findings) {
      lines.push(`${variant}|${f.ruleId}|${f.file}|${String(f.startLine)}-${String(f.endLine)}`);
    }
  }
  lines.sort();
  for (const r of evaluation.rows) {
    lines.push(`row|${r.ruleId}|${r.caught.join(',')}|${r.controlsFlagged.join(',')}`);
  }
  return createHash('sha256').update(lines.join('\n')).digest('hex');
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
