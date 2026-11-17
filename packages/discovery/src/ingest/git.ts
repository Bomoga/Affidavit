import { execFile, type ChildProcess } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourcePlan } from './source.js';
import {
  CloneFailedError,
  CommitMismatchError,
  IngestInputError,
  RepoTooLargeError,
} from './types.js';

const FULL_SHA = /^[0-9a-f]{40}$/;

export function assertFullSha(commit: string): void {
  if (!FULL_SHA.test(commit)) {
    throw new IngestInputError('commit must be a full 40 character lowercase hex hash');
  }
}

const NULL_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null';

/**
 * Config for every git call, as -c flags: nothing from the repo or the host's git config can
 * run code. Hooks off, no filter drivers (so LFS never smudges), no fsmonitor, no symlinks
 * written to disk (a symlink in the repo becomes a plain file holding its target text), no
 * autocrlf (bytes stay as committed), no submodule recursion, no credential helpers, no
 * redirects (a redirect would leave the address that was checked), no proxy from config.
 */
export const GIT_CONFIG: readonly string[] = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.symlinks=false',
  'core.autocrlf=false',
  'core.protectNTFS=true',
  'core.protectHFS=true',
  'core.attributesFile=',
  'core.excludesFile=',
  'submodule.recurse=false',
  'fetch.recurseSubmodules=false',
  'filter.lfs.smudge=',
  'filter.lfs.process=',
  'filter.lfs.clean=',
  'filter.lfs.required=false',
  'transfer.fsckObjects=true',
  'credential.helper=',
  'advice.detachedHead=false',
  'gc.auto=0',
  'maintenance.auto=false',
  'http.followRedirects=false',
  'http.proxy=',
];

const PASS_ENV = [
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];
// A proxy would make the connection somewhere other than the address that was checked, so these
// are only passed when the caller opts in.
const PROXY_ENV = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
];

export function gitEnv(home: string, local: boolean, proxy: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of proxy ? [...PASS_ENV, ...PROXY_ENV] : PASS_ENV) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: NULL_PATH,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_ALLOW_PROTOCOL: local ? 'https:file' : 'https',
  };
}

/** Kills a child and everything it started (git-remote-https runs as a child of git). */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL'); // the child is a group leader (detached)
  } catch {
    child.kill('SIGKILL');
  }
}

/** Total bytes of regular files under a directory. Never follows symlinks. */
export async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await dirBytes(p);
    else if (e.isFile()) total += (await lstat(p).catch(() => undefined))?.size ?? 0;
  }
  return total;
}

/** Strips `remote:` lines (server text) and anything that is not printable ASCII. */
export function cleanGitError(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*remote:/i.test(l))
    .join(' | ')
    .replace(/[^\x20-\x7e]/g, '?')
    .trim()
    .slice(0, 300);
}

interface GitOptions {
  exe: string;
  cwd: string;
  home: string;
  local: boolean;
  proxy: boolean;
  timeoutMs: number;
  extraConfig: readonly string[];
  /** Kill the process when this directory grows past maxBytes. */
  watch?: { dir: string; maxBytes: number } | undefined;
}

function runGit(o: GitOptions, args: readonly string[]): Promise<string> {
  const base = [...GIT_CONFIG, ...o.extraConfig].flatMap((c) => ['-c', c]);
  return new Promise((resolve, reject) => {
    let settled = false;
    // Set when we killed the process. The error is raised only once the process has exited, so
    // the caller never deletes a directory a dying git still holds open.
    let killed: Error | undefined;
    const kill = (why: Error): void => {
      if (killed !== undefined) return;
      killed = why;
      killTree(child);
      setTimeout(() => finish(() => reject(why)), 10_000).unref();
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      fn();
    };
    // `detached` makes the child a process group leader on POSIX, so killTree can reach its children.
    // It is a valid spawn option that ExecFileOptions does not declare, hence the variable.
    const options = {
      cwd: o.cwd,
      env: gitEnv(o.home, o.local, o.proxy),
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
      detached: process.platform !== 'win32',
    } as const;
    const child = execFile(o.exe, [...base, ...args], options, (error, stdout, stderr) => {
      if (killed !== undefined) {
        const why = killed;
        finish(() => reject(why));
      } else if (error === null) finish(() => resolve(stdout));
      else {
        finish(() =>
          reject(new CloneFailedError(args[0] ?? 'git', cleanGitError(stderr || error.message))),
        );
      }
    });
    const timer = setTimeout(() => {
      kill(new CloneFailedError(args[0] ?? 'git', 'timed out'));
    }, o.timeoutMs);
    let busy = false;
    const poll = setInterval(
      () => {
        const w = o.watch;
        if (w === undefined || busy) return;
        busy = true;
        void dirBytes(w.dir).then((n) => {
          busy = false;
          if (n > w.maxBytes) {
            kill(new RepoTooLargeError('fetch', w.maxBytes));
          }
        });
      },
      o.watch ? 250 : 3_600_000,
    );
  });
}

export interface CheckoutOptions {
  /** Empty directory that becomes the work tree (with a `.git` inside). Created by the caller. */
  dir: string;
  /** A private directory used as HOME so no user git config is read. */
  home: string;
  /** From planSource: the validated source and, for https, the address git is pinned to. */
  plan: SourcePlan;
  commit: string;
  gitExecutable?: string | undefined;
  timeoutMs?: number | undefined;
  /** Cap on the fetched objects and on the checked-out tree. Default 1 GiB. */
  maxRepoBytes?: number | undefined;
  /** Pass HTTPS_PROXY and friends to git. Off: a proxy bypasses the address pin. */
  passProxyEnv?: boolean | undefined;
}

/** -c flags that pin the https connection to the address planSource checked. */
export function pinConfig(plan: SourcePlan): string[] {
  if (plan.kind !== 'https') return [];
  const ip = plan.ip.includes(':') ? `[${plan.ip}]` : plan.ip;
  return [`http.curloptResolve=${plan.host}:${plan.port}:${ip}`];
}

export const DEFAULT_MAX_REPO_BYTES = 1024 * 1024 * 1024;

/**
 * Fetches exactly one commit and checks it out detached, then verifies by hash. All values that
 * come from outside (URL, hash) are validated first and follow `--`, git runs through execFile
 * with a fixed argv, and nothing is interpolated into a shell string. For https the connection
 * is pinned to the address planSource checked (http.curloptResolve), and a fetch that grows past
 * the byte cap is killed with its child processes.
 */
export async function checkoutPinned(o: CheckoutOptions): Promise<void> {
  assertFullSha(o.commit);
  const max = o.maxRepoBytes ?? DEFAULT_MAX_REPO_BYTES;
  const pin = pinConfig(o.plan);
  const base: GitOptions = {
    exe: o.gitExecutable ?? 'git',
    cwd: o.dir,
    home: o.home,
    local: o.plan.kind === 'local',
    proxy: o.passProxyEnv === true,
    timeoutMs: o.timeoutMs ?? 300_000,
    extraConfig: pin,
  };
  const src = o.plan.kind === 'https' ? o.plan.url : o.plan.path;
  const watched = { ...base, watch: { dir: join(o.dir, '.git'), maxBytes: max } };
  await runGit(base, ['init', '--quiet', '--initial-branch=affidavit']);
  const noTags = ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--depth=1'];
  try {
    await runGit(watched, [...noTags, '--', src, o.commit]);
  } catch (e) {
    if (e instanceof RepoTooLargeError) throw e;
    // Some servers refuse a fetch by hash. Fall back to the branch tips (still depth 1).
    await runGit(watched, [...noTags, '--', src, '+refs/heads/*:refs/remotes/source/*']);
  }
  if ((await dirBytes(join(o.dir, '.git'))) > max) throw new RepoTooLargeError('fetch', max);
  try {
    await runGit(base, ['cat-file', '-e', `${o.commit}^{commit}`]);
  } catch {
    throw new CloneFailedError('fetch', 'the pinned commit is not in the source repository');
  }
  await runGit({ ...base, watch: { dir: o.dir, maxBytes: max } }, [
    'checkout',
    '--quiet',
    '--force',
    '--detach',
    o.commit,
    '--',
  ]);
  if ((await dirBytes(o.dir)) > max) throw new RepoTooLargeError('checkout', max);
  await verifyHead(o.dir, o.home, o.commit, {
    allowLocal: o.plan.kind === 'local',
    gitExecutable: o.gitExecutable,
    timeoutMs: o.timeoutMs,
  });
}

/** Throws CommitMismatchError unless the repository in `dir` has HEAD at exactly `expected`. */
export async function verifyHead(
  dir: string,
  home: string,
  expected: string,
  o: { allowLocal: boolean; gitExecutable?: string | undefined; timeoutMs?: number | undefined } = {
    allowLocal: false,
  },
): Promise<void> {
  assertFullSha(expected);
  const actual = (
    await runGit(
      {
        exe: o.gitExecutable ?? 'git',
        cwd: dir,
        home,
        local: o.allowLocal,
        proxy: false,
        timeoutMs: o.timeoutMs ?? 300_000,
        extraConfig: [],
      },
      ['rev-parse', '--verify', 'HEAD^{commit}'],
    )
  ).trim();
  if (actual !== expected) throw new CommitMismatchError(expected, actual);
}
