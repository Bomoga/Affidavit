import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';

/**
 * Repo-controlled files that change what a scanner does: ignore lists, allowlists, per-repo
 * configs, and the git metadata that tools shell out to. A hostile repo can use them to silence a
 * scanner or to run code through git. Flags on each invocation cover most of them; this list
 * covers the rest by removing them from the scan snapshot.
 *
 * Matched on the exact base name, case-insensitively, at any depth. Never by prefix: a directory
 * such as `.semgrep-lib/` is application code and stays. `.github` stays too: workflows are scan
 * targets.
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
  '.semgrep.yml',
  '.semgrep.yaml',
  '.semgrep',
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

/** A control directory (`.semgrep/`) holds something other than YAML config, so it may be app code. */
export class ControlDirectoryHoldsCodeError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(
      `refusing to delete ${path}: it holds files other than tool config; treat the repo as hostile or review it`,
    );
    this.name = 'ControlDirectoryHoldsCodeError';
    this.path = path;
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

/**
 * A scan snapshot that went through quarantine. The only way to get one is quarantineSnapshot, and
 * runTool takes this type, so the list of removed paths travels with the snapshot and cannot be
 * dropped on the floor. Record `removed` as a signal on the case.
 */
export class QuarantinedSnapshot {
  // Private member makes the type nominal: a plain `{ dir, removed }` object does not satisfy it.
  private readonly brand = 'quarantined';
  readonly dir: string;
  /** Paths removed from the snapshot, relative to it, posix separators, sorted. */
  readonly removed: readonly string[];
  constructor(dir: string, removed: readonly string[]) {
    this.dir = dir;
    this.removed = removed;
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

/** True if a directory holds only YAML config files (recursively), by name, without following links. */
async function holdsOnlyYaml(dir: Buffer): Promise<boolean> {
  for (const e of await readdir(dir, { withFileTypes: true, encoding: 'buffer' })) {
    const full = child(dir, e.name);
    if (e.isDirectory()) {
      if (!(await holdsOnlyYaml(full))) return false;
    } else if (!(e.isFile() && /\.ya?ml$/i.test(e.name.toString('latin1')))) {
      return false;
    }
  }
  return true;
}

/**
 * Walks the snapshot without following symlinks. Names are read as raw bytes so non-UTF-8 names
 * cannot be misread or skipped.
 */
async function walk(dir: Buffer, rel: string[], remove: boolean, found: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true, encoding: 'buffer' })) {
    const full = child(dir, entry.name);
    const here = [...rel, display(entry.name)];
    if (isToolControlName(entry.name.toString('latin1'))) {
      const lower = entry.name.toString('latin1').toLowerCase();
      if (lower === '.semgrep' && entry.isDirectory() && !(await holdsOnlyYaml(full))) {
        throw new ControlDirectoryHoldsCodeError(here.join('/'));
      }
      found.push(here.join('/'));
      // No `force`: a removal that fails must fail the quarantine, not be reported as done.
      if (remove) await rm(full, { recursive: true });
      continue;
    }
    if (entry.isDirectory()) await walk(full, here, remove, found);
  }
}

/** Lists tool-control paths without changing anything. */
export async function findToolControlPaths(snapshotDir: string): Promise<string[]> {
  const found: string[] = [];
  await walk(Buffer.from(snapshotDir), [], false, found);
  return found.sort();
}

/**
 * Removes tool-control paths from a scan snapshot and returns the snapshot together with what was
 * removed, so the caller can record it as a signal (a repo that plants these is suspicious).
 *
 * MUTATES THE DIRECTORY. Only ever pass a private copy of the repo made for scanning, never the
 * original checkout. Symlinks are removed as links, never followed. Throws
 * ControlDirectoryHoldsCodeError rather than delete a `.semgrep/` directory that holds anything
 * but YAML.
 */
export async function quarantineSnapshot(snapshotDir: string): Promise<QuarantinedSnapshot> {
  const stat = await lstat(snapshotDir);
  if (!stat.isDirectory()) throw new Error(`snapshot is not a directory: ${snapshotDir}`);
  const removed: string[] = [];
  await walk(Buffer.from(snapshotDir), [], true, removed);
  return new QuarantinedSnapshot(snapshotDir, removed.sort());
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
