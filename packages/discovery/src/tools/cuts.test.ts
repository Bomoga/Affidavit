import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CutSimulator, findGitleaksUnscannable } from './unscannable.js';
import { cleanupTmp, tmp } from './testkit.js';

afterAll(cleanupTmp);

const PEM =
  '-----BEGIN ENCRYPTED PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0123456789ABCDEF\n\n' +
  `${'A'.repeat(64)}\n`.repeat(5) +
  '-----END ENCRYPTED PRIVATE KEY-----\n';

/** Lines of 79 characters with no blank line, up to exactly `bytes` bytes. */
const filler = (bytes: number): string => {
  const line = `${'x'.repeat(79)}\n`;
  const whole = Math.floor(bytes / 80);
  return line.repeat(whole) + 'y'.repeat(bytes - whole * 80);
};

function simulate(text: string, readSize = 64 * 1024): CutSimulator {
  const sim = new CutSimulator();
  const data = Buffer.from(text);
  for (let i = 0; i < data.length; i += readSize) sim.feed(data.subarray(i, i + readSize));
  return sim;
}

describe('CutSimulator', () => {
  it('flags an encrypted PEM key that straddles the first blank-line cut', () => {
    // The key starts at 99,950; its first blank line (after DEK-Info) is just past byte 100,000,
    // so the simulated chunk is cut there, through the middle of the key.
    const sim = simulate(filler(99_950) + PEM + filler(40_000));
    expect(sim.cuts[0]).toBeGreaterThan(100_000);
    expect(sim.splitsBlock).toBe(true);
  });

  it('does not flag a PEM block that lies wholly before the cut', () => {
    expect(simulate(filler(10_000) + PEM + filler(130_000)).splitsBlock).toBe(false);
  });

  it('does not flag a PEM block that lies wholly after the cut', () => {
    expect(simulate(filler(100_100) + '\n\n' + PEM + filler(20_000)).splitsBlock).toBe(false);
  });

  it('flags a block across the hard cut at 125,000 when no blank line is in the peek window', () => {
    const noBlank = PEM.replace('\n\n', '\n'); // no blank line anywhere
    const sim = simulate(filler(124_900) + noBlank + filler(20_000));
    expect(sim.cuts[0]).toBe(125_000);
    expect(sim.splitsBlock).toBe(true);
  });

  it('gives the same answer however the file is split into reads', () => {
    const text = filler(99_950) + PEM + filler(60_000);
    const whole = simulate(text, text.length);
    for (const size of [1_000, 7_001, 65_536]) {
      const parts = simulate(text, size);
      expect(parts.cuts).toEqual(whole.cuts);
      expect(parts.splitsBlock).toBe(whole.splitsBlock);
    }
  });

  it('ignores files that never reach a chunk boundary', () => {
    expect(simulate(PEM).cuts).toEqual([]);
    expect(simulate(PEM).splitsBlock).toBe(false);
  });
});

describe('findGitleaksUnscannable options', () => {
  it('clamps concurrency to at least 1 instead of inspecting nothing', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'a', 'x.pdf'), '%PDF-1.4 hidden');
    for (const concurrency of [0, -3, 0.4]) {
      const found = await findGitleaksUnscannable(dir, { concurrency });
      expect(found).toEqual([{ path: 'a/x.pdf', kind: 'skipped-file-type' }]);
    }
  });

  // chmod does not restrict a directory on Windows, or for root
  const canRestrict = process.platform !== 'win32' && process.getuid?.() !== 0;
  it.skipIf(!canRestrict)('reports a directory it cannot list as unreadable', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'locked'));
    writeFileSync(join(dir, 'locked', 'a.txt'), 'x');
    chmodSync(join(dir, 'locked'), 0o000);
    try {
      expect(await findGitleaksUnscannable(dir)).toEqual([{ path: 'locked', kind: 'unreadable' }]);
    } finally {
      chmodSync(join(dir, 'locked'), 0o700);
    }
  });

  it('reports a PEM split in a real file on disk', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'key.txt'), filler(99_950) + PEM + filler(40_000));
    const found = await findGitleaksUnscannable(dir);
    expect(found.map((f) => f.kind)).toContain('multiline-split-risk');
  });
});
