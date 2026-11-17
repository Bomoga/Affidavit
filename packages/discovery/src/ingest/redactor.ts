import { inspect } from 'node:util';

/** Values shorter than this are only replaced where gitleaks found them, never everywhere. */
export const GLOBAL_MIN_BYTES = 8;

export interface MapEntry {
  id: number;
  ruleId: string;
  /** The secret bytes, or (exact false) the whole lines that hold it. */
  value: Buffer;
  /** False when the value is the whole line(s) because the region could not be trusted. */
  exact: boolean;
  scope: 'global' | 'located';
  placeholder: string;
  /** Where gitleaks found it: repo-relative path and 1-based line range. */
  locations: { file: string; startLine: number; endLine: number }[];
}

const SAFE_RULE = /[^A-Za-z0-9_.-]/g;

export function placeholderFor(ruleId: string, n: number): string {
  return `[REDACTED:${ruleId.replace(SAFE_RULE, '_').slice(0, 64) || 'secret'}:${n}]`;
}

const INTERNAL = new WeakMap<SecretRedactor, readonly MapEntry[]>();

/**
 * The raw entries (values included) of a redactor, for the workspace build and the leak check.
 * Exported from this module only: index.ts does not re-export it, so nothing reachable from
 * IngestOk exposes a value.
 */
export function entriesOf(r: SecretRedactor): readonly MapEntry[] {
  return INTERNAL.get(r) ?? [];
}

/**
 * The redaction map: every secret value ingestion found, in memory only. It never serialises its
 * values: JSON.stringify gives a count, and util.inspect (console.log) prints a stub, so a result
 * object that holds one cannot leak through logging.
 */
export class SecretRedactor {
  // #private: spread, Object.entries, structuredClone and postMessage cannot copy these.
  readonly #entries: readonly MapEntry[];
  readonly #globals: readonly MapEntry[];

  constructor(entries: readonly MapEntry[]) {
    this.#entries = entries;
    INTERNAL.set(this, entries);
    // longest first, so a secret that contains another is replaced as a whole
    this.#globals = entries
      .filter((e) => e.scope === 'global')
      .sort((a, b) => b.value.length - a.value.length);
  }

  get size(): number {
    return this.#entries.length;
  }

  /**
   * Replaces every global value in a string with its placeholder. For any text derived from the
   * repo that is not a workspace file: paths, messages, log lines. Located (short) values are not
   * applied here because their location is unknown.
   */
  apply(text: string): string {
    let out = text;
    for (const e of this.#globals) {
      const needle = e.value.toString('utf8');
      if (needle.length > 0 && out.includes(needle)) out = out.split(needle).join(e.placeholder);
    }
    return out;
  }

  /** Like apply, with a replacement that is legal in a file name on every platform. */
  applyPath(path: string): string {
    let out = path;
    for (const e of this.#globals) {
      const needle = e.value.toString('utf8');
      if (needle.length > 0 && out.includes(needle)) {
        out = out.split(needle).join(`REDACTED-${e.id}`);
      }
    }
    return out;
  }

  toJSON(): { redactedValues: number } {
    return { redactedValues: this.#entries.length };
  }

  [inspect.custom](): string {
    return `SecretRedactor { redactedValues: ${this.#entries.length} }`;
  }
}

function lineStarts(buf: Buffer): number[] {
  const starts = [0];
  let i = buf.indexOf(0x0a);
  while (i !== -1) {
    starts.push(i + 1);
    i = buf.indexOf(0x0a, i + 1);
  }
  return starts;
}

export interface Region {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/**
 * Reads the secret out of a file by a gitleaks region. Probed on the pinned gitleaks (v8.30.1):
 * columns count BYTES, the end column is inclusive, and on the first line of the file columns are
 * 1-based while on every later line they come out one higher (gitleaks counts the newline). Lines
 * split on LF only, so a CRLF file keeps its CR inside the value, as gitleaks matched it.
 *
 * Returns undefined when the region does not fit the file. Callers then fall back to whole lines.
 */
export function extractRegion(buf: Buffer, r: Region): Buffer | undefined {
  const starts = lineStarts(buf);
  if (r.startLine < 1 || r.endLine < r.startLine || r.endLine > starts.length) return undefined;
  const lineEnd = (line: number): number => (starts[line] ?? buf.length + 1) - 1; // index of its LF
  const shift = (line: number): number => (line === 1 ? 1 : 2);
  const from = (starts[r.startLine - 1] ?? 0) + r.startColumn - shift(r.startLine);
  const to = (starts[r.endLine - 1] ?? 0) + r.endColumn - shift(r.endLine) + 1; // exclusive
  const startLineBegin = starts[r.startLine - 1] ?? 0;
  if (r.startColumn < shift(r.startLine) || r.endColumn < shift(r.endLine) || from < startLineBegin)
    return undefined;
  if (from >= to || to > buf.length) return undefined;
  if (from > lineEnd(r.startLine) || to - 1 > lineEnd(r.endLine)) return undefined;
  return buf.subarray(from, to);
}

/** The text of whole lines startLine..endLine (1-based), without the final line break. */
export function extractLines(buf: Buffer, startLine: number, endLine: number): Buffer | undefined {
  const starts = lineStarts(buf);
  if (startLine < 1 || endLine < startLine || endLine > starts.length) return undefined;
  const from = starts[startLine - 1] ?? 0;
  let to = endLine < starts.length ? (starts[endLine] ?? buf.length) - 1 : buf.length;
  if (to > from && buf[to - 1] === 0x0d) to -= 1;
  if (to <= from) return undefined;
  return buf.subarray(from, to);
}

export function lineOf(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export interface FileRedaction {
  buf: Buffer;
  /** One per replaced occurrence. */
  hits: { entry: MapEntry; startLine: number; endLine: number }[];
}

function count(buf: Buffer, byte: number): number {
  let n = 0;
  for (const b of buf) if (b === byte) n++;
  return n;
}

/**
 * Rewrites a file's bytes: every global value everywhere, every located value only on the lines
 * gitleaks reported for this file. A replacement keeps the number of line breaks, so line numbers
 * after it do not move (the placeholder is followed by the lost newlines).
 */
export function redactBuffer(
  rel: string,
  input: Buffer,
  entries: readonly MapEntry[],
): FileRedaction {
  let buf = input;
  const hits: FileRedaction['hits'] = [];
  const order = [...entries].sort((a, b) => b.value.length - a.value.length);
  for (const e of order) {
    let window: { from: number; to: number }[] | undefined;
    if (e.scope === 'located') {
      const here = e.locations.filter((l) => l.file === rel);
      if (here.length === 0) continue;
      const starts = lineStarts(buf);
      window = here.map((l) => ({
        from: starts[l.startLine - 1] ?? 0,
        to: starts[l.endLine] ?? buf.length,
      }));
    }
    const pieces: Buffer[] = [];
    const nl = count(e.value, 0x0a);
    const repl = Buffer.from(e.placeholder + '\n'.repeat(nl), 'utf8');
    let pos = 0;
    let at = buf.indexOf(e.value, 0);
    let starts: number[] | undefined;
    while (at !== -1) {
      const end = at + e.value.length;
      if (window && !window.some((w) => at >= w.from && end <= w.to)) {
        at = buf.indexOf(e.value, at + 1);
        continue;
      }
      starts ??= lineStarts(buf);
      hits.push({ entry: e, startLine: lineOf(starts, at), endLine: lineOf(starts, end - 1) });
      pieces.push(buf.subarray(pos, at), repl);
      pos = end;
      at = buf.indexOf(e.value, end);
    }
    if (pieces.length > 0) {
      pieces.push(buf.subarray(pos));
      buf = Buffer.concat(pieces);
    }
  }
  return { buf, hits };
}

/** True if the bytes hold a UTF-16LE encoding of an ASCII-or-BMP value in any entry. */
export function holdsUtf16(buf: Buffer, entries: readonly MapEntry[]): boolean {
  for (const e of entries) {
    if (e.scope !== 'global' || !e.exact) continue;
    const text = e.value.toString('utf8');
    if (Buffer.from(text, 'utf8').equals(e.value) && buf.includes(Buffer.from(text, 'utf16le'))) {
      return true;
    }
  }
  return false;
}
