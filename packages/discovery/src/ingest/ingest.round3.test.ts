import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { checkoutPinned, killAllGit, liveGitChildren, trackChild } from './git.js';
import {
  CleanupFailedError,
  CloneFailedError,
  ingestRepo,
  RepoTooLargeError,
  type IngestDeps,
} from './index.js';
import { redactError } from './ingest.js';
import { holdsUtf16, SecretRedactor } from './redactor.js';
import {
  cleanup,
  EXPRESS_PKG,
  fakeGitleaks,
  git,
  listFiles,
  makeRepo,
  request,
  tmpDir,
} from './testkit.js';
import { buildWorkspace, isEnvName } from './workspace.js';

vi.setConfig({ testTimeout: 180_000 });
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

describe('fallback fetch', () => {
  /** A repo with one commit A, a tip B, and many deeply nested refs at B. */
  function nestedRefs(n: number): { dir: string; a: string; b: string } {
    const dir = tmpDir();
    git(dir, 'init', '--quiet', '--initial-branch=main');
    writeFileSync(join(dir, 'f'), '1');
    git(dir, 'add', '-A');
    git(dir, 'commit', '--quiet', '-m', 'a');
    const a = git(dir, 'rev-parse', 'HEAD');
    writeFileSync(join(dir, 'f'), '2');
    git(dir, 'commit', '--quiet', '-am', 'b');
    const b = git(dir, 'rev-parse', 'HEAD');
    const lines = Array.from(
      { length: n },
      (_, i) => `create refs/heads/${'d/'.repeat(10)}r${i} ${b}\n`,
    );
    execFileSync('git', ['update-ref', '--stdin'], { cwd: dir, input: lines.join('') });
    return { dir, a, b };
  }
  const opts = (dir: string, commit: string, extra = {}) => ({
    dir: tmpDir(),
    home: tmpDir(),
    plan: { kind: 'local' as const, path: dir },
    commit,
    ...extra,
  });
  const files = (root: string): string[] => {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else out.push(join(d, e.name));
      }
    };
    walk(root);
    return out;
  };

  it('fetches only the ref at the commit and writes no refs for the others', async () => {
    const { dir, b } = nestedRefs(300);
    const o = opts(dir, b, { forceFallback: true });
    await checkoutPinned(o);
    expect(readFileSync(join(o.dir, 'f'), 'utf8')).toBe('2');
    // no loose refs at all: the ref names the server advertises never become files
    expect(files(join(o.dir, '.git', 'refs'))).toEqual([]);
    // and it went through the ref, not the commit hash: FETCH_HEAD names a branch
    expect(readFileSync(join(o.dir, '.git', 'FETCH_HEAD'), 'utf8')).toMatch(/branch 'd\/d\//);
  });

  it('a commit no ref points at cannot be fetched this way, with a typed error', async () => {
    const { dir, a } = nestedRefs(30);
    const err = await checkoutPinned(opts(dir, a, { forceFallback: true })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CloneFailedError);
  });

  it('caps the refs a server may advertise', async () => {
    const { dir, b } = nestedRefs(300);
    const err = await checkoutPinned(opts(dir, b, { forceFallback: true, maxRefs: 50 })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RepoTooLargeError);
    expect(err).toMatchObject({ phase: 'refs' });
  });
});

describe('the tree check charges directories', () => {
  it('counts tree entries too, so directories cannot hide in the file cap', async () => {
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
    // 8000 files alone would pass a cap of 8000; the 8420 directories on top must not.
    const d = deps({ maxRepoFiles: 8000 });
    const err = await ingestRepo(d, request({ source: dir, commit: sha })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoTooLargeError);
    expect(err).toMatchObject({ phase: 'tree', what: 'files' });
  });
});

describe('.env copies', () => {
  const excluded = [
    '.env',
    '.env copy',
    '.env - Copy',
    '.env (1)',
    '.env ',
    '.env+old',
    '.env@prod',
    '#.env#',
    '#.env.local#',
    '.ENV copy',
    '.env~',
    '.env1',
    '.envlocal',
    '.env-local',
    '.env_production',
  ];
  const kept = ['.environment', '.envelope', '.environ', 'env.js', 'environment.js', 'dotenv.js'];
  it.each(excluded)('excludes %j', (n) => expect(isEnvName(n)).toBe(true));
  it.each(kept)('keeps %j', (n) => expect(isEnvName(n)).toBe(false));
});

describe('UTF-16 in either order, and whole-line values', () => {
  it('finds little and big endian copies of exact and line-fallback values', () => {
    const le = Buffer.from('prefix SECRETVALUE1 suffix', 'utf16le');
    const be = Buffer.from(le).swap16();
    for (const exact of [true, false]) {
      const entries = [entry('SECRETVALUE1', { exact })];
      expect(holdsUtf16(le, entries)).toBe(true);
      expect(holdsUtf16(be, entries)).toBe(true);
      expect(holdsUtf16(Buffer.from('plain'), entries)).toBe(false);
    }
  });
});

describe('workspace writes never overwrite', () => {
  it('two names that end up the same keep the first and exclude the second', async () => {
    const raw = tmpDir();
    writeFileSync(join(raw, 'fooREDACTED-1.js'), 'first');
    writeFileSync(join(raw, 'fooSECRETSECRET.js'), 'second');
    const ws = join(tmpDir(), 'ws');
    const r = new SecretRedactor([entry('SECRETSECRET')]);
    const built = await buildWorkspace(raw, ws, r, new Map(), 1 << 20);
    expect(listFiles(ws)).toEqual(['fooREDACTED-1.js']);
    expect(built.excluded).toEqual([{ path: 'fooREDACTED-1.js', reason: 'name-collision' }]);
    expect(readFileSync(join(ws, 'fooREDACTED-1.js'), 'utf8')).toBe('first');
  });
});

describe('errors', () => {
  it('scrub every own string and string-array field, not just message and stack', () => {
    const r = new SecretRedactor([entry('SECRETSECRET')]);
    const e = Object.assign(new Error('x'), {
      dir: '/a/SECRETSECRET',
      paths: ['/b/SECRETSECRET', 'ok'],
      count: 3,
    });
    redactError(e, r);
    expect(e.dir).toBe('/a/[P]');
    expect(e.paths).toEqual(['/b/[P]', 'ok']);
    expect(e.count).toBe(3);
  });

  it('CleanupFailedError carries the original error as its cause', () => {
    const original = new Error('boom');
    const e = new CleanupFailedError('/x/case', original);
    expect(e.cause).toBe(original);
  });
});

describe('live git children', () => {
  it('are killed together on shutdown, and a finished run leaves none', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    });
    trackChild(child);
    expect(liveGitChildren()).toBeGreaterThan(0);
    const exited = new Promise<void>((r) => child.once('close', () => r()));
    killAllGit();
    await exited;
    expect(liveGitChildren()).toBe(0);

    const { dir, shas } = makeRepo([{ 'package.json': EXPRESS_PKG, 'a.js': 'x' }]);
    await ingestRepo(deps(), request({ source: dir, commit: shas[0] as string }));
    expect(liveGitChildren()).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });
});
