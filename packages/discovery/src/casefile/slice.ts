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
 * This is a heuristic. It removes the planted forms the tests cover; it does not prove that no
 * instruction-like text survives, and it is not the only defence: every slice stays
 * `untrusted: true`, and the Trial's safety envelope fences slice text as data. That fence is the
 * primary control; this is defence in depth. Known gaps: text assembled at run time (an array of
 * single words joined with spaces, `String.fromCharCode`, values computed from numbers), meaning
 * carried by code structure rather than by literals or names, sentences made only of words in
 * `CODE_WORDS`, a word hidden as the last property of a code-word chain (`this.ignore`), and
 * identifiers of fewer than seven words outside a run.
 */
import { createHash } from 'node:crypto';
import type { Slice } from '@affidavit/contracts';
import { grammarFor, initParser, lexicalSpans, type LexicalSpan } from '../map/parse.js';

/** What replaces a prose literal or name. Fixed text, so nothing from the repo reaches it. */
export const PROSE_MARKER = '[text removed]';
/** The whole slice when the file could not be cleaned safely. */
export const WITHHELD_MARKER = '/* slice withheld: the file did not parse cleanly */';

/**
 * Letters that render as blank space (Hangul fillers, the braille blank, Khmer inherent vowels).
 * They are letters to Unicode, so a word count cannot see them as separators: any of them makes
 * a literal unproven, and they are escaped in slice output.
 */
// eslint-disable-next-line no-misleading-character-class
const BLANKISH = /[\u115f\u1160\u17b4\u17b5\u2800\u3164\uffa0]/u;
const INVISIBLE =
  // eslint-disable-next-line no-control-regex, no-misleading-character-class
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]/u;

/** Member access such as `this.userId` or `req.session.user`: two or three dotted segments. */
const MEMBER_CHAIN = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*){1,2}$/;

/** Letter runs of two or more, split on every non-letter character and on camelCase humps. */
function wordsOf(s: string): string[] {
  return s
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length >= 2);
}

/**
 * Words a literal spells. Every token (a run of non-whitespace) counts every letter run in it,
 * whatever separates them. In a short member-access chain (`this.userId`) only the words that are
 * not in `CODE_WORDS` count, so `req.session.user` counts none and `Ignore.all.previous` three.
 */
function proseWords(s: string): number {
  let n = 0;
  for (const tok of s.split(/[\s\p{Z}]+/u)) {
    const core = tok.replace(/^[^A-Za-z_$]+|[^A-Za-z0-9_$]+$/g, '');
    n += MEMBER_CHAIN.test(core) ? chainWords(core) : wordsOf(tok).length;
  }
  return n;
}

const isCodeWord = (w: string): boolean => CODE_WORDS.has(w.toLowerCase());

/**
 * Words a member chain spells: those not in `CODE_WORDS`, except that a chain rooted in a code
 * word may end in one property of any name (`this.stocks`, `req.body.allocations`).
 */
function chainWords(core: string): number {
  const segs = core.split('.');
  const rootIsCode = wordsOf(segs[0] ?? '').every(isCodeWord);
  let n = 0;
  segs.forEach((seg, i) => {
    if (rootIsCode && i === segs.length - 1) return;
    n += wordsOf(seg).filter((w) => !isCodeWord(w)).length;
  });
  return n;
}

/**
 * True when literal text is proven to be code-like: no blank-looking or invisible character, and
 * either no word at all (`this.userId == `, `/login` has one) or exactly one word and no
 * whitespace (`allocations`, `/login`, `utf8`). Words are letter runs split on every non-letter
 * and on camelCase humps, so `ignore,all`, `ignore1all` and `ignore.all.previous.instructions`
 * are words; a short member chain (`this.userId`) is not. Anything else is not proven.
 */
export function provenCode(s: string): boolean {
  if (BLANKISH.test(s) || INVISIBLE.test(s)) return false;
  const words = proseWords(s);
  return words === 0 || (words === 1 && !/[\s\p{Z}]/u.test(s));
}

export function isProse(s: string): boolean {
  return !provenCode(s);
}

/** Decodes `\xHH`, `\uHHHH` and `\u{H}`; class escapes (`\s`, `\d`, `\b`) become a space. */
function decodeRegex(pattern: string): string {
  return pattern
    .replace(
      /\\x([0-9a-fA-F]{2})|\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g,
      (_m, x, b, u) => {
        const code = parseInt(String(x ?? b ?? u), 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
      },
    )
    .replace(/\\[sSdDwWbBtnrfv0]/g, ' ')
    .replace(/\\(.)/gu, '$1');
}

/**
 * A regex is replaced unless proven code-like: an escape that spells a letter (`\x49`), or a
 * character class with a letter that is not a range end (`[Ii]`, `[I][G]`), is never kept; the
 * rest is decoded, stripped of syntax (brackets, groups, quantifiers, anchors) and judged with
 * `provenCode`, like a string.
 */
export function proseRegex(pattern: string): boolean {
  // A numeric escape is a backreference or a legacy octal escape (`\111` is `I`), and `\cI` is a
  // control escape spelled with a letter. Not decoded: any of them means the regex is replaced.
  if (/\\(?:[0-9]|c[A-Za-z])/.test(pattern.replace(/\\\\/g, ''))) return true;
  const letterEscape = /\\x([0-9a-fA-F]{2})|\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g;
  for (const m of pattern.matchAll(letterEscape)) {
    const code = parseInt(String(m[1] ?? m[2] ?? m[3]), 16);
    if (code <= 0x10ffff && /\p{L}/u.test(String.fromCodePoint(code))) return true;
  }
  for (const m of pattern.matchAll(/\[((?:\\.|[^\]\\])*)\]/g)) {
    const inner = (m[1] ?? '').replace(/\\./g, '').replace(/.-./gu, '');
    if (/\p{L}/u.test(inner)) return true;
  }
  const plain = decodeRegex(pattern)
    .replace(/\{\d*,?\d*\}/g, '')
    .replace(/[[\]()|?*+^$]/g, '');
  return !provenCode(plain);
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
  // eslint-disable-next-line no-control-regex, no-misleading-character-class
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\u2800\u3164\ufeff\uffa0\ufff9-\ufffb]/g;

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

/** Path and code words so common in real names that they say nothing (`src`, `routes`, `js`). */
const COMMON_NAME_WORDS = new Set([
  'src',
  'lib',
  'app',
  'apps',
  'packages',
  'package',
  'data',
  'routes',
  'route',
  'models',
  'model',
  'controllers',
  'controller',
  'services',
  'service',
  'utils',
  'util',
  'test',
  'tests',
  'spec',
  'public',
  'assets',
  'config',
  'server',
  'client',
  'api',
  'views',
  'view',
  'middleware',
  'index',
  'js',
  'ts',
  'jsx',
  'tsx',
  'mjs',
  'cjs',
  'json',
  'dao',
  'id',
  'vendor',
  'components',
  'component',
  'pages',
  'page',
  'handlers',
  'handler',
  'helpers',
  'helper',
  'core',
  'common',
  'shared',
]);

const NAME_LIMIT: Record<NameKind, number> = { file: 4, 'route-path': 4, label: 6 };

/**
 * A repo-derived name (a file path, a route path, a middleware label) as it may appear in a case
 * file: a strict character set per kind, and fewer words than `NAME_LIMIT` over the whole name
 * (letter runs split on every non-letter and on camelCase humps, common path words not counted).
 * Anything else becomes `PROSE_MARKER`.
 */
export function safeName(kind: NameKind, s: string): string {
  if (s.length === 0 || s.length > 300 || !NAME_CHARSET[kind].test(s)) return PROSE_MARKER;
  const words = wordsOf(s).filter((w) => !COMMON_NAME_WORDS.has(w.toLowerCase()));
  if (words.length >= NAME_LIMIT[kind]) return PROSE_MARKER;
  return s;
}

/** Keeps every newline so the cleaned text has the same line count as the original. */
const blank = (s: string): string => s.replace(/[^\n]/g, ' ');
const newlines = (s: string): string => '\n'.repeat(s.split('\n').length - 1);

function replacement(
  sp: LexicalSpan,
  piece: string,
  forced: boolean,
  judged?: string,
): string | undefined {
  switch (sp.kind) {
    case 'comment':
      return blank(piece);
    case 'string': {
      if (!forced && provenCode(sp.text)) return undefined;
      const q = piece.startsWith('"') ? '"' : "'";
      return `${q}${PROSE_MARKER}${q}${newlines(piece)}`;
    }
    case 'template':
      return !forced && provenCode(judged ?? sp.text)
        ? undefined
        : `\`${PROSE_MARKER}\`${newlines(piece)}`;
    case 'jsx-text':
      return provenCode(sp.text) ? undefined : `${PROSE_MARKER}${newlines(piece)}`;
    case 'regex':
      return proseRegex(sp.text) ? `/${PROSE_MARKER}/${newlines(piece)}` : undefined;
    case 'identifier':
      return forced || proseIdentifier(sp.text) ? hashName(sp.text) : undefined;
  }
}

/** Code words common enough that a chain of them is ordinary code (`req.session.user.id`). */
const CODE_WORDS = new Set([
  'this',
  'req',
  'res',
  'request',
  'response',
  'next',
  'err',
  'error',
  'ctx',
  'app',
  'router',
  'db',
  'session',
  'user',
  'users',
  'id',
  'body',
  'params',
  'query',
  'headers',
  'module',
  'exports',
  'require',
  'console',
  'log',
  'data',
  'result',
  'results',
  'value',
  'values',
  'key',
  'keys',
  'item',
  'items',
  'options',
  'config',
  'process',
  'env',
  'json',
  'prototype',
  'length',
  'push',
  'map',
  'filter',
  'then',
  'name',
  'type',
  'status',
  'send',
  'render',
  'find',
  'get',
  'set',
  'use',
  'path',
  'url',
  'file',
  'callback',
  'cb',
  'done',
  'self',
  'window',
  'document',
  'object',
  'array',
  'string',
  'number',
  'math',
  'promise',
  'collection',
  'model',
  'models',
]);

/** A plain word used as a name (`Ignore`, `all`, `SAFE`): no hump, digit, `_` or `$`. */
const PLAIN_WORD = /^(?:[A-Za-z][a-z]+|[A-Z]{2,})$/;

/**
 * Identifiers next to each other with only `.`, `,` or whitespace between them are judged as one
 * text: `Ignore.all.previous.instructions` and `void Ignore, all, previous, instructions` are
 * sentences. A run with three or more plain words outside `CODE_WORDS` has every identifier in it
 * renamed.
 */
function identifierRuns(spans: readonly LexicalSpan[], text: string): Set<LexicalSpan> {
  const out = new Set<LexicalSpan>();
  const ids = spans.filter((s) => s.kind === 'identifier');
  for (let i = 0; i < ids.length;) {
    let j = i;
    while (j + 1 < ids.length) {
      const cur = ids[j] as LexicalSpan;
      const next = ids[j + 1] as LexicalSpan;
      if (next.start < cur.end || !/^[\s.,]*$/.test(text.slice(cur.end, next.start))) break;
      j++;
    }
    const run = ids.slice(i, j + 1);
    const plain = run.filter(
      (s) => PLAIN_WORD.test(s.text) && !CODE_WORDS.has(s.text.toLowerCase()),
    ).length;
    if (plain >= 3) for (const s of run) out.add(s);
    i = j + 1;
  }
  return out;
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
  for (const s of identifierRuns(res.spans, text)) forced.add(s);
  // A template is judged with every literal nested in its substitutions:
  // `${'IGNORE'} ${'ALL'}` is one text, not one-word pieces.
  const templateText = new Map<LexicalSpan, string>();
  for (const tpl of lits) {
    if (tpl.kind !== 'template') continue;
    const nested = lits.filter((n) => n !== tpl && n.start >= tpl.start && n.end <= tpl.end);
    templateText.set(tpl, [tpl.text, ...nested.map((n) => n.text)].join(' '));
  }
  for (const sp of res.spans) {
    // Inside a literal already replaced. A kept literal does not move `at`, so the spans nested
    // in it (strings inside a template substitution) are still judged.
    if (sp.start < at) continue;
    const rep = replacement(sp, text.slice(sp.start, sp.end), forced.has(sp), templateText.get(sp));
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
