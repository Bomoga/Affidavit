import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChecksumMismatchError, fetchPinned } from '../scripts/fetch-pinned.mjs';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

const GOOD_PATCH = [
  'diff --git a/hello.txt b/hello.txt',
  '--- a/hello.txt',
  '+++ b/hello.txt',
  '@@ -1 +1 @@',
  '-hello',
  '+goodbye',
  '',
].join('\n');

const BAD_PATCH = GOOD_PATCH.replace('-hello', '-this line is not in the file');

describe('fetchPinned (local throwaway repo, no network)', () => {
  let root: string;
  let repo: string;
  let commit: string;
  let tree: string;
  let archiveSha256: string;
  let base: { repoUrl: string; commit: string; tree: string; archiveSha256: string };

  const leftovers = (): string[] => readdirSync(root).filter((n) => n.includes('-partial-'));
  const patchFile = (name: string, text: string): string => {
    const path = join(root, name);
    writeFileSync(path, text);
    return path;
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'corpus-fetch-'));
    repo = join(root, 'upstream');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'user.name', 'test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    git(repo, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    writeFileSync(join(repo, 'hello.txt'), 'hello\n');
    git(repo, 'add', 'hello.txt');
    git(repo, 'commit', '-q', '-m', 'one');
    commit = git(repo, 'rev-parse', 'HEAD');
    tree = git(repo, 'rev-parse', `${commit}^{tree}`);
    archiveSha256 = createHash('sha256')
      .update(
        execFileSync(
          'git',
          ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', commit],
          { cwd: repo },
        ),
      )
      .digest('hex');
    base = { repoUrl: repo, commit, tree, archiveSha256 };
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const read = (dest: string): string =>
    readFileSync(join(dest, 'hello.txt'), 'utf8').replace(/\r\n/g, '\n');

  it('fetches and extracts when the checksum matches', async () => {
    const dest = join(root, 'ok');
    await fetchPinned({ ...base, dest, allowLocal: true });
    expect(read(dest)).toBe('hello\n');
    expect(leftovers()).toEqual([]);
  });

  it('rejects a wrong checksum, fails closed and leaves no sources behind', async () => {
    const dest = join(root, 'bad');
    await expect(
      fetchPinned({ ...base, archiveSha256: '0'.repeat(64), dest, allowLocal: true }),
    ).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(existsSync(dest)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('rejects a wrong tree hash', async () => {
    const dest = join(root, 'bad-tree');
    await expect(
      fetchPinned({ ...base, tree: '1'.repeat(40), dest, allowLocal: true }),
    ).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(existsSync(dest)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('rejects a malformed commit or checksum before touching git', async () => {
    const dest = join(root, 'malformed');
    await expect(fetchPinned({ ...base, commit: 'main', dest, allowLocal: true })).rejects.toThrow(
      /40 lowercase hex/,
    );
    await expect(
      fetchPinned({ ...base, archiveSha256: 'abc', dest, allowLocal: true }),
    ).rejects.toThrow(/64 lowercase hex/);
    expect(existsSync(dest)).toBe(false);
  });

  it('refuses a non-https url unless local fetches are explicitly allowed', async () => {
    const dest = join(root, 'local-refused');
    await expect(fetchPinned({ ...base, dest })).rejects.toThrow(/https/);
    expect(existsSync(dest)).toBe(false);
  });

  it('refuses to overwrite an existing destination', async () => {
    const dest = join(root, 'exists');
    mkdirSync(dest);
    await expect(fetchPinned({ ...base, dest, allowLocal: true })).rejects.toThrow(
      /already exists/,
    );
  });

  it('applies a good patch inside the verified tree before moving it into place', async () => {
    const dest = join(root, 'patched');
    const path = patchFile('good.patch', GOOD_PATCH);
    await fetchPinned({
      ...base,
      dest,
      allowLocal: true,
      patches: [{ path, sha256: sha(GOOD_PATCH) }],
    });
    expect(read(dest)).toBe('goodbye\n');
    expect(leftovers()).toEqual([]);
  });

  it('rejects a patch whose checksum is wrong and leaves no destination', async () => {
    const dest = join(root, 'patch-sum');
    const path = patchFile('sum.patch', GOOD_PATCH);
    await expect(
      fetchPinned({ ...base, dest, allowLocal: true, patches: [{ path, sha256: sha('other') }] }),
    ).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(existsSync(dest)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('leaves no destination when a patch does not apply, even after an earlier one did', async () => {
    const dest = join(root, 'patch-bad');
    const good = patchFile('g2.patch', GOOD_PATCH);
    const bad = patchFile('b2.patch', BAD_PATCH);
    await expect(
      fetchPinned({
        ...base,
        dest,
        allowLocal: true,
        patches: [
          { path: good, sha256: sha(GOOD_PATCH) },
          { path: bad, sha256: sha(BAD_PATCH) },
        ],
      }),
    ).rejects.toThrow(/apply/);
    expect(existsSync(dest)).toBe(false);
    expect(leftovers()).toEqual([]);
  });
});
