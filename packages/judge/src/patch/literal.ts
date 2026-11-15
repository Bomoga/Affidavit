import type { ParamSpace } from '@affidavit/contracts';
import type { DiffLine } from './diff.js';

/**
 * `literal-only-patch` (F5): does the patch special-case values the witness sent?
 *
 * The plan rejects a patch "whose only change is special-casing a literal value from the
 * witness's parameters". "Only" cannot be checked statically against an author who pads the patch
 * with an unrelated hunk, so the Judge is stricter: any added code line that special-cases a
 * witness value rejects the patch. A real fix does not need the exploit's own payload. The whole
 * family rerun on the patched target is the dynamic half of the same check.
 *
 * What counts as special-casing, on added lines outside test files, ignoring comment lines:
 * - a string literal equal to a string value or object key from the parameters (two characters or
 *   more), or containing one, or contained in one, when the shorter side has four or more;
 * - the raw code containing a parameter string of four characters or more (catches regex
 *   literals and template strings);
 * - a number from the parameters, bare or quoted, compared for equality (`===`, `!==`, `==`,
 *   `!=`) or used as a `case` label, unless the other side is a `.length` or `.size`.
 *
 * Added lines in test files are exempt, so a regression test that replays the payload is fine.
 */

export interface LiteralHit {
  path: string;
  line: string;
  value: string | number;
}

const MIN_EXACT = 2;
const MIN_CONTAINS = 4;

const TEST_FILE =
  /(^|\/)(test|tests|__tests__|spec|specs)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test\.[cm]?[jt]sx?$/;

export const isTestFile = (path: string): boolean => TEST_FILE.test(path);

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

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#|<!--)/;

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

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function comparesNumber(raw: string, n: number): boolean {
  // `id === '2'` special-cases the number 2 as much as `id === 2` does.
  const line = raw.replace(/(['"`])(-?\d+(?:\.\d+)?)\1/g, '$2');
  const num = `-?${escapeRe(String(n))}(?![\\w.])`;
  const op = '(?:===|!==|==|!=)';
  const after = new RegExp(`([\\w$.\\]\\)]+)\\s*${op}\\s*(?<![\\w.$])${num}`, 'g');
  const before = new RegExp(`(?<![\\w.$])${num}\\s*${op}\\s*([\\w$.]+)`, 'g');
  const lengthLike = (side: string | undefined): boolean => /\.(length|size)$/.test(side ?? '');
  for (const m of line.matchAll(after)) if (!lengthLike(m[1])) return true;
  for (const m of line.matchAll(before)) if (!lengthLike(m[1])) return true;
  return new RegExp(`\\bcase\\s+${num}\\s*:`).test(line);
}

function matchesString(literal: string, value: string): boolean {
  if (literal === value) return true;
  const [short, long] = literal.length <= value.length ? [literal, value] : [value, literal];
  return short.length >= MIN_CONTAINS && long.includes(short);
}

/** The added lines that special-case a witness value. Empty means the rule passes. */
export function findLiteralSpecialCases(
  lines: readonly DiffLine[],
  params: ParamSpace,
): LiteralHit[] {
  const { strings, numbers } = paramLiterals(params);
  const hits: LiteralHit[] = [];
  for (const { path, text } of lines) {
    if (isTestFile(path) || COMMENT_LINE.test(text)) continue;
    const literals = stringLiterals(text);
    const value =
      strings.find(
        (s) =>
          literals.some((l) => matchesString(l, s)) ||
          (s.length >= MIN_CONTAINS && text.includes(s)),
      ) ?? numbers.find((n) => comparesNumber(text, n));
    if (value !== undefined) hits.push({ path, line: text, value });
  }
  return hits;
}
