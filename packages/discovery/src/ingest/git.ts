import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourcePlan } from './source.js';
import {
  CloneFailedError,
  CommitMismatchError,
  GitTooOldError,
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

/**
 * Kills a child and everything it started (git-remote-https runs as a child of git). On POSIX the
 * child must have been spawned `detached` so it leads its own process group; execFile drops that
 * option, which is why git is started with spawn.
 */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** Charge per file or directory in a checked-out tree, so empty files still count. */
export const ENTRY_CHARGE = 4096;

/**
 * Bytes of regular files under a directory, plus `entryCharge` per entry. Never follows symlinks.
 */
export async function dirBytes(dir: string, entryCharge = 0): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    total += entryCharge;
    if (e.isDirectory()) total += await dirBytes(p, entryCharge);
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

const MAX_STDOUT = 1024 * 1024;
const MAX_STDERR = 64 * 1024;
const MAX_LINE = 1024 * 1024;

interface GitOptions {
  exe: string;
  cwd: string;
  home: string;
  local: boolean;
  proxy: boolean;
  /** Absolute time (ms since epoch) by which the whole ingest checkout must be done. */
  deadline: number;
  extraConfig: readonly string[];
  /** Kill the process when this directory grows past maxBytes. */
  watch?: { dir: string; maxBytes: number; entryCharge?: number } | undefined;
  /** Receives stdout line by line instead of buffering it. A throw kills git and rejects. */
  onLine?: ((line: string) => void) | undefined;
}

function runGit(o: GitOptions, args: readonly string[]): Promise<string> {
  const base = [...GIT_CONFIG, ...o.extraConfig].flatMap((c) => ['-c', c]);
  const step = args[0] ?? 'git';
  return new Promise((resolve, reject) => {
    const remaining = o.deadline - Date.now();
    if (remaining <= 0) {
      reject(new CloneFailedError(step, 'timed out', true));
      return;
    }
    let settled = false;
    // Set when we killed the process. The error is raised only once the process has exited, so
    // the caller never deletes a directory a dying git still holds open.
    let killed: Error | undefined;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let partial = '';
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      fn();
    };
    // `detached` makes the child a process group leader on POSIX, so killTree reaches its children.
    const child = spawn(o.exe, [...base, ...args], {
      cwd: o.cwd,
      env: gitEnv(o.home, o.local, o.proxy),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const kill = (why: Error): void => {
      if (killed !== undefined) return;
      killed = why;
      killTree(child);
      setTimeout(() => finish(() => reject(why)), 10_000).unref();
    };
    child.stdout.on('data', (b: Buffer) => {
      if (killed !== undefined) return;
      if (o.onLine !== undefined) {
        partial += b.toString('utf8');
        const lines = partial.split('\n');
        partial = lines.pop() ?? '';
        if (partial.length > MAX_LINE) return kill(new CloneFailedError(step, 'output too large'));
        try {
          for (const l of lines) o.onLine(l);
        } catch (e) {
          kill(e instanceof Error ? e : new Error('line handler failed'));
        }
        return;
      }
      outBytes += b.length;
      if (outBytes > MAX_STDOUT) kill(new CloneFailedError(step, 'output too large'));
      else out.push(b);
    });
    child.stderr.on('data', (b: Buffer) => {
      errBytes += b.length;
      if (errBytes <= MAX_STDERR) err.push(b);
    });
    child.on('error', (e) => {
      finish(() => reject(new CloneFailedError(step, cleanGitError(e.message))));
    });
    child.on('close', (code) => {
      if (killed !== undefined) {
        const why = killed;
        finish(() => reject(why));
      } else if (code === 0) {
        if (o.onLine !== undefined && partial !== '') {
          try {
            o.onLine(partial);
          } catch (e) {
            finish(() => reject(e instanceof Error ? e : new Error('line handler failed')));
            return;
          }
        }
        finish(() => resolve(Buffer.concat(out).toString('utf8')));
      } else {
        finish(() =>
          reject(new CloneFailedError(step, cleanGitError(Buffer.concat(err).toString('utf8')))),
        );
      }
    });
    const timer = setTimeout(() => kill(new CloneFailedError(step, 'timed out', true)), remaining);
    let busy = false;
    const poll = setInterval(
      () => {
        const w = o.watch;
        if (w === undefined || busy) return;
        busy = true;
        void dirBytes(w.dir, w.entryCharge ?? 0).then((n) => {
          busy = false;
          if (n > w.maxBytes) kill(new RepoTooLargeError('fetch', w.maxBytes));
        });
      },
      o.watch ? 250 : 3_600_000,
    );
  });
}

/** git 2.37 added http.curloptResolve; older git ignores it and re-resolves the name. */
export const MIN_GIT_FOR_PIN = [2, 37] as const;

export function assertGitSupportsPin(versionText: string): void {
  const m = /git version (\d+)\.(\d+)/.exec(versionText);
  const major = Number(m?.[1] ?? 0);
  const minor = Number(m?.[2] ?? 0);
  const [needMajor, needMinor] = MIN_GIT_FOR_PIN;
  if (major < needMajor || (major === needMajor && minor < needMinor)) {
    throw new GitTooOldError(cleanGitError(versionText), `${needMajor}.${needMinor}`);
  }
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
  /** One deadline for the whole checkout: fetch, fallback fetch, tree check and checkout. */
  timeoutMs?: number | undefined;
  /** Cap on the fetched objects and on the checked-out tree. Default 1 GiB. */
  maxRepoBytes?: number | undefined;
  /** Cap on the number of files in the commit's tree. Default 200,000. */
  maxRepoFiles?: number | undefined;
  /** Pass HTTPS_PROXY and friends to git. Off: a proxy bypasses the address pin. */
  passProxyEnv?: boolean | undefined;
  /** Returns the text of `git version`. Tests stub it; the default runs git. */
  gitVersionProbe?: (() => Promise<string>) | undefined;
}

export const DEFAULT_MAX_REPO_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_MAX_REPO_FILES = 200_000;

/**
 * -c flags that pin the https connection to the address planSource checked. The URL git gets must
 * name the same host, or curl would not apply the pin.
 */
export function pinConfig(plan: SourcePlan): string[] {
  if (plan.kind !== 'https') return [];
  const urlHost = new URL(plan.url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (urlHost !== plan.host) {
    throw new IngestInputError('source URL host does not match the checked host');
  }
  const ip = plan.ip.includes(':') ? `[${plan.ip}]` : plan.ip;
  return [`http.curloptResolve=${plan.host}:${plan.port}:${ip}`];
}

/** Parses `git ls-tree -r -l` lines and throws RepoTooLargeError past either cap. */
export function treeCounter(maxBytes: number, maxFiles: number): (line: string) => void {
  let files = 0;
  let bytes = 0;
  return (line) => {
    if (line === '') return;
    files++;
    if (files > maxFiles) throw new RepoTooLargeError('tree', maxFiles, 'files');
    const size = Number(/^\S+\s+\S+\s+\S+\s+(\d+)\t/.exec(line)?.[1] ?? 0);
    bytes += size + ENTRY_CHARGE;
    if (bytes > maxBytes) throw new RepoTooLargeError('tree', maxBytes, 'bytes');
  };
}

/**
 * Connect errors collapse to one message for https, so the text cannot be used to probe which
 * ports or hosts answer. Size and time limits keep their own typed errors; local sources keep git's text.
 */
export function collapseFetchError(e: unknown, local: boolean): never {
  if (e instanceof RepoTooLargeError) throw e;
  if (e instanceof CloneFailedError && (e.timedOut || local)) throw e;
  throw new CloneFailedError('fetch', 'the source could not be fetched');
}

/**
 * Fetches exactly one commit and checks it out detached, then verifies by hash. All values that
 * come from outside (URL, hash) are validated first and follow `--`, git runs with a fixed argv
 * and no shell, and nothing is interpolated into a command string. For https the connection is
 * pinned to the address planSource checked (http.curloptResolve), a fetch that grows past the
 * byte cap is killed with its child processes, and the commit's tree is counted before any file
 * is written, so a tree that reuses one directory many times cannot expand into millions of
 * empty files.
 */
export async function checkoutPinned(o: CheckoutOptions): Promise<void> {
  assertFullSha(o.commit);
  const max = o.maxRepoBytes ?? DEFAULT_MAX_REPO_BYTES;
  const maxFiles = o.maxRepoFiles ?? DEFAULT_MAX_REPO_FILES;
  const deadline = Date.now() + (o.timeoutMs ?? 300_000);
  const exe = o.gitExecutable ?? 'git';
  const local = o.plan.kind === 'local';
  const base: GitOptions = {
    exe,
    cwd: o.dir,
    home: o.home,
    local,
    proxy: o.passProxyEnv === true,
    deadline,
    extraConfig: pinConfig(o.plan),
  };
  if (!local) {
    const probe =
      o.gitVersionProbe ?? (() => runGit({ ...base, extraConfig: [], proxy: false }, ['version']));
    assertGitSupportsPin(await probe());
  }
  const src = o.plan.kind === 'https' ? o.plan.url : o.plan.path;
  const watched = { ...base, watch: { dir: join(o.dir, '.git'), maxBytes: max } };
  await runGit(base, ['init', '--quiet', '--initial-branch=affidavit']);
  const noTags = ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--depth=1'];
  try {
    await runGit(watched, [...noTags, '--', src, o.commit]);
  } catch (e) {
    if (e instanceof RepoTooLargeError || (e instanceof CloneFailedError && e.timedOut)) throw e;
    // Some servers refuse a fetch by hash. Fall back to the branch tips (still depth 1).
    try {
      await runGit(watched, [...noTags, '--', src, '+refs/heads/*:refs/remotes/source/*']);
    } catch (e2) {
      collapseFetchError(e2, local);
    }
  }
  if ((await dirBytes(join(o.dir, '.git'))) > max) throw new RepoTooLargeError('fetch', max);
  try {
    await runGit(base, ['cat-file', '-e', `${o.commit}^{commit}`]);
  } catch (e) {
    if (e instanceof CloneFailedError && e.timedOut) throw e;
    throw new CloneFailedError('fetch', 'the pinned commit is not in the source repository');
  }
  await runGit({ ...base, onLine: treeCounter(max, maxFiles) }, [
    'ls-tree',
    '-r',
    '-l',
    '--full-tree',
    o.commit,
    '--',
  ]);
  await runGit({ ...base, watch: { dir: o.dir, maxBytes: max, entryCharge: ENTRY_CHARGE } }, [
    'checkout',
    '--quiet',
    '--force',
    '--detach',
    o.commit,
    '--',
  ]);
  if ((await dirBytes(o.dir, ENTRY_CHARGE)) > max) throw new RepoTooLargeError('checkout', max);
  await verifyHead(o.dir, o.home, o.commit, {
    allowLocal: local,
    gitExecutable: o.gitExecutable,
    deadline,
  });
}

/** Throws CommitMismatchError unless the repository in `dir` has HEAD at exactly `expected`. */
export async function verifyHead(
  dir: string,
  home: string,
  expected: string,
  o: {
    allowLocal: boolean;
    gitExecutable?: string | undefined;
    deadline?: number | undefined;
  } = { allowLocal: false },
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
        deadline: o.deadline ?? Date.now() + 300_000,
        extraConfig: [],
      },
      ['rev-parse', '--verify', 'HEAD^{commit}'],
    )
  ).trim();
  if (actual !== expected) throw new CommitMismatchError(expected, actual);
}
