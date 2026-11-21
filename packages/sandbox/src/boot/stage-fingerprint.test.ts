import type { PathLike, Stats } from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fingerprintStageTree } from './build.js';

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'affidavit-stage-fp-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function tree(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

/** lstat with some entries reported as other kinds or modes (Windows has no exec bit or easy links). */
const lstatAs = (over: Record<string, { link?: boolean; exec?: boolean }>): typeof lstat =>
  (async (p: PathLike): Promise<Stats> => {
    const st = await lstat(p);
    const name = String(p).split(/[\\/]/).pop() ?? '';
    const o = over[name];
    if (o === undefined) return st;
    return Object.assign(Object.create(Object.getPrototypeOf(st) as object) as Stats, st, {
      mode: o.exec === true ? st.mode | 0o111 : st.mode & ~0o111,
      isFile: () => o.link !== true && st.isFile(),
      isSymbolicLink: () => o.link === true,
      isDirectory: () => o.link !== true && st.isDirectory(),
    });
  }) as typeof lstat;

describe('fingerprintStageTree (what staging copies into the build context)', () => {
  it('equal content gives equal fingerprints; skipped names do not count', async () => {
    const a = tree('a', { 'app/a.js': 'x' });
    const b = tree('b', {
      'app/a.js': 'x',
      '.git/HEAD': 'h',
      'node_modules/m/i.js': 'm',
      '.env': 's',
    });
    expect(await fingerprintStageTree(a)).toBe(await fingerprintStageTree(b));
  });

  it('any content or path change differs', async () => {
    const a = tree('a', { 'app/a.js': 'x' });
    expect(await fingerprintStageTree(a)).not.toBe(
      await fingerprintStageTree(tree('b', { 'app/a.js': 'y' })),
    );
    expect(await fingerprintStageTree(a)).not.toBe(
      await fingerprintStageTree(tree('c', { 'app/b.js': 'x' })),
    );
  });

  it('a dangling symlink is left out, as staging leaves it out', async () => {
    const a = tree('a', { 'app/a.js': 'x' });
    const b = tree('b', { 'app/a.js': 'x', 'app/dangling': '' });
    expect(await fingerprintStageTree(b, { lstat: lstatAs({ dangling: { link: true } }) })).toBe(
      await fingerprintStageTree(a),
    );
  });

  it('an exec-bit-only change differs, as staging keeps it', async () => {
    const a = tree('a', { 'bin/run.sh': 'echo' });
    const plain = await fingerprintStageTree(a, { lstat: lstatAs({ 'run.sh': { exec: false } }) });
    const exec = await fingerprintStageTree(a, { lstat: lstatAs({ 'run.sh': { exec: true } }) });
    expect(exec).not.toBe(plain);
  });

  it('refuses a tree over the staging caps', async () => {
    const a = tree('a', { 'a.js': 'x', 'b.js': 'y' });
    await expect(fingerprintStageTree(a, { caps: { files: 1, bytes: 1024 } })).rejects.toThrow(
      /over the size limit/,
    );
  });
});
