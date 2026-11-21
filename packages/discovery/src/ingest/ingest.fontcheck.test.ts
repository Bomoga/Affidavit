/**
 * L1-01c: the post-check that every skipped font is absent from the workspace fails closed. Only
 * ENOENT from lstat counts as absent; any other error (permission, I/O, a name too long) means the
 * check could not be made, so ingestion returns `incomplete`.
 */
import { sep } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { sfnt } from '../tools/fontkit.testutil.js';
import { ingestRepo } from './index.js';
import { cleanup, EXPRESS_PKG, fakeGitleaks, makeRepo, request, tmpDir } from './testkit.js';

const fail = vi.hoisted(() => ({ code: undefined as string | undefined, calls: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const lstat = (async (...args: Parameters<typeof real.lstat>) => {
    const p = String(args[0]);
    if (fail.code !== undefined && p.includes(`${sep}workspace${sep}`) && p.endsWith('a.ttf')) {
      fail.calls++;
      throw Object.assign(new Error(`${fail.code}: lstat`), { code: fail.code });
    }
    return real.lstat(...args);
  }) as typeof real.lstat;
  return { ...real, default: { ...real, lstat }, lstat };
});

vi.setConfig({ testTimeout: 180_000 });
afterAll(cleanup);
afterEach(() => {
  fail.code = undefined;
  fail.calls = 0;
});

async function ingestFont() {
  const { dir, shas } = makeRepo([
    {
      'package.json': EXPRESS_PKG,
      'src/app.js': "require('express')();\n",
      'public/fonts/a.ttf': sfnt(),
    },
  ]);
  return ingestRepo(
    {
      runner: fakeGitleaks({ chunkBytes: 100_000, onlyFiles: (rel) => !rel.endsWith('.ttf') }),
      workRoot: tmpDir(),
      allowLocalSource: true,
    },
    request({ source: dir, commit: shas[0] as string }),
  );
}

describe('font absence post-check', () => {
  it('ENOENT (the font really is absent) is ok', async () => {
    fail.code = 'ENOENT';
    const r = await ingestFont();
    expect(fail.calls).toBe(1);
    expect(r.status).toBe('ok');
  });

  it.each(['EACCES', 'EPERM', 'EIO', 'ENAMETOOLONG', 'ENOTDIR'])(
    'any other lstat error (%s) fails closed',
    async (code) => {
      fail.code = code;
      const r = await ingestFont();
      expect(fail.calls).toBe(1);
      expect(r.status).toBe('incomplete');
    },
  );
});
