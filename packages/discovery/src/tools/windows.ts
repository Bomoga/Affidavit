import { lstat, mkdir, open, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { classifyHead, neutralArchiveName, signatureClass } from './unscannable.js';
import { NonUtf8NameError } from './walk.js';
import { listDir } from './walk.js';

/**
 * gitleaks reads a file in chunks of 100,000 bytes and cuts them at blank lines or at a hard
 * limit, which can split a secret (a PEM key, a keyword and value separated by a blank line, a
 * token on a cut). Modelling those cuts took many review rounds. Instead, for every plain text
 * file over 100,000 bytes, the host writes overlapping windows that are each UNDER 100,000 bytes
 * into a separate directory and runs gitleaks on that too. gitleaks reads a file under 100,000
 * bytes in one piece, so there is no cut inside a window.
 *
 * WINDOW_BYTES is 90,000, plus a short neutral first line (see WINDOW_PREFIX), so a window is
 * still under 100,000 bytes. Consecutive windows overlap by at least OVERLAP_BYTES, 16,000, so any
 * stretch of up to 16,000 contiguous bytes lies wholly inside at least one window. That is enough
 * for a 4096-bit PEM key (about 3.4 KB with headers and line breaks), a PGP private key block (a
 * few KB) and every keyword-and-value rule, whose parts are within a few hundred bytes of each
 * other. Longer secrets are the remaining gap, covered only by the private-key and chunk checks in
 * unscannable.ts, which stay as defence in depth.
 *
 * Windows start and end on line boundaries when a line is short enough; otherwise they are cut
 * mid-line with the same overlap, always on a UTF-8 character boundary, and the window records how
 * far into its first line it starts, in bytes. Each window records the line number of its first
 * byte so findings can be mapped back.
 *
 * Three things protect a window from being skipped or mis-scanned:
 *  - gitleaks decides text or binary from a file's first bytes. A window that happens to start with
 *    `MZ` or `%PDF` would be skipped. So every window starts with a neutral first line, and the
 *    host also checks each window with the same signature table afterwards (offset signatures such
 *    as `ustar` at 257 can still match), reporting any hit.
 *  - Rules that match on the file path (kubernetes-secret-yaml, hashicorp-tf-password, ...) need
 *    the real name, so a window is written at `wNNNN/pNNNN/<original path>`. The neutral
 *    directories are generated and are what the mapping back uses, so a repo file name cannot
 *    forge or collide with another window.
 *  - gitleaks drops a plain text file whose NAME looks like an archive (`a.gz`, `a.zip.js`). Such
 *    files, of any size, are windowed too, with the archive tokens in the name neutralised
 *    (`a.gz.yaml` becomes `a._gz.yaml`, final extension kept), so they are scanned.
 */
export const WINDOW_BYTES = 90_000;
export const OVERLAP_BYTES = 16_000;
/** First line of every window. The original line numbers are shifted by exactly one line. */
export const WINDOW_PREFIX = '# affidavit window\n';
/**
 * Only cut at a line boundary if the window is at least this long. With this, the next window
 * starts at least 34,000 bytes later in the worst case (a window of 70,000 bytes whose start is
 * moved back to a line start 20,000 bytes before the target), and typically 74,000.
 */
const MIN_LINE_ALIGNED = 70_000;
const MAX_ALIGN_BACK = 20_000;
export const BIG_FILE = 100_000;
/**
 * Hard upper bound on the bytes of windows written in one run, counted as they are written (a file
 * that would cross it stops there and is reported). Windows duplicate every large text file about
 * 1.2 times, so a repo with many large files could otherwise fill the disk and keep gitleaks busy
 * for a very long time. 256 MiB is a safety limit chosen for that reason, not a measured number.
 */
export const MAX_WINDOW_BYTES = 256 * 1024 * 1024;

export interface WindowEntry {
  /** Neutral directory of the window, relative to the windows directory, for example `w0001/p0002`. */
  name: string;
  /** Original file, relative to the snapshot, posix separators. */
  original: string;
  /** Line number in the original file of the first byte of this window (1-based). */
  startLine: number;
  /** Bytes between the start of that line and the first byte of this window (0 at a line start). */
  startColumn: number;
}

/** Throws unless `value` is a finite number of at least 0 (NaN and Infinity are refused, not "unlimited"). */
export function assertMaxWindowBytes(value: number | undefined): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `maxWindowBytes must be a finite number of at least 0, got ${String(value)}`,
    );
  }
}

export class WindowsDirNotFreshError extends Error {
  constructor(dir: string) {
    super(`windows directory must exist and be empty before a run: ${dir}`);
    this.name = 'WindowsDirNotFreshError';
  }
}

export interface WindowsResult {
  entries: WindowEntry[];
  /** Files not (fully) windowed because the byte budget ran out. */
  skippedForBudget: string[];
  /** Files that could not be windowed because writing failed (for example a path too long). */
  failed: { original: string; why: string }[];
  /** Bytes of windows written. */
  bytes: number;
}

function countNewlines(buf: Uint8Array): number {
  let n = 0;
  let i = buf.indexOf(0x0a);
  while (i >= 0) {
    n++;
    i = buf.indexOf(0x0a, i + 1);
  }
  return n;
}

/** True for a UTF-8 continuation byte (10xxxxxx). */
const isContinuation = (b: number | undefined): boolean => b !== undefined && (b & 0xc0) === 0x80;

/**
 * Backs a window end off so it does not split a UTF-8 character (at most 3 bytes). `len` is the
 * proposed end inside `buf`; the file is known to continue after it.
 */
function trimToCharBoundary(buf: Uint8Array, len: number): number {
  for (let back = 1; back <= 3 && back <= len; back++) {
    const b = buf[len - back];
    if (b === undefined) break;
    if ((b & 0xc0) !== 0x80) {
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
      return need > back ? len - back : len;
    }
  }
  return len;
}

/** Cuts one file into windows, calling `emit` for each. Streams with one window-sized buffer. */
export async function windowFile(
  file: string,
  size: number,
  emit: (bytes: Buffer, startLine: number, startColumn: number) => Promise<void>,
): Promise<void> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(WINDOW_BYTES);
    let start = 0;
    let line = 1; // number of newlines before `start`, plus one
    let col = 0; // bytes from the start of that line to `start`
    for (;;) {
      const { bytesRead: n } = await fh.read(buf, 0, WINDOW_BYTES, start);
      if (n === 0) return;
      const last = start + n >= size;
      let wlen = n;
      if (!last) {
        const nl = buf.subarray(0, n).lastIndexOf(0x0a);
        if (nl + 1 >= MIN_LINE_ALIGNED) wlen = nl + 1;
        else wlen = trimToCharBoundary(buf, n);
      }
      await emit(Buffer.from(buf.subarray(0, wlen)), line, col);
      if (last && wlen === n) return;
      // The next window starts at a line start at or before (end - overlap), so the overlap is at
      // least OVERLAP_BYTES. Aligning to a line start may move the start back by at most
      // MAX_ALIGN_BACK bytes; otherwise the start is mid-line, at the target, moved back (at most 3
      // bytes) to a UTF-8 character boundary.
      const target = wlen - OVERLAP_BYTES;
      const nlBefore = buf.subarray(0, Math.max(target, 0)).lastIndexOf(0x0a);
      let nextRel: number;
      if (nlBefore >= 0 && nlBefore + 1 >= target - MAX_ALIGN_BACK) {
        nextRel = nlBefore + 1;
      } else {
        nextRel = Math.max(target, 1);
        for (let i = 0; i < 3 && nextRel > 1 && isContinuation(buf[nextRel]); i++) nextRel--;
      }
      const skipped = buf.subarray(0, nextRel);
      line += countNewlines(skipped);
      const lastNl = skipped.lastIndexOf(0x0a);
      col = lastNl < 0 ? col + nextRel : nextRel - (lastNl + 1);
      start += nextRel;
      if (start >= size) return;
    }
  } finally {
    await fh.close();
  }
}

class BudgetStop extends Error {}

export interface WriteWindowsOptions {
  /** Hard cap on window bytes written. Default MAX_WINDOW_BYTES. */
  maxBytes?: number;
  /**
   * Relative paths (posix) of files that already carry a coverage flag. They are windowed first, so
   * a budget that runs out spends itself where the risk is. The rest follow, smallest first, not
   * in the order a repo chose its file names.
   */
  priority?: ReadonlySet<string>;
}

/**
 * Writes windows into `windowsDir`, which must exist and be empty (the caller creates a unique
 * one per run and removes it). Windowed files: plain text files over 100,000 bytes, and files whose
 * name gitleaks reads as an archive although the content is not one (any size). Files with a known
 * binary signature or non-text start are not windowed: gitleaks skips or reads them as a whole.
 * Never follows symlinks. A write error for one file is reported in `failed` and does not stop
 * the others.
 */
export async function writeWindows(
  snapshotDir: string,
  windowsDir: string,
  options: WriteWindowsOptions = {},
): Promise<WindowsResult> {
  assertMaxWindowBytes(options.maxBytes);
  const maxBytes = options.maxBytes ?? MAX_WINDOW_BYTES;
  if ((await readdir(windowsDir)).length > 0) throw new WindowsDirNotFreshError(windowsDir);

  interface Candidate {
    full: string;
    name: string;
    original: string;
    size: number;
  }
  const candidates: Candidate[] = [];
  const failed: { original: string; why: string }[] = [];
  const whyOf = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? String(err);
  const rel = (p: string): string => relative(snapshotDir, p).split(sep).join('/');
  const walk = async (dir: string): Promise<void> => {
    let listing;
    try {
      listing = await listDir(dir);
    } catch (err) {
      if (err instanceof NonUtf8NameError) throw err; // the same policy as every other host walk
      failed.push({ original: rel(dir) || '.', why: whyOf(err) });
      return;
    }
    for (const e of listing) {
      const full = join(dir, e.name);
      if (e.isDirectory) {
        await walk(full);
        continue;
      }
      if (!e.isFile) continue;
      try {
        const st = await lstat(full);
        const fh = await open(full, 'r');
        let head: Buffer;
        try {
          head = Buffer.alloc(BIG_FILE);
          const { bytesRead } = await fh.read(head, 0, BIG_FILE, 0);
          head = head.subarray(0, bytesRead);
        } finally {
          await fh.close();
        }
        const kind = classifyHead(e.name, head);
        const big = st.size > BIG_FILE && kind === undefined;
        // A name gitleaks reads as an archive: plain text or an image is worth windowing under a
        // neutral name. A PDF or executable (any "other" signature) is skipped by gitleaks whatever
        // it is called, and an empty file has nothing to window; neither is windowed, and runTool
        // words their notification as NOT scanned.
        const archiveNamed =
          kind === 'archive-name-mismatch' && st.size > 0 && signatureClass(head) !== 'other';
        if (!big && !archiveNamed) continue;
        candidates.push({ full, name: e.name, original: rel(full), size: st.size });
      } catch (err) {
        // an unreadable file must not lose the whole run: report it and go on
        failed.push({ original: rel(full), why: whyOf(err) });
      }
    }
  };
  await walk(snapshotDir);

  const flagged = options.priority ?? new Set<string>();
  candidates.sort(
    (a, b) =>
      Number(flagged.has(b.original)) - Number(flagged.has(a.original)) ||
      a.size - b.size ||
      a.original.localeCompare(b.original),
  );

  const entries: WindowEntry[] = [];
  const skippedForBudget: string[] = [];
  let bytes = 0;
  let fileNo = 0;
  for (const c of candidates) {
    const sub = `w${String(++fileNo).padStart(4, '0')}`;
    const mine: WindowEntry[] = [];
    let mineBytes = 0;
    let part = 0;
    try {
      await windowFile(c.full, c.size, async (win, startLine, startColumn) => {
        const len = win.length + WINDOW_PREFIX.length;
        if (bytes + len > maxBytes) throw new BudgetStop();
        const name = `${sub}/p${String(++part).padStart(4, '0')}`;
        const segments = c.original.split('/');
        segments[segments.length - 1] = neutralArchiveName(c.name);
        const target = join(windowsDir, name, ...segments);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, Buffer.concat([Buffer.from(WINDOW_PREFIX), win]));
        bytes += len;
        mineBytes += len;
        mine.push({ name, original: c.original, startLine, startColumn });
      });
      entries.push(...mine);
    } catch (err) {
      if (err instanceof BudgetStop) {
        entries.push(...mine); // what was written is still valid; the rest is reported
        skippedForBudget.push(c.original);
      } else {
        // A path that is too long, a full disk, a permission error: report this file and go on.
        // Its windows are removed, so no finding can carry a raw wNNNN path with no entry for it.
        bytes -= mineBytes;
        let why = whyOf(err);
        try {
          await rm(join(windowsDir, sub), { recursive: true, force: true });
        } catch (rmErr) {
          // never let a cleanup error escape as an untyped error; say so in the reason instead
          why += `; removing its partial windows failed (${whyOf(rmErr)})`;
        }
        failed.push({ original: c.original, why });
      }
    }
  }
  return { entries, skippedForBudget, failed, bytes };
}

/** Finds the window a report path belongs to. The path may start with `/src/` or `file:///src/`. */
export function windowPathParts(uri: string): { name: string; rest: string } | undefined {
  const m = /^(?:file:\/\/)?\/?(?:src\/)?(w\d{4,}\/p\d{4,})(?:\/([\s\S]*))?$/.exec(uri);
  return m?.[1] ? { name: m[1], rest: m[2] ?? '' } : undefined;
}

interface SarifRegion {
  startLine?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
}
interface SarifLocation {
  physicalLocation?: { artifactLocation?: { uri?: string }; region?: SarifRegion };
}
interface SarifResult {
  ruleId?: string;
  message?: { text?: string };
  locations?: SarifLocation[];
}

/** Anything that still looks like an internal window path (`w0001/p0002`). */
const INTERNAL_WINDOW_PATH = /w\d{4,}\/p\d{4,}/;

/**
 * gitleaks puts the scanned path in `message.text`. Swap the internal `wNNNN/pNNNN/<neutral path>`
 * for the original path so no generated name reaches report text. If anything internal is left
 * after that, the text is replaced by a generic one.
 */
function rewriteMessage(
  result: SarifResult,
  mapped: { internal: string; original: string }[],
): void {
  const text = result.message?.text;
  if (typeof text !== 'string' || result.message === undefined || mapped.length === 0) return;
  let out = text;
  for (const m of mapped) out = out.split(m.internal).join(m.original);
  if (INTERNAL_WINDOW_PATH.test(out)) {
    out = `${result.ruleId ?? 'a rule'} detected a secret in /src/${mapped[0]?.original ?? ''}`;
  }
  result.message.text = out;
}

/**
 * Maps a gitleaks SARIF report for the windows directory back to the original files and lines,
 * and drops true duplicates (a finding in an overlap shows up in two windows). A window's first
 * line is the neutral prefix, so window line L is original line startLine + L - 2.
 *
 * Columns, probed on the pinned gitleaks: they are counted in BYTES, and on the first line of a
 * file they are 1-based, while on every later line they come out one higher (gitleaks counts the
 * newline). A window's first original line is window line 2, which gitleaks reports with the
 * later-line convention. So on window line 2 the column becomes
 * `column + startColumn - (startLine === 1 ? 1 : 0)`: the start column is added, and one is taken
 * off when that line is the first line of the original file, so the result equals what the
 * snapshot pass reports for the same finding. On later lines both passes use the same convention
 * and nothing changes. (The snapshot pass's own columns are unreliable after its first 100 KB
 * chunk, a gitleaks bug; the remapped windows columns do not have that problem.)
 *
 * Two findings are duplicates only if rule, file and absolute start and end positions all agree.
 * URIs become `/src/<original path>`. Returns the number of findings kept.
 */
export function remapWindowReport(doc: unknown, entries: readonly WindowEntry[]): number {
  const byName = new Map(entries.map((e) => [e.name, e]));
  const seen = new Set<string>();
  let kept = 0;
  const sarif = doc as { runs?: { results?: SarifResult[] }[] };
  for (const run of sarif.runs ?? []) {
    const out: SarifResult[] = [];
    for (const result of run.results ?? []) {
      const keys: string[] = [];
      const mapped: { internal: string; original: string }[] = [];
      for (const loc of result.locations ?? []) {
        const pl = loc.physicalLocation;
        const uri = pl?.artifactLocation?.uri;
        const parts = uri === undefined ? undefined : windowPathParts(uri);
        const w = parts === undefined ? undefined : byName.get(parts.name);
        if (pl === undefined || w === undefined) continue;
        if (pl.artifactLocation) pl.artifactLocation.uri = `/src/${w.original}`;
        if (parts !== undefined) {
          mapped.push({
            internal: parts.rest === '' ? parts.name : `${parts.name}/${parts.rest}`,
            original: w.original,
          });
        }
        const r = pl.region;
        if (r !== undefined) {
          const shiftCol = (line: number | undefined, col: number | undefined) =>
            line === 2 && col !== undefined
              ? col + w.startColumn - (w.startLine === 1 ? 1 : 0)
              : col;
          const startColumn = shiftCol(r.startLine, r.startColumn);
          const endColumn = shiftCol(r.endLine, r.endColumn);
          if (startColumn !== undefined) r.startColumn = startColumn;
          if (endColumn !== undefined) r.endColumn = endColumn;
          if (r.startLine !== undefined) r.startLine += w.startLine - 2;
          if (r.endLine !== undefined) r.endLine += w.startLine - 2;
        }
        keys.push(
          [result.ruleId, w.original, r?.startLine, r?.startColumn, r?.endLine, r?.endColumn].join(
            '|',
          ),
        );
      }
      rewriteMessage(result, mapped);
      const key = keys.join('&');
      if (keys.length > 0 && seen.has(key)) continue;
      if (keys.length > 0) seen.add(key);
      out.push(result);
      kept++;
    }
    run.results = out;
  }
  return kept;
}
