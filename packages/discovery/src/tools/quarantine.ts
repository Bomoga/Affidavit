import { lstat, mkdir, readdir, rename } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';

/**
 * Repo-controlled files that change what a scanner does: ignore lists, allowlists, per-repo
 * configs, and the git metadata that tools shell out to. A hostile repo can use them to silence a
 * scanner or to run code through git. Flags on each invocation cover most of them; this list
 * covers the rest by moving them out of the scan snapshot.
 *
 * Matched on the exact base name, case-insensitively, at any depth. Never by prefix: a directory
 * such as `.semgrep-lib/` is application code and stays. `.github` stays too: workflows are scan
 * targets. Semgrep's `.semgrep*` config names are not here because Semgrep always runs with
 * `--config /rules` and never reads them from the target (a docker test checks this).
 */
export const TOOL_CONTROL_NAMES: readonly string[] = [
  '.git',
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.gitleaksignore',
  '.gitleaks.toml',
  '.gitleaksbaseline',
  'gitleaks.toml',
  'osv-scanner.toml',
  '.osv-scanner.toml',
  '.semgrepignore',
];

const NAMES = new Set(TOOL_CONTROL_NAMES);

export function isToolControlName(name: string): boolean {
  return NAMES.has(name.toLowerCase());
}

export class SnapshotNotCleanError extends Error {
  readonly found: string[];
  constructor(found: string[]) {
    super(
      `scan snapshot still contains tool-control paths (quarantine it first): ${found.slice(0, 10).join(', ')}`,
    );
    this.name = 'SnapshotNotCleanError';
    this.found = found;
  }
}

export class ScratchNotFreshError extends Error {
  constructor(dir: string) {
    super(`scratch directory must be new and empty for every tool run: ${dir}`);
    this.name = 'ScratchNotFreshError';
  }
}

export class OutputNotFreshError extends Error {
  constructor(dir: string) {
    super(`output directory must be new and empty for every tool run: ${dir}`);
    this.name = 'OutputNotFreshError';
  }
}

// Module-private: the only way to build a QuarantinedSnapshot is quarantineSnapshot below. This is
// a type-level guard, not a security boundary: JavaScript callers can forge the token with a cast.
// runTool therefore re-checks that the snapshot is clean before every run (assertSnapshotClean).
const TOKEN: unique symbol = Symbol('quarantined-snapshot');

/**
 * A scan snapshot that went through quarantine. Only quarantineSnapshot can create one, and
 * runTool takes this type, so a snapshot cannot reach a scanner without being quarantined and the
 * removed-path list travels with it.
 *
 * Quarantined entries are not deleted. They are moved into `sidecarDir` (a sibling of the
 * snapshot) under neutral names, so they are out of the scan tree but can still be scanned for
 * secrets. `mapping` gives neutral name to original path. Keep the sidecar out of any workspace
 * that leaves ingestion; it holds the repo's own ignore lists, git metadata and configs.
 */
export class QuarantinedSnapshot {
  private readonly brand = 'quarantined';
  /** The scan copy, now free of tool-control paths. */
  readonly dir: string;
  /** Original paths that were quarantined, relative to the snapshot, posix separators, sorted. */
  readonly removed: readonly string[];
  /** Directory holding the quarantined entries under neutral names, or null if none were found. */
  readonly sidecarDir: string | null;
  /** Neutral sidecar entry name to original relative path. */
  readonly mapping: ReadonlyMap<string, string>;
  constructor(
    token: typeof TOKEN,
    dir: string,
    sidecarDir: string | null,
    mapping: ReadonlyMap<string, string>,
  ) {
    if (token !== TOKEN) throw new Error('use quarantineSnapshot');
    this.dir = dir;
    this.sidecarDir = sidecarDir;
    this.mapping = mapping;
    this.removed = [...mapping.values()].sort();
  }
}

/** Display form of a raw file name: UTF-8 when it round-trips, else percent-escaped bytes. */
function display(name: Buffer): string {
  const text = name.toString('utf8');
  if (Buffer.from(text, 'utf8').equals(name)) return text;
  return [...name]
    .map((b) =>
      b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `%${b.toString(16).padStart(2, '0')}`,
    )
    .join('');
}

const SEP = Buffer.from(sep);

function child(dir: Buffer, name: Buffer): Buffer {
  return Buffer.concat([dir, SEP, name]);
}

interface Entry {
  abs: Buffer;
  rel: string;
}

/**
 * Finds tool-control entries without changing anything. Never follows symlinks. Names are read as
 * raw bytes so non-UTF-8 names cannot be misread or skipped.
 */
async function collect(dir: Buffer, rel: string[], found: Entry[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true, encoding: 'buffer' })) {
    const abs = child(dir, entry.name);
    const here = [...rel, display(entry.name)];
    const name = entry.name.toString('latin1');
    // Only `.git` is moved as a directory. A directory that merely has a control name (for example
    // `src/.gitignore/evil.js`) holds scannable content, so it stays and is walked; the scanners
    // only act on control names that are files or symlinks.
    if (isToolControlName(name) && (!entry.isDirectory() || name.toLowerCase() === '.git')) {
      found.push({ abs, rel: here.join('/') });
      continue;
    }
    if (entry.isDirectory()) await collect(abs, here, found);
  }
}

/** Lists tool-control paths without changing anything. */
export async function findToolControlPaths(snapshotDir: string): Promise<string[]> {
  const found: Entry[] = [];
  await collect(Buffer.from(snapshotDir), [], found);
  return found.map((e) => e.rel).sort();
}

/**
 * Moves tool-control paths out of a scan snapshot into a sibling sidecar directory
 * (`<snapshot>.quarantine`, which must not exist) and returns the snapshot with the mapping.
 *
 * Two phases: everything is found first, and nothing is touched if that fails. MUTATES THE
 * DIRECTORY, so only ever pass a private copy of the repo made for scanning, never the original
 * checkout. Symlinks are moved as links, never followed.
 */
export async function quarantineSnapshot(snapshotDir: string): Promise<QuarantinedSnapshot> {
  const stat = await lstat(snapshotDir);
  if (!stat.isDirectory()) throw new Error(`snapshot is not a directory: ${snapshotDir}`);
  const found: Entry[] = [];
  await collect(Buffer.from(snapshotDir), [], found);
  if (found.length === 0) return new QuarantinedSnapshot(TOKEN, snapshotDir, null, new Map());

  const sidecar = join(dirname(snapshotDir), `${basename(snapshotDir)}.quarantine`);
  await mkdir(sidecar); // not recursive: fails if it already exists, so no mixing with old runs
  const mapping = new Map<string, string>();
  let i = 0;
  for (const e of found) {
    const neutral = `q${String(++i).padStart(4, '0')}`;
    await rename(e.abs, join(sidecar, neutral));
    mapping.set(neutral, e.rel);
  }
  return new QuarantinedSnapshot(TOKEN, snapshotDir, sidecar, mapping);
}

/** Fails closed: throws SnapshotNotCleanError if any tool-control path is still present. */
export async function assertSnapshotClean(snapshotDir: string): Promise<void> {
  const found = await findToolControlPaths(snapshotDir);
  if (found.length > 0) throw new SnapshotNotCleanError(found);
}

async function requireNewOrEmpty(dir: string, fail: () => Error): Promise<void> {
  try {
    if ((await readdir(dir)).length > 0) throw fail();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/** Creates the per-run scratch subdirectories. The scratch dir must not exist or must be empty. */
export async function prepareScratch(
  scratchDir: string,
  subdirs: readonly string[],
): Promise<void> {
  await requireNewOrEmpty(scratchDir, () => new ScratchNotFreshError(scratchDir));
  for (const sub of subdirs) await mkdir(join(scratchDir, sub), { recursive: true });
}

/** Creates the output directory if needed. It must not exist or must be empty. */
export async function prepareOutput(outputDir: string): Promise<void> {
  await requireNewOrEmpty(outputDir, () => new OutputNotFreshError(outputDir));
  await mkdir(outputDir, { recursive: true });
}

/**
 * Maps a report URI such as `/src/.gitignore` (as rewritten for quarantine-pass reports, or taken
 * from any report) back to the file in the sidecar that holds it, or undefined if that path was
 * not quarantined. L1-01 uses this to read a quarantined file, for example to build its redaction
 * map for a secret found there. The result is an absolute host path inside `sidecarDir`.
 */
export function resolveQuarantinedUri(
  snapshot: QuarantinedSnapshot,
  uri: string,
): string | undefined {
  if (snapshot.sidecarDir === null) return undefined;
  const path = uri.replace(/^file:\/\//, '').replace(/^\/src\//, '');
  if (path.split('/').includes('..')) return undefined;
  for (const [neutral, original] of snapshot.mapping) {
    if (path === original) return join(snapshot.sidecarDir, neutral);
    if (path.startsWith(`${original}/`)) {
      return join(snapshot.sidecarDir, neutral, path.slice(original.length + 1));
    }
  }
  return undefined;
}

const GIT_METADATA = new Set([
  'head',
  'config',
  'config.worktree',
  'description',
  'hooks',
  'info',
  'objects',
  'refs',
  'logs',
  'packed-refs',
  'index',
  'orig_head',
  'fetch_head',
  'merge_head',
  'merge_msg',
  'merge_mode',
  'cherry_pick_head',
  'revert_head',
  'commit_editmsg',
  'auto_merge',
  'bisect_log',
  'shallow',
  'modules',
  'worktrees',
  'lfs',
  'branches',
  'commondir',
  'gitdir',
  'gc.log',
  'gc.pid',
  'sequencer',
  'rebase-merge',
  'rebase-apply',
]);

/**
 * `.git` directories are moved aside and never scanned by Semgrep or OSV-Scanner. If one holds
 * anything other than git metadata, that content (application code, lockfiles) was hidden from
 * them, so the caller marks their results partial. Returns original-relative paths of such
 * entries (top level of the `.git` directory only).
 */
export async function gitDirExtraContent(snapshot: QuarantinedSnapshot): Promise<string[]> {
  if (snapshot.sidecarDir === null) return [];
  const extras: string[] = [];
  for (const [neutral, original] of snapshot.mapping) {
    if (basename(original).toLowerCase() !== '.git') continue;
    const dir = join(snapshot.sidecarDir, neutral);
    const st = await lstat(dir);
    if (!st.isDirectory()) continue;
    for (const name of await readdir(dir)) {
      const lower = name.toLowerCase();
      if (!GIT_METADATA.has(lower) && !lower.endsWith('.lock')) extras.push(`${original}/${name}`);
    }
  }
  return extras.sort();
}
