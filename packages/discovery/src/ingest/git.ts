import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CloneFailedError, CommitMismatchError, IngestInputError } from './types.js';

const FULL_SHA = /^[0-9a-f]{40}$/;

export function assertFullSha(commit: string): void {
  if (!FULL_SHA.test(commit)) {
    throw new IngestInputError('commit must be a full 40 character lowercase hex hash');
  }
}

const PRIVATE_V4 = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/** Cheap SSRF guard on the literal host. DNS rebinding is not handled here (egress policy is). */
function blockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h.includes(':')) return h === '::1' || h.startsWith('fe80:') || /^f[cd]/.test(h);
  return PRIVATE_V4.some((re) => re.test(h));
}

/**
 * Returns the string to hand git after `--`. https only unless local sources are allowed. A URL
 * with credentials is refused so a token can never reach a log line or an error message.
 */
export function validateSource(source: string, allowLocal: boolean): string {
  if (source.length === 0 || source.length > 2048 || /[\0\r\n]/.test(source)) {
    throw new IngestInputError('source is empty, too long, or has control characters');
  }
  if (allowLocal) {
    let path: string | undefined;
    if (/^file:/i.test(source)) path = fileURLToPath(source);
    else if (isAbsolute(source)) path = source;
    if (path !== undefined) {
      let ok: boolean;
      try {
        ok = statSync(path).isDirectory();
      } catch {
        ok = false;
      }
      if (!ok) throw new IngestInputError('local source is not a directory');
      return path;
    }
  }
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new IngestInputError('source is not a valid https URL');
  }
  if (url.protocol !== 'https:') throw new IngestInputError('source must be an https URL');
  if (url.username !== '' || url.password !== '') {
    throw new IngestInputError('source URL must not carry credentials');
  }
  if (blockedHost(url.hostname)) throw new IngestInputError('source host is not allowed');
  return url.toString();
}

const NULL_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null';

/**
 * Config for every git call, as -c flags: nothing from the repo or the host's git config can
 * run code. Hooks off, no filter drivers (so LFS never smudges), no fsmonitor, no symlinks
 * written to disk (a symlink in the repo becomes a plain file holding its target text), no
 * autocrlf (bytes stay as committed), no submodule recursion, no credential helpers.
 */
const GIT_CONFIG: readonly string[] = [
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
];

const PASS_ENV = [
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];

function gitEnv(home: string, allowLocal: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of PASS_ENV) {
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
    GIT_ALLOW_PROTOCOL: allowLocal ? 'https:file' : 'https',
  };
}

interface Runner {
  git(args: readonly string[]): Promise<string>;
}

function runner(
  exe: string,
  cwd: string,
  home: string,
  allowLocal: boolean,
  timeoutMs: number,
): Runner {
  const base = GIT_CONFIG.flatMap((c) => ['-c', c]);
  return {
    git(args) {
      return new Promise((resolve, reject) => {
        execFile(
          exe,
          [...base, ...args],
          {
            cwd,
            env: gitEnv(home, allowLocal),
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            encoding: 'utf8',
          },
          (error, stdout, stderr) => {
            if (error === null) {
              resolve(stdout);
              return;
            }
            const why = (stderr || error.message).trim().split('\n').slice(-3).join(' | ');
            reject(new CloneFailedError(args[0] ?? 'git', why.slice(0, 500)));
          },
        );
      });
    },
  };
}

export interface CheckoutOptions {
  /** Empty directory that becomes the work tree (with a `.git` inside). Created by the caller. */
  dir: string;
  /** A private directory used as HOME so no user git config is read. */
  home: string;
  source: string;
  commit: string;
  allowLocal: boolean;
  gitExecutable?: string | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Fetches exactly one commit and checks it out detached, then verifies by hash. All values that
 * come from outside (URL, hash) are validated first and follow `--`, git runs through execFile
 * with a fixed argv, and nothing is interpolated into a shell string.
 */
export async function checkoutPinned(o: CheckoutOptions): Promise<void> {
  assertFullSha(o.commit);
  const src = validateSource(o.source, o.allowLocal);
  const g = runner(o.gitExecutable ?? 'git', o.dir, o.home, o.allowLocal, o.timeoutMs ?? 300_000);
  await g.git(['init', '--quiet', '--initial-branch=affidavit']);
  const noTags = ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules'];
  try {
    await g.git([...noTags, '--depth=1', '--', src, o.commit]);
  } catch {
    // Some servers refuse a fetch by hash. Fall back to the branches, then check the hash exists.
    await g.git([...noTags, '--', src, '+refs/heads/*:refs/remotes/source/*']);
  }
  try {
    await g.git(['cat-file', '-e', `${o.commit}^{commit}`]);
  } catch {
    throw new CloneFailedError('fetch', 'the pinned commit is not in the source repository');
  }
  await g.git(['checkout', '--quiet', '--force', '--detach', o.commit, '--']);
  await verifyHead(o.dir, o.home, o.commit, o);
}

/** Throws CommitMismatchError unless the repository in `dir` has HEAD at exactly `expected`. */
export async function verifyHead(
  dir: string,
  home: string,
  expected: string,
  o: Pick<CheckoutOptions, 'allowLocal' | 'gitExecutable' | 'timeoutMs'> = { allowLocal: false },
): Promise<void> {
  assertFullSha(expected);
  const g = runner(o.gitExecutable ?? 'git', dir, home, o.allowLocal, o.timeoutMs ?? 300_000);
  const actual = (await g.git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  if (actual !== expected) throw new CommitMismatchError(expected, actual);
}
