import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  EXPRESS_PKG,
  fakeGitleaks,
  fakeKey,
  makeRepo,
  request,
  tmpDir,
} from './testkit.js';

vi.setConfig({ testTimeout: 120_000 });
afterAll(cleanup);

const key = fakeKey();

// The first removal of the private checkout fails, as a locked file would make it fail.
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return {
    ...real,
    rm: (path: string, ...rest: unknown[]) =>
      /private-[^\\/]+$/.test(String(path))
        ? Promise.reject(new Error(`EBUSY: cannot remove ${String(path)} holding ${key}`))
        : (real.rm as (...a: unknown[]) => Promise<void>)(path, ...rest),
  };
});

describe('cleanup on the success path', () => {
  it('a checkout that cannot be removed is never reported as a success', async () => {
    const { ingestRepo } = await import('./ingest.js');
    const { dir, shas } = makeRepo([
      { 'package.json': EXPRESS_PKG, 'src/a.js': `const k = "${key}";\n` },
    ]);
    const workRoot = tmpDir();
    const req = request({ source: dir, commit: shas[0] as string });
    let err: unknown;
    try {
      await ingestRepo({ runner: fakeGitleaks(), workRoot, allowLocalSource: true }, req);
    } catch (e) {
      err = e;
    }
    if (!(err instanceof Error)) throw new Error('expected an error');
    expect(err.message).toContain('EBUSY');
    expect(err.message).not.toContain(key); // scrubbed
    expect(existsSync(join(workRoot, String(req.caseId)))).toBe(false); // whole case dir removed
  });
});
