import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ARCHIVE_NAME } from './unscannable.js';
import { cleanupTmp, tmp } from './testkit.js';
import {
  BIG_FILE,
  OVERLAP_BYTES,
  WINDOW_BYTES,
  WINDOW_PREFIX,
  WindowsDirNotFreshError,
  remapWindowReport,
  windowFile,
  windowPathParts,
  writeWindows,
  type WindowEntry,
} from './windows.js';

afterAll(cleanupTmp);

/** Small seeded generator, so a failure is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random text: lines of random length, sometimes blank, sometimes one very long line. */
function randomText(seed: number, bytes: number, longLines: boolean): Buffer {
  const r = rng(seed);
  const parts: string[] = [];
  let size = 0;
  while (size < bytes) {
    const roll = r();
    const len =
      longLines && roll < 0.05 ? 20_000 + Math.floor(r() * 80_000) : Math.floor(r() * 200);
    const line = roll > 0.9 ? '' : 'a'.repeat(len);
    parts.push(line);
    size += line.length + 1;
  }
  return Buffer.from(parts.join('\n') + '\n');
}

async function windowsOf(
  data: Buffer,
): Promise<{ bytes: Buffer; startLine: number; startColumn: number; start: number }[]> {
  const dir = tmp();
  const file = join(dir, 'f.txt');
  writeFileSync(file, data);
  const out: { bytes: Buffer; startLine: number; startColumn: number; start: number }[] = [];
  await windowFile(file, data.length, (bytes, startLine, startColumn) => {
    out.push({ bytes, startLine, startColumn, start: -1 });
    return Promise.resolve();
  });
  // locate each window in the original (windows are exact slices, in order, overlapping)
  let from = 0;
  for (const w of out) {
    const at = data.indexOf(w.bytes, from);
    expect(at, 'window is an exact slice of the file').toBeGreaterThanOrEqual(0);
    w.start = at;
    from = at + 1;
  }
  return out;
}

describe('windowFile', () => {
  it('keeps every window under 100,000 bytes and covers every 16,000-byte stretch', async () => {
    for (const [seed, longLines] of [
      [1, false],
      [2, false],
      [3, true],
      [4, true],
    ] as const) {
      const data = randomText(seed, 700_000 + seed * 13_001, longLines);
      const windows = await windowsOf(data);
      for (const w of windows) expect(w.bytes.length).toBeLessThan(100_000);
      expect(windows[0]?.start).toBe(0);
      const last = windows.at(-1);
      expect((last?.start ?? 0) + (last?.bytes.length ?? 0)).toBe(data.length);
      // every stretch of OVERLAP_BYTES lies wholly inside some window
      const r = rng(seed * 7);
      for (let i = 0; i < 400; i++) {
        const from = Math.floor(r() * (data.length - OVERLAP_BYTES));
        const to = from + OVERLAP_BYTES;
        expect(
          windows.some((w) => w.start <= from && w.start + w.bytes.length >= to),
          `seed ${seed}: stretch ${from}-${to} not covered`,
        ).toBe(true);
      }
    }
  }, 60_000);

  it('records the right starting line for each window', async () => {
    const data = randomText(5, 500_000, false);
    const windows = await windowsOf(data);
    for (const w of windows) {
      const newlinesBefore = data.subarray(0, w.start).filter((b) => b === 0x0a).length;
      expect(w.startLine).toBe(newlinesBefore + 1);
    }
  });

  it('makes progress on one huge line, with overlapping hard cuts', async () => {
    const data = Buffer.alloc(900_000, 0x61);
    const windows = await windowsOf(data);
    expect(windows.length).toBeLessThan(900_000 / 50_000);
    expect(windows.every((w) => w.bytes.length <= WINDOW_BYTES)).toBe(true);
    for (let i = 1; i < windows.length; i++) {
      const prev = windows[i - 1];
      const cur = windows[i];
      if (!prev || !cur) throw new Error('missing window');
      expect(prev.start + prev.bytes.length - cur.start).toBeGreaterThanOrEqual(OVERLAP_BYTES);
    }
  });
});

describe('window columns', () => {
  it('records how far into its first line each window starts', async () => {
    const r = rng(77); // random letters, so each window is found at its own offset
    const data = Buffer.concat([
      Buffer.from('short line\n'),
      Buffer.from(Array.from({ length: 900_000 }, () => 97 + Math.floor(r() * 26))),
      Buffer.from('\nend\n'),
    ]);
    const windows = await windowsOf(data);
    for (const w of windows) {
      const lastNl = data.subarray(0, w.start).lastIndexOf(0x0a);
      expect(w.startColumn, `window at ${w.start}`).toBe(w.start - (lastNl + 1));
    }
    expect(windows.some((w) => w.startColumn > 0)).toBe(true);
  });
});

const wdir = (root: string): string => {
  const d = join(root, 'snap.windows');
  mkdirSync(d);
  return d;
};

describe('writeWindows', () => {
  const entryFor = (
    original: string,
    name = 'w0001/p0001',
    startLine = 1,
    startColumn = 0,
  ): WindowEntry => ({
    name,
    original,
    startLine,
    startColumn,
  });

  it('windows plain text files over 100,000 bytes exactly, not 100,000 or less', async () => {
    const root = tmp();
    const snap = join(root, 'snap');
    mkdirSync(snap);
    writeFileSync(join(snap, 'exact.txt'), 'x'.repeat(BIG_FILE));
    writeFileSync(join(snap, 'one-over.txt'), 'x'.repeat(BIG_FILE + 1));
    const { entries } = await writeWindows(snap, wdir(root));
    expect(new Set(entries.map((e) => e.original))).toEqual(new Set(['one-over.txt']));
  });

  it('writes windows under neutral directories at the original path, each under 100,000 bytes', async () => {
    const root = tmp();
    const snap = join(root, 'snap');
    mkdirSync(join(snap, 'k8s'), { recursive: true });
    writeFileSync(join(snap, 'k8s', 'cut.yaml'), randomText(9, 250_000, false));
    writeFileSync(join(snap, 'small.txt'), 'x'.repeat(50_000));
    writeFileSync(
      join(snap, 'big.bin'),
      Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(150_000, 0x61)]),
    );
    const windowsDir = wdir(root);
    const { entries, skippedForBudget } = await writeWindows(snap, windowsDir);
    expect(skippedForBudget).toEqual([]);
    expect(new Set(entries.map((e) => e.original))).toEqual(new Set(['k8s/cut.yaml']));
    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (const e of entries) {
      const bytes = readFileSync(join(windowsDir, e.name, 'k8s', 'cut.yaml'));
      expect(bytes.length).toBeLessThan(100_000);
      // every window starts with the neutral first line, so no window can begin with a binary header
      expect(bytes.subarray(0, WINDOW_PREFIX.length).toString()).toBe(WINDOW_PREFIX);
    }
    await expect(writeWindows(snap, windowsDir)).rejects.toBeInstanceOf(WindowsDirNotFreshError);
  });

  it('a window that would start with a binary header starts with the neutral line instead', async () => {
    const root = tmp();
    const snap = join(root, 'snap');
    mkdirSync(snap);
    // every line starts with MZ, so every later window would start with it
    writeFileSync(join(snap, 'lines.txt'), 'start\n' + `MZ${'x'.repeat(77)}\n`.repeat(2500));
    const windowsDir = wdir(root);
    const { entries } = await writeWindows(snap, windowsDir);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const e of entries) {
      const bytes = readFileSync(join(windowsDir, e.name, 'lines.txt'));
      expect(bytes.subarray(0, 2).toString()).toBe('# ');
    }
  });

  it('stops at the byte budget and lists the files it did not window', async () => {
    const root = tmp();
    const snap = join(root, 'snap');
    mkdirSync(snap);
    writeFileSync(join(snap, 'a.txt'), randomText(11, 200_000, false));
    writeFileSync(join(snap, 'b.txt'), randomText(12, 200_000, false));
    const { entries, skippedForBudget, bytes } = await writeWindows(snap, wdir(root), {
      maxBytes: 300_000,
    });
    expect(new Set(entries.map((e) => e.original)).size).toBe(1);
    expect(skippedForBudget).toHaveLength(1);
    // a hard cap on bytes actually written, not an estimate
    expect(bytes).toBeLessThanOrEqual(300_000);
    expect(
      readdirSync(join(root, 'snap.windows'), { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .reduce((n, d) => n + readFileSync(join(d.parentPath, d.name)).length, 0),
    ).toBe(bytes);
  });

  it('spends a tight budget on files that already carry a coverage flag, smallest first after that', async () => {
    const root = tmp();
    const snap = join(root, 'snap');
    mkdirSync(snap);
    writeFileSync(join(snap, 'aaa-small.txt'), randomText(21, 120_000, false));
    writeFileSync(join(snap, 'bbb-flagged.txt'), randomText(22, 250_000, false));
    writeFileSync(join(snap, 'ccc-medium.txt'), randomText(23, 150_000, false));
    const { entries, skippedForBudget } = await writeWindows(snap, wdir(root), {
      maxBytes: 330_000,
      priority: new Set(['bbb-flagged.txt']),
    });
    const done = new Set(entries.map((e) => e.original));
    expect(done.has('bbb-flagged.txt')).toBe(true);
    expect(skippedForBudget).toContain('ccc-medium.txt');
  });

  it('windows plain text files with archive-like names under neutral names, any size', async () => {
    const root = tmp();
    const snap = join(root, 'snap');
    mkdirSync(snap);
    writeFileSync(join(snap, 'config.gz.yaml'), 'key: value\n');
    writeFileSync(join(snap, 'notes.tar'), 'plain text, not a tar\n');
    writeFileSync(join(snap, 'plain.txt'), 'x');
    const windowsDir = wdir(root);
    const { entries } = await writeWindows(snap, windowsDir);
    expect(new Set(entries.map((e) => e.original))).toEqual(
      new Set(['config.gz.yaml', 'notes.tar']),
    );
    const files = readdirSync(windowsDir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort();
    expect(files).toEqual(['config._gz.yaml', 'notes._tar']);
    for (const f of files) expect(ARCHIVE_NAME.test(f)).toBe(false);
    // the final extension survives, so a path rule such as \.ya?ml$ still applies
    expect(files.some((f) => f.endsWith('.yaml'))).toBe(true);
  });

  it('never cuts a UTF-8 character in two, in a mid-line cut or a restart', async () => {
    const root = tmp();
    const snap = join(root, 'snap');
    mkdirSync(snap);
    // one long line of 2 and 3 byte characters, so every cut lands inside characters unless moved
    writeFileSync(join(snap, 'u.txt'), 'é€'.repeat(120_000));
    const windowsDir = wdir(root);
    const { entries } = await writeWindows(snap, windowsDir);
    expect(entries.length).toBeGreaterThan(3);
    for (const e of entries) {
      const text = readFileSync(join(windowsDir, e.name, 'u.txt'));
      // a character split by a cut would decode to U+FFFD in a non-fatal decode
      expect(new TextDecoder('utf-8', { fatal: true }).decode(text).includes('�')).toBe(false);
    }
  });

  it('reports a file it cannot write windows for and carries on with the others', async (ctx) => {
    const root = tmp();
    const snap = join(root, 'snap');
    mkdirSync(snap);
    // A 255 character name (the usual limit) that gitleaks reads as an archive: its neutral window
    // name gains a character and no longer fits, so writing the window fails.
    const long = 'a'.repeat(248) + '.gz.txt';
    try {
      writeFileSync(join(snap, long), randomText(31, 120_000, false));
    } catch {
      ctx.skip(); // this filesystem cannot hold a 255 character name
      return;
    }
    writeFileSync(join(snap, 'ok.txt'), randomText(32, 120_000, false));
    const { entries, failed } = await writeWindows(snap, wdir(root));
    expect(new Set(entries.map((e) => e.original))).toEqual(new Set(['ok.txt']));
    expect(failed.map((f) => f.original)).toEqual([long]);
  });

  it('creates nothing when there is nothing to window', async () => {
    const root = tmp();
    const snap = join(root, 'snap');
    mkdirSync(snap);
    writeFileSync(join(snap, 'small.txt'), 'x');
    const { entries } = await writeWindows(snap, wdir(root));
    expect(entries).toEqual([]);
    expect(readdirSync(join(root, 'snap.windows'))).toEqual([]);
  });

  it('maps a window path back through its generated prefix, ignoring what follows it', () => {
    expect(windowPathParts('/src/w0001/p0002/a/b.yaml')).toEqual({
      name: 'w0001/p0002',
      rest: 'a/b.yaml',
    });
    expect(windowPathParts('w0003/p0001/w0001/p0002/x')).toEqual({
      name: 'w0003/p0001',
      rest: 'w0001/p0002/x',
    });
    expect(windowPathParts('/src/a/w0001/p0002/x')).toBeUndefined();
    void entryFor;
  });
});

describe('remapWindowReport', () => {
  const entry = (n: number, over: Partial<WindowEntry> = {}): WindowEntry => ({
    name: `w0001/p000${n}`,
    original: 'a/long.txt',
    startLine: 1,
    startColumn: 0,
    ...over,
  });
  const at = (
    ruleId: string,
    e: WindowEntry,
    startLine: number,
    startColumn: number,
    endLine = startLine,
    endColumn = startColumn + 10,
  ) => ({
    ruleId,
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: `/src/${e.name}/${e.original}` },
          region: { startLine, endLine, startColumn, endColumn },
        },
      },
    ],
  });
  const region = (doc: { runs: { results: ReturnType<typeof at>[] }[] }, i: number) =>
    doc.runs[0]?.results[i]?.locations[0]?.physicalLocation.region;

  it('maps lines (window line 1 is the prefix) and the original path', () => {
    const e = entry(2, { startLine: 400 });
    const doc = { runs: [{ results: [at('r', e, 3, 5)] }] };
    expect(remapWindowReport(doc, [e])).toBe(1);
    expect(doc.runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri).toBe(
      '/src/a/long.txt',
    );
    expect(region(doc, 0)).toMatchObject({ startLine: 401, endLine: 401, startColumn: 5 });
  });

  it('adds the start column to findings on the first original line only', () => {
    const e = entry(2, { startLine: 10, startColumn: 700 });
    const doc = { runs: [{ results: [at('r', e, 2, 5), at('r', e, 3, 5)] }] };
    remapWindowReport(doc, [e]);
    expect(region(doc, 0)).toMatchObject({ startLine: 10, startColumn: 705, endColumn: 715 });
    expect(region(doc, 1)).toMatchObject({ startLine: 11, startColumn: 5 });
  });

  it('keeps two same-rule, same-length findings on one long line, and merges true duplicates', () => {
    // one very long line cut mid-line: window 1 starts at column 0, window 2 at column 50,000
    const w1 = entry(1, { startLine: 1, startColumn: 0 });
    const w2 = entry(2, { startLine: 1, startColumn: 50_000 });
    const doc = {
      runs: [
        {
          results: [
            at('github-pat', w1, 2, 60_000), // finding A, seen in window 1
            at('github-pat', w1, 2, 80_000), // finding B, same rule and length, elsewhere on the line
            at('github-pat', w2, 2, 10_000), // finding A again, seen in the overlap in window 2
          ],
        },
      ],
    };
    expect(remapWindowReport(doc, [w1, w2])).toBe(2);
    expect(
      doc.runs[0]?.results.map((r) => r.locations[0]?.physicalLocation.region.startColumn),
    ).toEqual([59_999, 79_999]);
  });
});
