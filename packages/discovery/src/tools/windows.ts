import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { classifyHead } from './unscannable.js';
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
 * mid-line with the same overlap, and the window records how far into its first line it starts.
 * Each window records the line number of its first byte so findings can be mapped back.
 *
 * Two things protect a window from being skipped or mis-scanned:
 *  - gitleaks decides text or binary from a file's first bytes. A window that happens to start with
 *    `MZ` or `%PDF` would be skipped. So every window starts with a neutral first line, and the
 *    host also checks each window with the same signature table afterwards (offset signatures such
 *    as `ustar` at 257 can still match), reporting any hit.
 *  - Rules that match on the file path (kubernetes-secret-yaml, hashicorp-tf-password, ...) need
 *    the real name, so a window is written at \`wNNNN/pNNNN/<original path>\`. The neutral
 *    directories are generated and are what the mapping back uses, so a repo file name cannot
 *    forge or collide with another window.
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
 * Upper bound on the bytes of windows written in one run. Windows duplicate every large text file
 * about 1.2 times, so a repo with many large files could otherwise fill the disk and run gitleaks
 * for a very long time. 256 MiB is a safety limit chosen for that reason, not a measured number.
 * Files that do not fit are listed and the run is marked partial.
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

export class WindowsDirNotFreshError extends Error {
  constructor(dir: string) {
    super(`windows directory must not exist before a run: ${dir}`);
    this.name = 'WindowsDirNotFreshError';
  }
}

export interface WindowsResult {
  entries: WindowEntry[];
  /** Files over the size that were not windowed because the byte budget ran out. */
  skippedForBudget: string[];
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
      }
      await emit(Buffer.from(buf.subarray(0, wlen)), line, col);
      if (last && wlen === n) return;
      // The next window starts at a line start at or before (end - overlap), so the overlap is at
      // least OVERLAP_BYTES. Aligning to a line start may move the start back by at most
      // MAX_ALIGN_BACK bytes; otherwise the start is mid-line, exactly at the target.
      const target = wlen - OVERLAP_BYTES;
      const nlBefore = buf.subarray(0, Math.max(target, 0)).lastIndexOf(0x0a);
      let nextRel =
        nlBefore >= 0 && nlBefore + 1 >= target - MAX_ALIGN_BACK
          ? nlBefore + 1
          : Math.max(target, 1);
      if (nextRel <= 0) nextRel = 1;
      const skipped = buf.subarray(0, nextRel);
      const nls = countNewlines(skipped);
      line += nls;
      const lastNl = skipped.lastIndexOf(0x0a);
      col = lastNl < 0 ? col + nextRel : nextRel - (lastNl + 1);
      start += nextRel;
      if (start >= size) return;
    }
  } finally {
    await fh.close();
  }
}

/**
 * Writes windows for every plain text file over 100,000 bytes in the snapshot into `windowsDir`
 * (which must not exist; it is only created if there is something to write), until `maxBytes` of
 * windows have been written. Files with a known binary signature or non-text start are not
 * windowed: gitleaks skips or reads them as a whole. Never follows symlinks.
 */
export async function writeWindows(
  snapshotDir: string,
  windowsDir: string,
  maxBytes: number = MAX_WINDOW_BYTES,
): Promise<WindowsResult> {
  const entries: WindowEntry[] = [];
  const skippedForBudget: string[] = [];
  let created = false;
  let fileNo = 0;
  let bytes = 0;

  const walk = async (dir: string): Promise<void> => {
    for (const e of await listDir(dir)) {
      const full = join(dir, e.name);
      if (e.isDirectory) {
        await walk(full);
        continue;
      }
      if (!e.isFile) continue;
      const st = await lstat(full);
      if (st.size <= BIG_FILE) continue;
      const fh = await open(full, 'r');
      let head: Buffer;
      try {
        head = Buffer.alloc(BIG_FILE);
        const { bytesRead } = await fh.read(head, 0, BIG_FILE, 0);
        head = head.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
      if (classifyHead(e.name, head) !== undefined) continue;

      const original = relative(snapshotDir, full).split(sep).join('/');
      // windows cover the file about 1.25 times at worst; leave room before starting a file
      if (bytes + Math.ceil(st.size * 1.25) > maxBytes) {
        skippedForBudget.push(original);
        continue;
      }
      if (!created) {
        try {
          await mkdir(windowsDir);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new WindowsDirNotFreshError(windowsDir);
          }
          throw err;
        }
        created = true;
      }
      const sub = `w${String(++fileNo).padStart(4, '0')}`;
      let part = 0;
      await windowFile(full, st.size, async (win, startLine, startColumn) => {
        const name = `${sub}/p${String(++part).padStart(4, '0')}`;
        const target = join(windowsDir, name, ...original.split('/'));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, Buffer.concat([Buffer.from(WINDOW_PREFIX), win]));
        bytes += win.length + WINDOW_PREFIX.length;
        entries.push({ name, original, startLine, startColumn });
      });
    }
  };
  await walk(snapshotDir);
  return { entries, skippedForBudget, bytes };
}

/** Finds the window a report path belongs to. The path may start with `/src/` or `file:///src/`. */
export function windowPathParts(uri: string): { name: string; rest: string } | undefined {
  const m = /^(?:file:\/\/)?\/?(?:src\/)?(w\d{4}\/p\d{4})(?:\/(.*))?$/.exec(uri);
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
  locations?: SarifLocation[];
}

/**
 * Maps a gitleaks SARIF report for the windows directory back to the original files and lines,
 * and drops true duplicates (a finding in an overlap shows up in two windows). A window's first
 * line is the neutral prefix, so window line L is original line startLine + L - 2. Columns on the
 * window's first original line (window line 2) are shifted by the window's start column when it
 * starts mid-line. Two findings are duplicates only if rule, file and absolute start and end
 * positions all agree. URIs become `/src/<original path>`. Returns the number of findings kept.
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
      for (const loc of result.locations ?? []) {
        const pl = loc.physicalLocation;
        const uri = pl?.artifactLocation?.uri;
        const parts = uri === undefined ? undefined : windowPathParts(uri);
        const w = parts === undefined ? undefined : byName.get(parts.name);
        if (pl === undefined || w === undefined) continue;
        if (pl.artifactLocation) pl.artifactLocation.uri = `/src/${w.original}`;
        const r = pl.region;
        if (r !== undefined) {
          const shiftCol = (line: number | undefined, col: number | undefined) =>
            line === 2 && col !== undefined ? col + w.startColumn : col;
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
