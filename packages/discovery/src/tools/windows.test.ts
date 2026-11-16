import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTmp, tmp } from './testkit.js';
import {
  OVERLAP_BYTES,
  WINDOW_BYTES,
  WindowsDirNotFreshError,
  remapWindowReport,
  windowFile,
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
): Promise<{ bytes: Buffer; startLine: number; start: number }[]> {
  const dir = tmp();
  const file = join(dir, 'f.txt');
  writeFileSync(file, data);
  const out: { bytes: Buffer; startLine: number; start: number }[] = [];
  await windowFile(file, data.length, (bytes, startLine) => {
    out.push({ bytes, startLine, start: -1 });
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

describe('writeWindows and remapWindowReport', () => {
  it('windows only plain text files over 100,000 bytes, and maps findings back', async () => {
    const root = tmp();
    const snap = join(root, 'snap');
    mkdirSync(join(snap, 'a'), { recursive: true });
    writeFileSync(join(snap, 'a', 'big.txt'), randomText(9, 250_000, false));
    writeFileSync(join(snap, 'small.txt'), 'x'.repeat(50_000));
    writeFileSync(
      join(snap, 'big.bin'),
      Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(150_000, 0x61)]),
    );
    const windowsDir = join(root, 'snap.windows');
    const entries = await writeWindows(snap, windowsDir);
    expect(new Set(entries.map((e) => e.original))).toEqual(new Set(['a/big.txt']));
    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (const e of entries) {
      expect(readFileSync(join(windowsDir, e.name)).length).toBeLessThan(100_000);
    }
    await expect(writeWindows(snap, windowsDir)).rejects.toBeInstanceOf(WindowsDirNotFreshError);

    // a finding on window line 3 of the second window maps to original line startLine + 2
    const second = entries[1] as WindowEntry;
    const report = {
      runs: [
        {
          results: [
            finding('r', `/src/${second.name}`, 3),
            finding('r', `/src/${second.name}`, 3), // the same finding again: deduplicated
            finding('r', `/src/${entries[0]?.name ?? ''}`, 7),
          ],
        },
      ],
    };
    const kept = remapWindowReport(report, entries);
    expect(kept).toBe(2);
    const results = report.runs[0]?.results ?? [];
    expect(results[0]?.locations[0]?.physicalLocation.artifactLocation.uri).toBe('/src/a/big.txt');
    expect(results[0]?.locations[0]?.physicalLocation.region.startLine).toBe(second.startLine + 2);
  });

  it('creates nothing when there is nothing to window', async () => {
    const root = tmp();
    const snap = join(root, 'snap');
    mkdirSync(snap);
    writeFileSync(join(snap, 'small.txt'), 'x');
    const entries = await writeWindows(snap, join(root, 'snap.windows'));
    expect(entries).toEqual([]);
    expect(() => readFileSync(join(root, 'snap.windows'))).toThrow();
  });
});

function finding(ruleId: string, uri: string, line: number) {
  return {
    ruleId,
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri },
          region: { startLine: line, endLine: line, startColumn: 1, endColumn: 10 },
        },
      },
    ],
  };
}
