// Helpers shared by the ingest tests. Not part of the package API.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CaseId, RepoId, TenantId, ToolRunnerPort } from '@affidavit/contracts';
import type { IngestRequest } from './types.js';

const dirs: string[] = [];

export function cleanup(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'affidavit-ingest-test-'));
  dirs.push(d);
  return d;
}

/** A clearly fake key, generated at runtime so no secret-shaped literal is committed. */
export function fakeKey(): string {
  return `AFFIDAVIT_FAKE_KEY_${randomBytes(8).toString('hex').toUpperCase()}`;
}

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd, env: GIT_ENV, encoding: 'utf8' },
  ).trim();
}

export type Files = Record<string, string | Buffer>;

function writeFiles(dir: string, files: Files): void {
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, ...rel.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
}

/** Creates a git repo in a temp dir. Each entry of `commits` is a commit on top of the last. */
export function makeRepo(commits: Files[]): { dir: string; shas: string[] } {
  const dir = tmpDir();
  git(dir, 'init', '--quiet', '--initial-branch=main');
  const shas: string[] = [];
  for (const files of commits) {
    writeFiles(dir, files);
    git(dir, 'add', '-A');
    git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'c');
    shas.push(git(dir, 'rev-parse', 'HEAD'));
  }
  return { dir, shas };
}

/**
 * Like makeRepo for a single commit, built with plumbing and no filters, so a .gitattributes in
 * the files cannot change the stored bytes (git add would apply it).
 */
export function plumbingRepo(commits: Files[]): { dir: string; shas: string[] } {
  const dir = tmpDir();
  git(dir, 'init', '--quiet', '--initial-branch=main');
  const run = (input: string | Buffer, ...args: string[]): string =>
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args],
      { cwd: dir, input, env: GIT_ENV, encoding: 'utf8' },
    ).trim();
  const shas: string[] = [];
  let parent: string | undefined;
  for (const files of commits) {
    for (const [rel, body] of Object.entries(files)) {
      const blob = run(
        typeof body === 'string' ? Buffer.from(body) : body,
        'hash-object',
        '-w',
        '--no-filters',
        '--stdin',
      );
      run('', 'update-index', '--add', '--cacheinfo', `100644,${blob},${rel}`);
    }
    const tree = run('', 'write-tree');
    const sha = run('', 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'c');
    git(dir, 'update-ref', 'refs/heads/main', sha);
    shas.push(sha);
    parent = sha;
  }
  return { dir, shas };
}

export const EXPRESS_PKG = JSON.stringify({
  name: 'app',
  version: '1.0.0',
  dependencies: { express: '4.18.2' },
});

export function request(
  over: Partial<IngestRequest> & { source: string; commit: string },
): IngestRequest {
  return {
    tenantId: 'tenant-a' as TenantId,
    caseId: `case-${randomBytes(4).toString('hex')}` as CaseId,
    repo: 'acme/app' as RepoId,
    ...over,
  };
}

export function listFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (rel: string): void => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) visit(r);
      else out.push(r);
    }
  };
  visit('');
  return out.sort();
}

/** Every file under `root` plus the names themselves, as one string, to search for a leak. */
export function everything(root: string): string {
  const parts: string[] = [];
  for (const f of listFiles(root)) {
    parts.push(f, readFileSync(join(root, ...f.split('/'))).toString('latin1'));
  }
  return parts.join('\n');
}

interface FakeOptions {
  /** Only report findings in these repo-relative files (to test global replacement). */
  onlyFiles?: ((rel: string) => boolean) | undefined;
  /** A second pattern to report (same rule id), for short values. */
  extra?: RegExp | undefined;
  /** Throws instead of running. */
  fail?: Error | undefined;
  /**
   * Emulates gitleaks' chunk cuts at their worst: a file over this many bytes is read in hard,
   * non-overlapping chunks of this size, so a key that straddles a cut is NOT reported.
   */
  chunkBytes?: number | undefined;
}

const KEY = /AFFIDAVIT_FAKE_KEY_[0-9A-F]{16}/g;

/**
 * A stand-in for the gitleaks image behind ToolRunnerPort: scans the /src mount for the fake key
 * and writes SARIF to the /out mount, with the real tool's region convention (bytes, inclusive
 * end column, one higher on every line after the first). The docker tests run the real image.
 */
export function fakeGitleaks(opts: FakeOptions = {}): ToolRunnerPort {
  return {
    run(_image, _args, mounts) {
      if (opts.fail) return Promise.reject(opts.fail);
      const src = mounts.find((m) => m.containerPath === '/src')?.hostPath;
      const out = mounts.find((m) => m.containerPath === '/out')?.hostPath;
      if (src === undefined || out === undefined) throw new Error('missing mounts');
      const results: unknown[] = [];
      const visit = (rel: string): void => {
        for (const e of readdirSync(join(src, rel), { withFileTypes: true })) {
          const r = rel === '' ? e.name : `${rel}/${e.name}`;
          if (e.isDirectory()) {
            visit(r);
            continue;
          }
          if (opts.onlyFiles && !opts.onlyFiles(r)) continue;
          const text = readFileSync(join(src, r)).toString('latin1');
          const lines = text.split('\n');
          const chunk = opts.chunkBytes;
          let lineStart = 0;
          lines.forEach((line, i) => {
            const at = lineStart;
            lineStart += line.length + 1;
            for (const m of [
              ...line.matchAll(KEY),
              ...(opts.extra ? line.matchAll(opts.extra) : []),
            ]) {
              if (chunk !== undefined && text.length > chunk) {
                const from = at + m.index;
                const to = from + m[0].length - 1;
                if (Math.floor(from / chunk) !== Math.floor(to / chunk)) continue; // cut through
              }
              const shift = i === 0 ? 1 : 2;
              results.push({
                ruleId: 'affidavit-fake-fixture-key',
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: `/src/${r}` },
                      region: {
                        startLine: i + 1,
                        startColumn: m.index + shift,
                        endLine: i + 1,
                        endColumn: m.index + m[0].length + shift - 1,
                        snippet: { text: 'REDACTED' },
                      },
                    },
                  },
                ],
              });
            }
          });
        }
      };
      visit('');
      mkdirSync(out, { recursive: true });
      writeFileSync(
        join(out, 'gitleaks.sarif'),
        JSON.stringify({
          version: '2.1.0',
          runs: [{ tool: { driver: { name: 'gitleaks' } }, results }],
        }),
      );
      return Promise.resolve({ exitCode: 0, outputPath: out });
    },
  };
}
