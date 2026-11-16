import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
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
 * WINDOW_BYTES is 90,000. Consecutive windows overlap by at least OVERLAP_BYTES, 16,000, so any
 * stretch of up to 16,000 contiguous bytes lies wholly inside at least one window. That is enough
 * for a 4096-bit PEM key (about 3.3 KB armored, about 3.4 KB with headers and line breaks), a
 * PGP private key block (a few KB) and every keyword-and-value rule, whose parts are within a few
 * hundred bytes of each other. Longer secrets are the remaining gap, covered only by the
 * private-key and chunk checks in unscannable.ts, which stay as defence in depth.
 *
 * Windows start and end on line boundaries when a line is short enough; a line longer than half a
 * window is cut mid-line, with the same overlap. Each window records the line number of its first
 * byte so findings can be mapped back to the original file and line.
 */
export const WINDOW_BYTES = 90_000;
export const OVERLAP_BYTES = 16_000;
const MIN_LINE_ALIGNED = 45_000;
const BIG_FILE = 100_000;

export interface WindowEntry {
  /** Path of the window file relative to the windows directory, for example `w0001/p0002`. */
  name: string;
  /** Original file, relative to the snapshot, posix separators. */
  original: string;
  /** Line number in the original file of the first byte of this window (1-based). */
  startLine: number;
}

export class WindowsDirNotFreshError extends Error {
  constructor(dir: string) {
    super(`windows directory must not exist before a run: ${dir}`);
    this.name = 'WindowsDirNotFreshError';
  }
}

function countNewlines(buf: Uint8Array, upTo: number): number {
  let n = 0;
  let i = buf.indexOf(0x0a);
  while (i >= 0 && i < upTo) {
    n++;
    i = buf.indexOf(0x0a, i + 1);
  }
  return n;
}

/** Cuts one file into windows, calling `emit` for each. Streams with one window-sized buffer. */
export async function windowFile(
  file: string,
  size: number,
  emit: (bytes: Buffer, startLine: number) => Promise<void>,
): Promise<void> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(WINDOW_BYTES);
    let start = 0;
    let line = 1; // number of newlines before `start`, plus one
    for (;;) {
      const { bytesRead: n } = await fh.read(buf, 0, WINDOW_BYTES, start);
      if (n === 0) return;
      const last = start + n >= size;
      let wlen = n;
      if (!last) {
        const nl = buf.subarray(0, n).lastIndexOf(0x0a);
        if (nl + 1 >= MIN_LINE_ALIGNED) wlen = nl + 1;
      }
      await emit(Buffer.from(buf.subarray(0, wlen)), line);
      if (last && wlen === n) return;
      // next window starts at a line start at or before (end - overlap), so the overlap is at
      // least OVERLAP_BYTES, or mid-line when there is no newline to align to
      const target = wlen - OVERLAP_BYTES;
      const nlBefore = buf.subarray(0, Math.max(target, 0)).lastIndexOf(0x0a);
      // Align to a line start only if that costs at most 20,000 bytes of extra overlap, so a file
      // with very long lines still advances at least 54,000 bytes per window.
      let nextRel =
        nlBefore >= 0 && nlBefore + 1 >= target - 20_000 ? nlBefore + 1 : Math.max(target, 1);
      if (nextRel <= 0) nextRel = 1;
      line += countNewlines(buf.subarray(0, nextRel), nextRel);
      start += nextRel;
      if (start >= size) return;
    }
  } finally {
    await fh.close();
  }
}

/**
 * Writes windows for every plain text file over 100,000 bytes in the snapshot into `windowsDir`
 * (which must not exist; it is only created if there is something to write). Files with a known
 * binary signature or non-text start are not windowed: gitleaks skips or reads them as a whole.
 * Never follows symlinks.
 */
export async function writeWindows(
  snapshotDir: string,
  windowsDir: string,
): Promise<WindowEntry[]> {
  const entries: WindowEntry[] = [];
  let created = false;
  let fileNo = 0;

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

      if (!created) {
        try {
          await mkdir(windowsDir);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST')
            throw new WindowsDirNotFreshError(windowsDir);
          throw err;
        }
        created = true;
      }
      const original = relative(snapshotDir, full).split(sep).join('/');
      const sub = `w${String(++fileNo).padStart(4, '0')}`;
      await mkdir(join(windowsDir, sub));
      let part = 0;
      await windowFile(full, st.size, async (bytes, startLine) => {
        const name = `${sub}/p${String(++part).padStart(4, '0')}`;
        await writeFile(join(windowsDir, name), bytes);
        entries.push({ name, original, startLine });
      });
    }
  };
  await walk(snapshotDir);
  return entries;
}

interface SarifLocation {
  physicalLocation?: {
    artifactLocation?: { uri?: string };
    region?: { startLine?: number; endLine?: number; startColumn?: number; endColumn?: number };
  };
}
interface SarifResult {
  ruleId?: string;
  locations?: SarifLocation[];
}

/**
 * Maps a gitleaks SARIF report for the windows directory back to the original files and lines,
 * and drops duplicates (a finding in an overlap shows up in two windows). Returns the number of
 * findings kept. URIs become `/src/<original path>`, like the other reports.
 */
export function remapWindowReport(doc: unknown, entries: readonly WindowEntry[]): number {
  const byName = new Map(entries.map((e) => [e.name, e]));
  const seen = new Set<string>();
  let kept = 0;
  const sarif = doc as { runs?: { results?: SarifResult[] }[] };
  for (const run of sarif.runs ?? []) {
    const out: SarifResult[] = [];
    for (const result of run.results ?? []) {
      let drop = false;
      for (const loc of result.locations ?? []) {
        const pl = loc.physicalLocation;
        const uri = pl?.artifactLocation?.uri;
        if (pl === undefined || uri === undefined) continue;
        const name = uri.replace(/^file:\/\//, '').replace(/^\/?(?:src\/)?/, '');
        const w = byName.get(name);
        if (w === undefined) continue;
        if (pl.artifactLocation) pl.artifactLocation.uri = `/src/${w.original}`;
        if (pl.region?.startLine !== undefined) pl.region.startLine += w.startLine - 1;
        if (pl.region?.endLine !== undefined) pl.region.endLine += w.startLine - 1;
        const r = pl.region;
        const key = [
          result.ruleId,
          w.original,
          r?.startLine,
          r?.startColumn,
          r?.endLine,
          r?.endColumn,
        ].join('|');
        if (seen.has(key)) drop = true;
        seen.add(key);
      }
      if (!drop) {
        out.push(result);
        kept++;
      }
    }
    run.results = out;
  }
  return kept;
}
