import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChecksumMismatchError, fetchPinned } from '../scripts/fetch-pinned.mjs';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('fetchPinned (local throwaway repo, no network)', () => {
  let root: string;
  let repo: string;
  let commit: string;
  let archiveSha256: string;

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
    archiveSha256 = createHash('sha256')
      .update(
        execFileSync(
          'git',
          ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', commit],
          { cwd: repo },
        ),
      )
      .digest('hex');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('fetches and extracts when the checksum matches', async () => {
    const dest = join(root, 'ok');
    await fetchPinned({ repoUrl: repo, commit, archiveSha256, dest, allowLocal: true });
    expect(readFileSync(join(dest, 'hello.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('hello\n');
  });

  it('rejects a wrong checksum, fails closed and leaves no sources behind', async () => {
    const dest = join(root, 'bad');
    const wrong = '0'.repeat(64);
    await expect(
      fetchPinned({ repoUrl: repo, commit, archiveSha256: wrong, dest, allowLocal: true }),
    ).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(existsSync(dest)).toBe(false);
  });

  it('rejects a malformed commit or checksum before touching git', async () => {
    const dest = join(root, 'malformed');
    await expect(
      fetchPinned({ repoUrl: repo, commit: 'main', archiveSha256, dest, allowLocal: true }),
    ).rejects.toThrow(/40 lowercase hex/);
    await expect(
      fetchPinned({ repoUrl: repo, commit, archiveSha256: 'abc', dest, allowLocal: true }),
    ).rejects.toThrow(/64 lowercase hex/);
    expect(existsSync(dest)).toBe(false);
  });

  it('refuses a non-https url unless local fetches are explicitly allowed', async () => {
    const dest = join(root, 'local-refused');
    await expect(fetchPinned({ repoUrl: repo, commit, archiveSha256, dest })).rejects.toThrow(
      /https/,
    );
    expect(existsSync(dest)).toBe(false);
  });

  it('refuses to overwrite an existing destination', async () => {
    const dest = join(root, 'exists');
    mkdirSync(dest);
    await expect(
      fetchPinned({ repoUrl: repo, commit, archiveSha256, dest, allowLocal: true }),
    ).rejects.toThrow(/already exists/);
  });
});
