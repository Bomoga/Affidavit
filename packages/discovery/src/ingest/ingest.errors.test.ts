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

vi.mock('./workspace.js', async (orig) => {
  const real = await orig<typeof import('./workspace.js')>();
  return {
    ...real,
    buildWorkspace: () => Promise.reject(new Error(`cannot write svc-${key}/index.js`)),
  };
});

describe('errors raised after the map exists', () => {
  it('are rethrown with known values replaced', async () => {
    const { ingestRepo } = await import('./ingest.js');
    const { dir, shas } = makeRepo([
      { 'package.json': EXPRESS_PKG, 'src/app.js': `const k = "${key}";\n` },
    ]);
    let err: unknown;
    try {
      await ingestRepo(
        { runner: fakeGitleaks(), workRoot: tmpDir(), allowLocalSource: true },
        request({ source: dir, commit: shas[0] as string }),
      );
    } catch (e) {
      err = e;
    }
    if (!(err instanceof Error)) throw new Error('expected an error');
    expect(err.message).toContain('cannot write svc-[REDACTED:');
    expect(err.message).not.toContain(key);
    expect(err.stack ?? '').not.toContain(key);
  });
});
