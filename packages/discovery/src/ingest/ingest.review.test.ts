import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { detectRepo } from './detect.js';
import {
  CloneFailedError,
  ingestRepo,
  RepoTooLargeError,
  type IngestDeps,
  type IngestOk,
  type IngestResult,
} from './index.js';
import {
  cleanup,
  EXPRESS_PKG,
  everything,
  fakeGitleaks,
  fakeKey,
  listFiles,
  makeRepo,
  request,
  tmpDir,
  type Files,
} from './testkit.js';

vi.setConfig({ testTimeout: 120_000 });
afterAll(cleanup);

const deps = (over: Partial<IngestDeps> = {}): IngestDeps => ({
  runner: fakeGitleaks(),
  workRoot: tmpDir(),
  allowLocalSource: true,
  ...over,
});
const ok = (r: IngestResult): IngestOk => {
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
  return r;
};
const app = (extra: Files = {}): Files => ({
  'package.json': EXPRESS_PKG,
  'src/app.js': "require('express')();\n",
  ...extra,
});

describe('the result leaks nothing through detection paths', () => {
  it('a key in a directory name does not reach JSON, inspect or the detection fields', async () => {
    const key = fakeKey();
    const { dir, shas } = makeRepo([
      app({
        'src/app.js': `const k = "${key}";\n`,
        [`svc-${key}/package.json`]: EXPRESS_PKG,
        [`svc-${key}/index.js`]: 'x\n',
      }),
    ]);
    const r = ok(await ingestRepo(deps(), request({ source: dir, commit: shas[0] as string })));
    expect(JSON.stringify(r)).not.toContain(key);
    expect(inspect(r, { depth: 20 })).not.toContain(key);
    expect(everything(r.workspacePath)).not.toContain(key);
    expect(r.detection.packageRoots).toContain('svc-REDACTED-1');
    expect(r.detection.frameworks.map((f) => f.packageJson)).toContain(
      'svc-REDACTED-1/package.json',
    );
  });
});

describe('.env style names', () => {
  it('leaves out the wider set, any case, any depth, and whole directories', async () => {
    const k = fakeKey();
    const names = [
      '.env-local',
      '.env_production',
      '.ENV_Staging',
      'config/production.env',
      'a/b/Prod.ENV',
      'config/prod.env.local',
      '.envs/dev.txt',
      'deep/.envs/x/y.js',
      '.envrc',
    ];
    const { dir, shas } = makeRepo([
      app({
        ...Object.fromEntries(names.map((n) => [n, `A=${k}\n`])),
        'src/ok.js': 'x\n',
        'environment.js': 'x\n',
      }),
    ]);
    const r = ok(await ingestRepo(deps(), request({ source: dir, commit: shas[0] as string })));
    expect(listFiles(r.workspacePath)).toEqual([
      'environment.js',
      'package.json',
      'src/app.js',
      'src/ok.js',
    ]);
    expect(everything(r.workspacePath)).not.toContain(k);
    expect(r.excluded.every((e) => e.reason === 'env-file')).toBe(true);
  });
});

describe('detection limits', () => {
  it('a truncated walk says so instead of claiming there is no framework', async () => {
    const root = tmpDir();
    for (let i = 0; i < 20; i++) writeFileSync(join(root, `f${i}.txt`), 'x');
    const r = await detectRepo(root, { maxEntries: 5 });
    expect(r).toMatchObject({
      supported: false,
      unsupported: { reason: 'tree-too-large-to-scan' },
    });

    const deep = tmpDir();
    mkdirSync(join(deep, 'a', 'b', 'c'), { recursive: true });
    writeFileSync(join(deep, 'package.json'), '{}');
    writeFileSync(join(deep, 'a', 'b', 'c', 'x.js'), 'x');
    const d = await detectRepo(deep, { maxDepth: 1 });
    expect(d).toMatchObject({
      supported: false,
      unsupported: { reason: 'tree-too-large-to-scan' },
    });
    // not truncated: the ordinary reason
    const plain = await detectRepo(deep);
    expect(plain).toMatchObject({
      supported: false,
      unsupported: { reason: 'no-supported-framework' },
    });
  });
});

describe('fetch limits', () => {
  it('a repository over the byte cap is a typed error and leaves nothing', async () => {
    const { randomBytes } = await import('node:crypto');
    const { dir, shas } = makeRepo([app({ 'assets/big.bin': randomBytes(400_000) })]);
    const d = deps({ maxRepoBytes: 100_000 });
    const req = request({ source: dir, commit: shas[0] as string });
    await expect(ingestRepo(d, req)).rejects.toBeInstanceOf(RepoTooLargeError);
    expect(existsSync(join(d.workRoot, String(req.caseId)))).toBe(false);
  });

  it('a git command that runs too long is killed with a typed error', async () => {
    const { dir, shas } = makeRepo([app()]);
    const d = deps({ gitTimeoutMs: 1 });
    const req = request({ source: dir, commit: shas[0] as string });
    await expect(ingestRepo(d, req)).rejects.toMatchObject({
      name: CloneFailedError.name,
      message: expect.stringContaining('timed out') as unknown,
    });
    expect(existsSync(join(d.workRoot, String(req.caseId)))).toBe(false);
  });
});

describe('short values and line fallbacks are counted', () => {
  it('reports shortValues and documents the limit: a short value is replaced where reported only', async () => {
    const { dir, shas } = makeRepo([
      app({ 'src/a.js': 'x = "tok123";\n', 'src/b.js': 'y = "tok123";\n' }),
    ]);
    const d = deps({
      runner: fakeGitleaks({ extra: /tok\d{3}/g, onlyFiles: (f) => f === 'src/a.js' }),
    });
    const r = ok(await ingestRepo(d, request({ source: dir, commit: shas[0] as string })));
    expect(r.scan).toMatchObject({ shortValues: 1, lineFallbacks: 0, redactedValues: 1 });
    expect(readFileSync(join(r.workspacePath, 'src', 'a.js'), 'utf8')).toMatch(/REDACTED/);
    expect(readFileSync(join(r.workspacePath, 'src', 'b.js'), 'utf8')).toBe('y = "tok123";\n');
  });

  it('a normal run reports zero of both', async () => {
    const { dir, shas } = makeRepo([app({ 'src/c.js': `k="${fakeKey()}"\n` })]);
    const r = ok(await ingestRepo(deps(), request({ source: dir, commit: shas[0] as string })));
    expect(r.scan).toMatchObject({ shortValues: 0, lineFallbacks: 0, redactedValues: 1 });
  });
});
