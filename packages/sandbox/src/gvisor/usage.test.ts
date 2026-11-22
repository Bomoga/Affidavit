import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mergeUsage, parseCpuStat, parseMemoryPeak, sampleUsage } from './usage.js';

const ID = 'a'.repeat(64);

describe('cgroup usage', () => {
  const root = mkdtempSync(join(tmpdir(), 'affidavit-usage-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('parses memory.peak and cpu.stat, refusing anything else', () => {
    expect(parseMemoryPeak('235778048\n')).toBe(235778048);
    expect(parseMemoryPeak('max')).toBeNull();
    expect(parseMemoryPeak('-1')).toBeNull();
    expect(parseCpuStat('usage_usec 4389124\nuser_usec 4000000\n')).toBe(4389);
    expect(parseCpuStat('user_usec 4000000\n')).toBeNull();
  });

  it('keeps the highest value of each, null only when never seen', () => {
    expect(
      mergeUsage({ memoryPeakBytes: 10, cpuMs: null }, { memoryPeakBytes: 5, cpuMs: 7 }),
    ).toEqual({ memoryPeakBytes: 10, cpuMs: 7 });
    expect(
      mergeUsage({ memoryPeakBytes: null, cpuMs: null }, { memoryPeakBytes: null, cpuMs: null }),
    ).toEqual({ memoryPeakBytes: null, cpuMs: null });
  });

  it('reads the first cgroup directory that exists, and nulls when none does', async () => {
    const dir = join(root, `docker-${ID}.scope`);
    mkdirSync(dir);
    writeFileSync(join(dir, 'memory.peak'), '1048576\n');
    writeFileSync(join(dir, 'cpu.stat'), 'usage_usec 2500\n');
    const dirs = [
      (id: string) => join(root, 'missing', id),
      (id: string) => join(root, `docker-${id}.scope`),
    ];
    expect(await sampleUsage(ID, dirs)).toEqual({ memoryPeakBytes: 1048576, cpuMs: 2 });
    expect(await sampleUsage('b'.repeat(64), dirs)).toEqual({ memoryPeakBytes: null, cpuMs: null });
    // A container id is 64 hex characters; anything else never becomes a path.
    expect(await sampleUsage('../../etc', dirs)).toEqual({ memoryPeakBytes: null, cpuMs: null });
  });
});
