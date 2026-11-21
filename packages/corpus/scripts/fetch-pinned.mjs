#!/usr/bin/env node
// Fetch a corpus app at a pinned commit and verify it, failing closed.
//
// Usage: node scripts/fetch-pinned.mjs <app> [vulnerable|safe|negative-control]
//   Fetched sources land in data/src/<app>[-<variant>] (gitignored, never committed).
//
// Every git call uses an argument array (execFile), never a shell string. The fetched content
// is untrusted data: nothing in it is executed here, and `git archive`/`checkout` only read it.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export class ChecksumMismatchError extends Error {
  /**
   * @param {string} what
   * @param {string} expected
   * @param {string} actual
   */
  constructor(what, expected, actual) {
    super(`${what} mismatch: expected ${expected}, got ${actual}`);
    this.name = 'ChecksumMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * @param {string[]} args
 * @param {{ cwd?: string; encoding?: 'utf8' | 'buffer'; input?: Buffer }} [opts]
 * @returns {Promise<string | Buffer>}
 */
function git(args, opts = {}) {
  const encoding = opts.encoding ?? 'utf8';
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd: opts.cwd, encoding, maxBuffer: 512 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args.join(' ')} failed: ${String(stderr) || error.message}`));
        } else {
          resolvePromise(stdout);
        }
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.input);
  });
}

/** @param {string | Buffer} data */
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const CFG = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'protocol.ext.allow=never'];

/**
 * Fetch the pinned commit, verify commit, tree and archive checksum, apply patches, and only then
 * move the result into place. Any failure deletes the private temp dir; `dest` never holds an
 * unverified or half-patched tree.
 * @param {{ repoUrl: string; commit: string; tree: string; archiveSha256: string; dest: string; patches?: { path: string; sha256: string }[]; allowLocal?: boolean }} opts
 */
export async function fetchPinned({
  repoUrl,
  commit,
  tree,
  archiveSha256,
  dest,
  patches = [],
  allowLocal = false,
}) {
  if (!COMMIT_RE.test(commit)) throw new Error('commit must be 40 lowercase hex characters');
  if (!COMMIT_RE.test(tree)) throw new Error('tree must be 40 lowercase hex characters');
  if (!SHA256_RE.test(archiveSha256)) {
    throw new Error('archiveSha256 must be 64 lowercase hex characters');
  }
  if (!allowLocal && !repoUrl.startsWith('https://')) {
    throw new Error('repoUrl must use https (pass allowLocal only for local test repos)');
  }
  const target = resolve(dest);
  if (existsSync(target)) throw new Error(`destination already exists: ${target}`);

  mkdirSync(dirname(target), { recursive: true });
  const partial = mkdtempSync(join(dirname(target), `.${basename(target)}-partial-`));
  const transport = allowLocal
    ? ['-c', 'protocol.file.allow=always']
    : ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always'];
  try {
    await git(['init', '-q', '--', partial]);
    await git(['config', 'core.autocrlf', 'false'], { cwd: partial });
    await git(
      [...CFG, ...transport, 'fetch', '-q', '--no-tags', '--depth', '1', '--', repoUrl, commit],
      {
        cwd: partial,
      },
    );
    const head = String(await git(['rev-parse', 'FETCH_HEAD^{commit}'], { cwd: partial })).trim();
    if (head !== commit) throw new ChecksumMismatchError('commit', commit, head);
    const actualTree = String(
      await git(['rev-parse', `${commit}^{tree}`], { cwd: partial }),
    ).trim();
    if (actualTree !== tree) throw new ChecksumMismatchError('tree', tree, actualTree);
    const archive = /** @type {Buffer} */ (
      await git([...CFG, 'archive', '--format=tar', commit], { cwd: partial, encoding: 'buffer' })
    );
    const actual = sha256(archive);
    if (actual !== archiveSha256)
      throw new ChecksumMismatchError('archive sha256', archiveSha256, actual);
    await git([...CFG, 'checkout', '-q', '--detach', commit], { cwd: partial });
    await applyPatches({ dir: partial, patches });
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
  renameSync(partial, target);
}

/**
 * Apply patches in order. Each patch file is read once; the verified bytes are what git applies
 * (via stdin). All checksums are verified before anything is applied. Callers must treat the
 * directory as disposable on error (fetchPinned deletes it).
 * @param {{ dir: string; patches: { path: string; sha256: string }[] }} opts
 */
export async function applyPatches({ dir, patches }) {
  const cwd = resolve(dir);
  const loaded = patches.map((p) => {
    const bytes = readFileSync(p.path);
    const actual = sha256(bytes);
    if (actual !== p.sha256) throw new ChecksumMismatchError(`patch ${p.path}`, p.sha256, actual);
    return { path: p.path, bytes };
  });
  for (const p of loaded) {
    const args = ['apply', '--whitespace=nowarn'];
    await git([...args, '--check', '-'], { cwd, input: p.bytes });
    await git([...args, '-'], { cwd, input: p.bytes });
  }
}

async function main() {
  const [app, variant = 'vulnerable'] = process.argv.slice(2);
  if (app !== 'nodegoat')
    throw new Error('usage: fetch-pinned.mjs nodegoat [vulnerable|safe|negative-control]');
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = join(here, '..', 'data');
  const pin = JSON.parse(readFileSync(join(dataDir, app, 'pin.json'), 'utf8'));
  const meta = JSON.parse(readFileSync(join(dataDir, app, 'app.json'), 'utf8'));
  /** @type {string[]} */
  let patchIds = [];
  if (variant === 'safe') patchIds = meta.safeVariants[0].patches;
  else if (variant === 'negative-control') patchIds = meta.negativeControls[0].patches;
  else if (variant !== 'vulnerable') throw new Error(`unknown variant: ${variant}`);

  const dest = join(dataDir, 'src', variant === 'vulnerable' ? app : `${app}-${variant}`);
  await fetchPinned({
    repoUrl: pin.repoUrl,
    commit: pin.commit,
    tree: pin.tree,
    archiveSha256: pin.archiveSha256,
    dest,
    patches: patchIds.map((id) => ({
      path: join(dataDir, app, pin.patches[id].path),
      sha256: pin.patches[id].sha256,
    })),
  });
  console.log(`${app} ${variant} ready at ${dest} (commit ${pin.commit})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
