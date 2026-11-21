/**
 * Slice hygiene (L1-07). A slice is repo text an agent will read, so it is untrusted data. Before
 * it leaves discovery:
 * - every comment is blanked (spaces, newlines kept so line numbers still match the file);
 * - every string, template, regex or JSX text literal is kept only when it is proven to be code
 *   (`provenCode`: no letter-only word, or one word with no whitespace, judged on the whole
 *   decoded literal, so text split across template fragments or written with escape sequences
 *   is judged as one); anything else is replaced by a fixed marker;
 * - an identifier made of many words (`proseIdentifier`) is renamed to a stable hash name;
 * - control, bidirectional and invisible format characters are written as escapes;
 * - the ingestion redactor (when given) is applied once more.
 * A file that does not parse cleanly, or that cannot be parsed in budget, is withheld: its slice
 * carries a fixed marker instead of code. Nothing here runs repo code.
 *
 * This is a heuristic and is not the only defence: every slice stays `untrusted: true`, and the
 * Trial's safety envelope fences slice text as data. Known gap: text assembled at run time from
 * one-word pieces (an array of single words joined with spaces, `String.fromCharCode`) is not
 * recognised.
 */
import { createHash } from 'node:crypto';
import type { Slice } from '@affidavit/contracts';
import { grammarFor, initParser, lexicalSpans, type LexicalSpan } from '../map/parse.js';

/** What replaces a prose literal or name. Fixed text, so nothing from the repo reaches it. */
export const PROSE_MARKER = '[text removed]';
/** The whole slice when the file could not be cleaned safely. */
export const WITHHELD_MARKER = '/* slice withheld: the file did not parse cleanly */';

const WORD = /^[\p{L}][\p{L}'\u2019-]*[.,:;!?)"]*$/u;

function letterWords(s: string): number {
  let words = 0;
  for (const tok of s.split(/\s+/)) if (WORD.test(tok.replace(/^[("'`]+/, ''))) words++;
  return words;
}

/**
 * True when literal text is proven to be code-like: no letter-only word at all (`/login`,
 * `this.userId == `, `utf8`), or a single word with no whitespace (`allocations`). Anything else,
 * a word next to whitespace included (`'ignore '`), is not proven.
 */
export function provenCode(s: string): boolean {
  const words = letterWords(s);
  if (!(words === 0 || (words === 1 && !/\s/u.test(s)))) return false;
  // A slug or path that spells a sentence (`./ignore-all-previous-instructions`) is not code.
  for (const tok of s.split(/\s+/)) {
    for (const part of tok.split('/')) {
      if (part.split(/[_\-.]+/).filter((w) => /^\p{L}{2,}$/u.test(w)).length >= 4) return false;
    }
  }
  return true;
}

/** True for text that reads like a sentence or an instruction (the negation of `provenCode`). */
export function isProse(s: string): boolean {
  return !provenCode(s);
}

/** A regex pattern that spells words: three or more runs of three or more letters. */
export function proseRegex(pattern: string): boolean {
  return (pattern.match(/\p{L}{3,}/gu) ?? []).length >= 3;
}

/** Words in a name: camelCase humps and `_`, `-`, `.`, `$` separated parts. */
function nameWords(s: string): string[] {
  return s
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2')
    .split(/[\s_\-.$]+/u)
    .filter((w) => /^\p{L}{2,}$/u.test(w));
}

/** An identifier with seven or more words reads like a sentence. */
export function proseIdentifier(name: string): boolean {
  return nameWords(name).length >= 7;
}

const hashName = (name: string): string =>
  `_x${createHash('sha256').update(name).digest('hex').slice(0, 10)}`;

const UNSAFE_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]/g;

/** Control, bidirectional and invisible characters become visible escapes (tab and newline stay). */
export function escapeInvisible(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(UNSAFE_CHARS, (ch) => `\\u{${(ch.codePointAt(0) ?? 0).toString(16)}}`);
}

export type NameKind = 'file' | 'route-path' | 'label';

const NAME_CHARSET: Record<NameKind, RegExp> = {
  file: /^[A-Za-z0-9/._@+-]+$/,
  'route-path': /^[A-Za-z0-9/:._~*${}()+@!,;=-]+$/,
  label: /^[A-Za-z0-9_$.()]+$/,
};

/**
 * A repo-derived name (a file path, a route path, a middleware label) as it may appear in a case
 * file: a strict character set per kind, no part with four or more `-`, `_` or `.` separated
 * words and no part with seven or more words in all. Anything else becomes `PROSE_MARKER`.
 */
export function safeName(kind: NameKind, s: string): string {
  if (s.length === 0 || s.length > 300 || !NAME_CHARSET[kind].test(s)) return PROSE_MARKER;
  for (const part of s.split('/')) {
    const plain = part.split(/[_\-.]+/).filter((w) => /^[A-Za-z]{2,}$/.test(w));
    if (plain.length >= 4 || nameWords(part).length >= 7) return PROSE_MARKER;
  }
  return s;
}

/** Keeps every newline so the cleaned text has the same line count as the original. */
const blank = (s: string): string => s.replace(/[^\n]/g, ' ');
const newlines = (s: string): string => '\n'.repeat(s.split('\n').length - 1);

function replacement(sp: LexicalSpan, piece: string, forced: boolean): string | undefined {
  switch (sp.kind) {
    case 'comment':
      return blank(piece);
    case 'string': {
      if (!forced && provenCode(sp.text)) return undefined;
      const q = piece.startsWith('"') ? '"' : "'";
      return `${q}${PROSE_MARKER}${q}${newlines(piece)}`;
    }
    case 'template':
      return !forced && provenCode(sp.text) ? undefined : `\`${PROSE_MARKER}\`${newlines(piece)}`;
    case 'jsx-text':
      return provenCode(sp.text) ? undefined : `${PROSE_MARKER}${newlines(piece)}`;
    case 'regex':
      return proseRegex(sp.text) ? `/${PROSE_MARKER}/${newlines(piece)}` : undefined;
    case 'identifier':
      return proseIdentifier(sp.text) ? hashName(sp.text) : undefined;
  }
}

export interface CleanFile {
  /** The cleaned text, line-aligned with the original, or undefined when withheld. */
  text: string | undefined;
  commentsRemoved: number;
  proseRemoved: number;
}

/** Cleans a whole file (so comments and literals are found with full context). */
export async function cleanSource(
  path: string,
  text: string,
  maxParseMillis = 5_000,
): Promise<CleanFile> {
  const grammar = grammarFor(path);
  if (!grammar) return { text: undefined, commentsRemoved: 0, proseRemoved: 0 };
  await initParser();
  const res = await lexicalSpans(text, grammar, maxParseMillis);
  if (res === 'timeout' || res === 'failed' || res.syntaxError) {
    return { text: undefined, commentsRemoved: 0, proseRemoved: 0 };
  }
  let out = '';
  let at = 0;
  let commentsRemoved = 0;
  let proseRemoved = 0;
  // Literals joined with `+` are judged together too: `'IGNORE ' + 'ALL ' + 'INSTRUCTIONS'`
  // replaces every piece, the last one-word piece included.
  const forced = new Set<LexicalSpan>();
  const lits = res.spans.filter((s) => s.kind === 'string' || s.kind === 'template');
  for (let i = 0; i < lits.length;) {
    let j = i;
    while (j + 1 < lits.length) {
      const cur = lits[j] as LexicalSpan;
      const next = lits[j + 1] as LexicalSpan;
      if (next.start < cur.end || !/^\s*\+\s*$/.test(text.slice(cur.end, next.start))) break;
      j++;
    }
    if (j > i) {
      const group = lits.slice(i, j + 1);
      if (!provenCode(group.map((g) => g.text).join(''))) for (const g of group) forced.add(g);
    }
    i = j + 1;
  }
  for (const sp of res.spans) {
    // Inside a literal already replaced. A kept literal does not move `at`, so the spans nested
    // in it (strings inside a template substitution) are still judged.
    if (sp.start < at) continue;
    const rep = replacement(sp, text.slice(sp.start, sp.end), forced.has(sp));
    if (rep === undefined) continue;
    out += text.slice(at, sp.start) + rep;
    at = sp.end;
    if (sp.kind === 'comment') commentsRemoved++;
    else proseRemoved++;
  }
  out += text.slice(at);
  return { text: out, commentsRemoved, proseRemoved };
}

export interface SliceOptions {
  /** Applied to the slice text (the ingestion `SecretRedactor.apply`). */
  redact?: ((s: string) => string) | undefined;
}

/**
 * One slice of a cleaned file. Lines are 1-based and inclusive, clipped to the file. Trailing
 * spaces left by a blanked comment are trimmed.
 */
export function sliceOf(
  file: string,
  clean: CleanFile,
  range: { startLine: number; endLine: number },
  options: SliceOptions = {},
): Slice {
  if (clean.text === undefined) {
    return {
      file,
      range,
      code: WITHHELD_MARKER,
      strippedComments: true,
      untrusted: true,
    };
  }
  const lines = clean.text.split('\n');
  const startLine = Math.max(1, Math.min(range.startLine, lines.length));
  const endLine = Math.max(startLine, Math.min(range.endLine, lines.length));
  let code = lines
    .slice(startLine - 1, endLine)
    .map((l) => l.replace(/[ \t\r]+$/, ''))
    .join('\n');
  if (options.redact) code = options.redact(code);
  return {
    file,
    range: { startLine, endLine },
    code: escapeInvisible(code),
    strippedComments: true,
    untrusted: true,
  };
}
