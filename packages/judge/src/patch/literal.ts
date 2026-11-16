import type { ParamSpace } from '@affidavit/contracts';
import type { DiffFile, DiffLine, ParsedDiff } from './diff.js';

/**
 * `literal-only-patch` (F5): does the patch special-case values the witness sent?
 *
 * The plan rejects a patch "whose only change is special-casing a literal value from the
 * witness's parameters". "Only" cannot be checked statically against an author who pads the patch
 * with an unrelated hunk, so the Judge is stricter: any added code line that special-cases a
 * witness value rejects the patch. A real fix does not need the exploit's own payload. The whole
 * family rerun on the patched target is the dynamic half of the same check.
 *
 * What counts as special-casing, on added lines outside test files, after comment text is
 * stripped (complete block comments anywhere, and a line comment only when it starts the line):
 * - a string literal equal to a string value or object key from the parameters (two characters or
 *   more), or containing one, or contained in one, when the shorter side has four or more;
 * - the remaining code containing a parameter string of four characters or more (catches regex
 *   literals and template strings);
 * - a numeric literal (bare or quoted, any notation `Number()` reads, its own sign included)
 *   equal to a parameter number and compared for equality (`===`, `!==`, `==`, `!=`) or used as a
 *   `case` label, unless the other side is a `.length` or `.size`;
 * - an array literal holding a parameter number, used with `.includes`, `.indexOf`,
 *   `.lastIndexOf` or wrapped in `new Set(...)`;
 * - a reference to a test file in the same diff: a non-test line that names its path, its file
 *   name, or its name without extension as the last segment of a string, or a relative path into
 *   a test root. Test files are exempt from this rule, so they must not be reachable from code.
 *
 * Added lines in test files are exempt, so a regression test that replays the payload is fine.
 * Test files are only files under a recognised test root (see `isTestFile`).
 */

export interface LiteralHit {
  path: string;
  line: string;
  value: string | number;
}

const MIN_EXACT = 2;
const MIN_CONTAINS = 4;

/** Directory names that hold a project's tests. */
export const TEST_ROOTS = ['test', 'tests', '__tests__', 'spec'] as const;
/** Directories whose direct children are packages in a monorepo. */
const WORKSPACE_DIRS = ['packages', 'apps', 'libs', 'modules', 'services'];

/**
 * A test file lives under a test root at the repository root (`test/x.js`) or at a package root
 * (`packages/api/test/x.js`). Nothing else counts: not a `*.test.js` file next to the code, not a
 * `test/` folder deep inside the source tree. A file the Judge does not treat as a test file is
 * held to every rule, so the narrow definition fails closed.
 */
export function isTestFile(path: string): boolean {
  const parts = path.split('/');
  const isRoot = (s: string | undefined): boolean =>
    (TEST_ROOTS as readonly string[]).includes(s ?? '');
  if (parts.length >= 2 && isRoot(parts[0])) return true;
  return parts.length >= 4 && WORKSPACE_DIRS.includes(parts[0] ?? '') && isRoot(parts[2]);
}

/** String values, object keys and numbers anywhere in the parameter space. */
export function paramLiterals(params: ParamSpace): { strings: string[]; numbers: number[] } {
  const strings = new Set<string>();
  const numbers = new Set<number>();
  const visit = (v: unknown, depth: number): void => {
    if (depth > 32) return;
    if (typeof v === 'string') {
      if (v.trim().length >= MIN_EXACT) strings.add(v);
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      numbers.add(v);
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
    } else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k.trim().length >= MIN_EXACT) strings.add(k);
        visit(x, depth + 1);
      }
    }
  };
  for (const p of params) for (const v of p.values) visit(v, 0);
  return { strings: [...strings], numbers: [...numbers] };
}

/** Characters after which a `/` starts a regex literal rather than a division. */
const REGEX_PREFIX = /[(,=:[!&|?{};+\-*%<>~^]$/;

/**
 * The code on one added line with comment text removed. Only complete `/* ... *\/` spans are
 * removed, and a `//` or `# ` comment only when it starts the line (`#name` is a JS private
 * field, not a comment). String, template and (by the usual heuristic) regex literals are skipped
 * while scanning, so a `/*` inside a string cannot hide the code after it. A span that itself
 * holds a quote or backtick is kept: the line may continue a string opened on an earlier line,
 * where JS would read that `/*` as text and the rest as code. The line itself is never skipped.
 */
export function stripComments(line: string): string {
  if (/^\s*(\/\/|#(\s|!|$))/.test(line)) return '';
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i] ?? '';
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = closeOf(line, i, ch);
      out += line.slice(i, end);
      i = end;
    } else if (ch === '/' && line[i + 1] === '*') {
      const close = line.indexOf('*/', i + 2);
      if (close === -1) {
        // Not a complete span: keep the text, so code after an unclosed `/*` is still checked.
        out += line.slice(i);
        break;
      }
      const span = line.slice(i, close + 2);
      out += /['"`]/.test(span) ? span : ' ';
      i = close + 2;
    } else if (ch === '/' && line[i + 1] !== '/' && REGEX_PREFIX.test(out.trimEnd() || '(')) {
      const end = closeOf(line, i, '/');
      out += line.slice(i, end);
      i = end;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Index just past the literal that opens at `start`, or the end of the line if it never closes. */
function closeOf(line: string, start: number, quote: string): number {
  let i = start + 1;
  let inClass = false;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (quote === '/' && ch === '[') inClass = true;
    else if (quote === '/' && ch === ']') inClass = false;
    else if (ch === quote && !inClass) return i + 1;
    i++;
  }
  return line.length;
}

/** String literals in one line of JS or TS, with the common escapes decoded. */
export function stringLiterals(line: string): string[] {
  const out: string[] = [];
  const re = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const m of line.matchAll(re)) {
    const body = m[2] ?? '';
    if (m[1] === '`' && body.includes('${')) continue;
    out.push(decode(body));
  }
  return out;
}

function decode(s: string): string {
  return s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, e: string) => {
    if (e.startsWith('u{')) return safeCodePoint(parseInt(e.slice(2, -1), 16));
    if (e[0] === 'u' || e[0] === 'x') return safeCodePoint(parseInt(e.slice(1), 16));
    return ({ n: '\n', t: '\t', r: '\r', '0': '\0' } as Record<string, string>)[e] ?? e;
  });
}

function safeCodePoint(n: number): string {
  return n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

/** A JS numeric literal in any notation `Number()` reads, without its sign. */
const NUM_BODY = String.raw`(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)`;
/**
 * The same as an operand: optionally quoted, with its own sign. Named groups, so the pattern can
 * be embedded in a larger one: `q` (quote), `sign` and `num`. Used at most once per regex.
 */
const NUM_OPERAND = String.raw`(?<q>['"\x60]?)(?<sign>-\s*)?(?<num>${NUM_BODY})\k<q>`;

interface NumGroups {
  sign?: string;
  num?: string;
}

/** The operand's value with its own sign, so `-1` is never mistaken for `1`. */
function numericValue(g: NumGroups | undefined): number {
  const n = Number((g?.num ?? '').replace(/_/g, ''));
  return g?.sign === undefined ? n : -n;
}

const lengthLike = (side: string | undefined): boolean => /\.(length|size)\s*$/.test(side ?? '');
const EQ_OP = '(?:===|!==|==|!=)';

function comparesNumber(code: string, numbers: readonly number[]): number | undefined {
  if (numbers.length === 0) return undefined;
  const has = (n: number): number | undefined => numbers.find((x) => x === n);
  // `<left> OP <num>`; the number ends there (not `1.5`, not `1 + x`'s first term).
  const after = new RegExp(
    String.raw`(?<left>[\w$.\])]+)\s*${EQ_OP}\s*${NUM_OPERAND}(?![\w.$])`,
    'g',
  );
  for (const m of code.matchAll(after)) {
    const hit = has(numericValue(m.groups));
    if (hit !== undefined && !lengthLike(m.groups?.left)) return hit;
  }
  // `<num> OP <right>`.
  const before = new RegExp(
    String.raw`(?<![\w.$\])])${NUM_OPERAND}\s*${EQ_OP}\s*(?<right>[\w$.]+)`,
    'g',
  );
  for (const m of code.matchAll(before)) {
    // `x - 1 === y`: the `1` is the right operand of a subtraction, not a literal compared.
    if (
      m.groups?.sign === undefined &&
      m.groups?.q === '' &&
      /[\w$)\]]\s*-\s*$/.test(code.slice(0, m.index))
    ) {
      continue;
    }
    const hit = has(numericValue(m.groups));
    if (hit !== undefined && !lengthLike(m.groups?.right)) return hit;
  }
  const label = new RegExp(String.raw`\bcase\s+${NUM_OPERAND}\s*:`, 'g');
  for (const m of code.matchAll(label)) {
    const hit = has(numericValue(m.groups));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** `[1, 2, 3].includes(x)`, `[..].indexOf(x)` and `new Set([..])` holding a parameter number. */
function arrayMembership(code: string, numbers: readonly number[]): number | undefined {
  if (numbers.length === 0) return undefined;
  const arrays = [
    ...code.matchAll(/\[([^[\]]*)\]\s*\.\s*(?:includes|indexOf|lastIndexOf)\s*\(/g),
    ...code.matchAll(/new\s+Set\s*\(\s*\[([^[\]]*)\]/g),
  ];
  const element = new RegExp(String.raw`^\s*${NUM_OPERAND}\s*$`);
  for (const m of arrays) {
    for (const el of (m[1] ?? '').split(',')) {
      const e = element.exec(el);
      if (e === null) continue;
      const n = numericValue(e.groups);
      const hit = numbers.find((x) => x === n);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

function matchesString(literal: string, value: string): boolean {
  if (literal === value) return true;
  const [short, long] = literal.length <= value.length ? [literal, value] : [value, literal];
  return short.length >= MIN_CONTAINS && long.includes(short);
}

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
/** The file name without its last extension: `guard.test.js` becomes `guard.test`. */
const stem = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
};

/**
 * Does this line point at one of the diff's test files? Test files are exempt from the literal
 * check, so code that loads one would carry the special case past it.
 */
function namesTestFile(code: string, testFiles: readonly string[]): string | undefined {
  if (testFiles.length === 0) return undefined;
  const literals = stringLiterals(code);
  for (const path of testFiles) {
    const name = basename(path);
    if (code.includes(path) || code.includes(name)) return path;
    const s = stem(name);
    for (const lit of literals) {
      const last = basename(lit.replace(/\/+$/, ''));
      if (last === s || stem(last) === s) return path;
    }
  }
  for (const lit of literals) {
    if (!/^\.{1,2}\//.test(lit)) continue;
    if (lit.split('/').some((seg) => (TEST_ROOTS as readonly string[]).includes(seg))) {
      return lit;
    }
  }
  return undefined;
}

/** The added lines that special-case a witness value. Empty means the rule passes. */
export function findLiteralSpecialCases(
  lines: readonly DiffLine[],
  params: ParamSpace,
  testFiles: readonly string[] = [],
): LiteralHit[] {
  const { strings, numbers } = paramLiterals(params);
  const hits: LiteralHit[] = [];
  for (const { path, text } of lines) {
    if (isTestFile(path)) continue;
    const code = stripComments(text);
    if (code.trim() === '') continue;
    const literals = stringLiterals(code);
    const value =
      strings.find(
        (s) =>
          literals.some((l) => matchesString(l, s)) ||
          (s.length >= MIN_CONTAINS && code.includes(s)),
      ) ??
      comparesNumber(code, numbers) ??
      arrayMembership(code, numbers) ??
      namesTestFile(code, testFiles);
    if (value !== undefined) hits.push({ path, line: text, value });
  }
  return hits;
}

/** Test runner modifiers that skip or narrow a suite: `.only`, `.skip`, `xit`, `fdescribe`. */
const NARROWS_SUITE =
  /\b(?:describe|context|suite|it|test|specify)\s*\.\s*(?:only|skip|todo)\b|\b[xf](?:it|describe|context|test)\s*\(/;

/** Manifest and runner config files whose removed lines could weaken the test suite. */
const SUITE_CONFIG =
  /(^|\/)(package\.json|\.mocharc(\.[a-z]+)?|\.nycrc(\.[a-z]+)?|(jest|vitest|karma|mocha)\.conf(ig)?\.[cm]?[jt]s|Gruntfile\.[cm]?[jt]s|[Gg]ulpfile\.[cm]?[jt]s)$/;
/** A `package.json` line that is a test or CI script, or the `scripts` block itself. */
const SUITE_SCRIPT_KEY =
  /^\s*"(scripts|(pre|post)?(test|tests|spec|ci|check|coverage)([:._-][^"]*)?)"\s*:/;

export interface SuiteTamper {
  path: string;
  reason: string;
}

/**
 * Diff-level guard for the target's own test suite: a patch may add tests, never take them away.
 * Refused: deleting a test file, removing any line from an existing test file, adding a line that
 * skips or narrows tests (`.only`, `.skip`, `xit`), removing a test or CI script (or the
 * `scripts` key) from a `package.json`, and removing lines from a test runner config.
 */
export function findSuiteTampering(diff: ParsedDiff): SuiteTamper[] {
  const out: SuiteTamper[] = [];
  for (const f of diff.files) {
    if (isTestFile(f.path)) {
      if (f.status === 'deleted') out.push({ path: f.path, reason: 'deletes a test file' });
      else if (f.removed.length > 0) {
        out.push({ path: f.path, reason: 'removes lines from a test file' });
      }
      if (f.added.some((l) => NARROWS_SUITE.test(stripComments(l)))) {
        out.push({ path: f.path, reason: 'skips or narrows tests' });
      }
      continue;
    }
    if (!SUITE_CONFIG.test(f.path)) continue;
    if (f.status === 'deleted') {
      out.push({ path: f.path, reason: 'deletes a test runner config' });
    } else if (basename(f.path) === 'package.json') {
      if (f.removed.some((l) => SUITE_SCRIPT_KEY.test(l))) {
        out.push({ path: f.path, reason: 'removes a test script' });
      }
    } else if (f.removed.length > 0) {
      out.push({ path: f.path, reason: 'removes lines from a test runner config' });
    }
  }
  return out;
}

/** Paths of the diff's test files. */
export const testFilesOf = (diff: ParsedDiff): string[] =>
  diff.files.filter((f: DiffFile) => isTestFile(f.path)).map((f) => f.path);
