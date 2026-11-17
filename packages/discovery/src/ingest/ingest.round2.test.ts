import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { assertGitSupportsPin, checkoutPinned, collapseFetchError, treeCounter } from './git.js';
import {
  CloneFailedError,
  GitTooOldError,
  ingestRepo,
  RepoTooLargeError,
  type IngestDeps,
  type IngestOk,
} from './index.js';
import { redactError } from './ingest.js';
import { entriesOf, SecretRedactor } from './redactor.js';
import { findLeaks } from './workspace.js';
import {
  cleanup,
  EXPRESS_PKG,
  fakeGitleaks,
  fakeKey,
  git,
  makeRepo,
  request,
  tmpDir,
} from './testkit.js';
import { mkdirSync, writeFileSync } from 'node:fs';

vi.setConfig({ testTimeout: 120_000 });
afterAll(cleanup);

const deps = (over: Partial<IngestDeps> = {}): IngestDeps => ({
  runner: fakeGitleaks(),
  workRoot: tmpDir(),
  allowLocalSource: true,
  ...over,
});

const entry = (value: string, over = {}) => ({
  id: 1,
  ruleId: 'r',
  value: Buffer.from(value),
  exact: true,
  scope: 'global' as const,
  placeholder: '[P]',
  locations: [],
  ...over,
});

describe('git version', () => {
  it('refuses https clones below 2.37, which ignore the address pin', async () => {
    for (const v of ['git version 2.36.9', 'git version 2.30.0', 'git version 1.9.1', 'nonsense']) {
      expect(() => assertGitSupportsPin(v), v).toThrow(GitTooOldError);
    }
    for (const v of ['git version 2.37.0', 'git version 2.54.0.windows.1', 'git version 3.0.0']) {
      expect(() => assertGitSupportsPin(v), v).not.toThrow();
    }
    const d = deps({
      allowLocalSource: false,
      resolveHost: () => Promise.resolve(['93.184.216.34']),
      gitVersionProbe: () => Promise.resolve('git version 2.30.2'),
    });
    const req = request({ source: 'https://git.example.com/a.git', commit: 'a'.repeat(40) });
    await expect(ingestRepo(d, req)).rejects.toBeInstanceOf(GitTooOldError);
    expect(existsSync(join(d.workRoot, String(req.caseId)))).toBe(false);
  });
});

describe('tree caps', () => {
  /** A tree that reuses one directory 20 times per level: 20^3 empty files from four objects. */
  function reuseRepo(): { dir: string; sha: string } {
    const dir = tmpDir();
    git(dir, 'init', '--quiet', '--initial-branch=main');
    const run = (input: string, ...args: string[]): string =>
      execFileSync('git', args, { cwd: dir, input, encoding: 'utf8' }).trim();
    const blob = run('', 'hash-object', '-w', '--stdin');
    let tree = run(`100644 blob ${blob}\tf\n`, 'mktree');
    for (let level = 0; level < 3; level++) {
      const lines = Array.from({ length: 20 }, (_, i) => `040000 tree ${tree}\td${i}\n`);
      tree = run(lines.join(''), 'mktree');
    }
    const sha = git(dir, 'commit-tree', tree, '-m', 'reuse');
    git(dir, 'update-ref', 'refs/heads/main', sha);
    return { dir, sha };
  }

  it('a tree that expands into many empty files is refused before checkout', async () => {
    const { dir, sha } = reuseRepo();
    const d = deps({ maxRepoFiles: 1000 });
    const req = request({ source: dir, commit: sha });
    const err = await ingestRepo(d, req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoTooLargeError);
    expect(err).toMatchObject({ phase: 'tree', what: 'files', limit: 1000 });
    expect(existsSync(join(d.workRoot, String(req.caseId)))).toBe(false);
  });

  it('every entry carries a fixed charge, so empty files still count toward the byte cap', async () => {
    const { dir, sha } = reuseRepo();
    const d = deps({ maxRepoBytes: 100_000 }); // 8000 entries at 4096 each is far over
    await expect(ingestRepo(d, request({ source: dir, commit: sha }))).rejects.toMatchObject({
      name: 'RepoTooLargeError',
      phase: 'tree',
      what: 'bytes',
    });
  });

  it('treeCounter counts sizes and entries', () => {
    const c = treeCounter(10_000, 2);
    c('100644 blob abc       5\ta.txt');
    c('160000 commit abc       -\tsub');
    expect(() => c('100644 blob abc       1\tb.txt')).toThrow(RepoTooLargeError);
  });

  it('an ordinary repository passes the checks', async () => {
    const { dir, shas } = makeRepo([{ 'package.json': EXPRESS_PKG, 'a.js': 'x\n' }]);
    const r = await ingestRepo(
      deps({ maxRepoFiles: 10 }),
      request({ source: dir, commit: shas[0] as string }),
    );
    expect(r.status).toBe('ok');
  });
});

describe('one deadline', () => {
  it('a deadline that has passed fails with timedOut at once and never falls through', async () => {
    const { dir, shas } = makeRepo([{ 'a.js': 'x' }]);
    const home = tmpDir();
    const work = tmpDir();
    const err = await checkoutPinned({
      dir: work,
      home,
      plan: { kind: 'local', path: dir },
      commit: shas[0] as string,
      timeoutMs: -1,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloneFailedError);
    expect(err).toMatchObject({ timedOut: true, step: 'init' });
  });

  it('connect errors collapse to one message for https, but size and time keep their types', () => {
    const raw = new CloneFailedError(
      'fetch',
      'Failed to connect to 10.0.0.5 port 22: Connection refused',
    );
    try {
      collapseFetchError(raw, false);
    } catch (e) {
      expect((e as Error).message).toBe('git fetch failed: the source could not be fetched');
    }
    expect(() => collapseFetchError(raw, true)).toThrow('Connection refused');
    expect(() => collapseFetchError(new RepoTooLargeError('fetch', 1), false)).toThrow(
      RepoTooLargeError,
    );
    expect(() =>
      collapseFetchError(new CloneFailedError('fetch', 'timed out', true), false),
    ).toThrow('timed out');
  });
});

describe('the redactor does not expose values', () => {
  it('nothing public on IngestOk.redactor returns a value', async () => {
    const key = fakeKey();
    const { dir, shas } = makeRepo([
      { 'package.json': EXPRESS_PKG, 'src/a.js': `k = "${key}";\n` },
    ]);
    const r = (await ingestRepo(
      deps(),
      request({ source: dir, commit: shas[0] as string }),
    )) as IngestOk;
    const proto = Object.getPrototypeOf(r.redactor) as object;
    const names = Object.getOwnPropertyNames(proto).sort();
    expect(names).toEqual(['apply', 'applyPath', 'constructor', 'size', 'toJSON']);
    expect((r.redactor as unknown as Record<string, unknown>)['all']).toBeUndefined();
    expect(Object.getOwnPropertyNames(r.redactor)).toEqual([]);
    expect(JSON.stringify([r.redactor.size, r.redactor.toJSON()])).not.toContain(key);
    expect(entriesOf(r.redactor).length).toBe(1); // internal accessor still works
  });
});

describe('errors are scrubbed recursively', () => {
  it('message, stack, path, dest, cause and AggregateError members', () => {
    const r = new SecretRedactor([entry('SECRETSECRET')]);
    const inner = Object.assign(new Error('inner SECRETSECRET'), { path: '/x/SECRETSECRET' });
    const outer = Object.assign(new Error('outer SECRETSECRET', { cause: inner }), {
      dest: '/y/SECRETSECRET',
    });
    const agg = new AggregateError([outer], 'agg SECRETSECRET');
    redactError(agg, r);
    const all = JSON.stringify([
      agg.message,
      agg.stack,
      outer.message,
      outer.stack,
      outer.dest,
      inner.message,
      inner.path,
    ]);
    expect(all).not.toContain('SECRETSECRET');
    expect(outer.dest).toBe('/y/[P]');
  });
});

describe('leak check uses the whole path', () => {
  it('finds a value that spans a directory boundary', async () => {
    const ws = tmpDir();
    mkdirSync(join(ws, 'abcd1234'));
    writeFileSync(join(ws, 'abcd1234', 'efgh5678.txt'), 'x');
    const r = new SecretRedactor([entry('abcd1234/efgh5678')]);
    expect(await findLeaks(ws, r)).toEqual(['abcd1234/efgh5678.txt']);
  });
});
