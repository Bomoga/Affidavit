import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { cleanupTmp, tmp } from './testkit.js';
import { writeWindows } from './windows.js';

// Writing a window fails, and so does removing the partial window directory afterwards.
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const err = (code: string) => Object.assign(new Error(code), { code });
  return {
    ...real,
    writeFile: vi.fn((path: string, ...rest: unknown[]) =>
      String(path).includes('bad.txt')
        ? Promise.reject(err('ENOSPC'))
        : (real.writeFile as (...a: unknown[]) => Promise<void>)(path, ...rest),
    ),
    rm: vi.fn((path: string, ...rest: unknown[]) =>
      /w\d{4}$/.test(String(path))
        ? Promise.reject(err('EPERM'))
        : (real.rm as (...a: unknown[]) => Promise<void>)(path, ...rest),
    ),
  };
});

afterAll(cleanupTmp);

describe('writeWindows cleanup', () => {
  it('reports a file in failed even when removing its partial windows also fails', async () => {
    const root = tmp();
    const snap = join(root, 'snap');
    mkdirSync(snap);
    writeFileSync(join(snap, 'bad.txt'), 'a'.repeat(120_000));
    const windowsDir = join(root, 'snap.windows');
    mkdirSync(windowsDir);
    const res = await writeWindows(snap, windowsDir);
    expect(res.entries).toEqual([]);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]?.original).toBe('bad.txt');
    expect(res.failed[0]?.why).toContain('ENOSPC');
    expect(res.failed[0]?.why).toContain('removing its partial windows failed (EPERM)');
  });
});
