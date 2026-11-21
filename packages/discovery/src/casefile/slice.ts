/**
 * Slice hygiene (L1-07). A slice is repo text an agent will read, so it is untrusted data. Before
 * it leaves discovery:
 * - every comment is blanked (spaces, newlines kept so line numbers still match the file);
 * - every string, template or JSX text fragment that reads like prose (three or more words made
 *   of letters) is replaced by a fixed marker; code-like strings (`this.userId == `, `/login`,
 *   `utf8`) are kept, because a witness may need them;
 * - control, bidirectional and invisible format characters are written as `\u{...}` escapes;
 * - the ingestion redactor (when given) is applied once more.
 * A file that does not parse cleanly, or that cannot be parsed in budget, is withheld: its slice
 * carries a fixed marker instead of code. Nothing here runs repo code.
 */
import type { Slice } from '@affidavit/contracts';
import { grammarFor, initParser, lexicalSpans } from '../map/parse.js';

/** What replaces a prose string. Fixed text, so nothing from the repo reaches it. */
export const PROSE_MARKER = '[text removed]';
/** The whole slice when the file could not be cleaned safely. */
export const WITHHELD_MARKER = '/* slice withheld: the file did not parse cleanly */';

const WORD = /^[\p{L}][\p{L}'\u2019-]*[.,:;!?)"]*$/u;

/** True for text that reads like a sentence or an instruction, not code. */
export function isProse(s: string): boolean {
  let words = 0;
  for (const tok of s.split(/\s+/)) {
    if (WORD.test(tok.replace(/^[("']+/, ''))) words++;
    if (words >= 3) return true;
  }
  return false;
}

const UNSAFE_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]/g;

/** Control, bidirectional and invisible characters become visible escapes (tab and newline stay). */
export function escapeInvisible(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(UNSAFE_CHARS, (ch) => `\\u{${(ch.codePointAt(0) ?? 0).toString(16)}}`);
}

/** Keeps every newline so the cleaned text has the same line count as the original. */
const blank = (s: string): string => s.replace(/[^\n]/g, ' ');
const marker = (s: string): string => PROSE_MARKER + '\n'.repeat(s.split('\n').length - 1);

export interface CleanFile {
  /** The cleaned text, line-aligned with the original, or undefined when withheld. */
  text: string | undefined;
  commentsRemoved: number;
  proseRemoved: number;
}

/** Cleans a whole file (so comments and strings are found with full context). */
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
  for (const sp of res.spans) {
    if (sp.start < at) continue;
    const piece = text.slice(sp.start, sp.end);
    out += text.slice(at, sp.start);
    if (sp.kind === 'comment') {
      out += blank(piece);
      commentsRemoved++;
    } else if (isProse(piece)) {
      out += marker(piece);
      proseRemoved++;
    } else {
      out += piece;
    }
    at = sp.end;
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
