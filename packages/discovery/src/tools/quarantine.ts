import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * Repo-controlled files that change what a scanner does: ignore lists, allowlists, per-repo
 * configs, and the git metadata that Semgrep and others shell out to. A hostile repo can use them
 * to silence a scanner or to run code through git. Flags on each invocation cover most of them;
 * this list covers the rest by removing them from the scan snapshot.
 *
 * Matched on the base name, case-insensitively, at any depth. `.github` is deliberately not here:
 * workflow files are scan targets.
 */
export const TOOL_CONTROL_PATTERNS: readonly string[] = [
  '.git',
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.gitleaks* (config, ignore list, baseline)',
  'gitleaks.toml',
  'osv-scanner.toml',
  '.osv-scanner.toml',
  '.semgrep* (.semgrepignore, .semgrep.yml, .semgrep/ and similar)',
];

const EXACT = new Set(['.git', '.gitignore', '.gitattributes', '.gitmodules', 'gitleaks.toml']);

export function isToolControlName(name: string): boolean {
  const n = name.toLowerCase();
  return (
    EXACT.has(n) ||
    n.startsWith('.gitleaks') ||
    n.startsWith('.semgrep') ||
    n === 'osv-scanner.toml' ||
    n === '.osv-scanner.toml'
  );
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

/** Relative paths (posix separators) of tool-control entries. Never follows symlinks. */
async function walk(root: string, dir: string, remove: boolean, found: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (isToolControlName(entry.name)) {
      found.push(relative(root, full).split(sep).join('/'));
      if (remove) await rm(full, { recursive: true, force: true });
      continue;
    }
    if (entry.isDirectory()) await walk(root, full, remove, found);
  }
}

/** Lists tool-control paths without changing anything. */
export async function findToolControlPaths(snapshotDir: string): Promise<string[]> {
  const found: string[] = [];
  await walk(snapshotDir, snapshotDir, false, found);
  return found.sort();
}

/**
 * Removes tool-control paths from a scan snapshot and returns what it removed, relative to the
 * snapshot, so the caller can record it as a signal (a repo that plants these is suspicious).
 *
 * MUTATES THE DIRECTORY. Only ever pass a private copy of the repo made for scanning, never the
 * original checkout. Symlinks are removed as links, never followed.
 */
export async function quarantineToolControlPaths(snapshotDir: string): Promise<string[]> {
  const stat = await lstat(snapshotDir);
  if (!stat.isDirectory()) throw new Error(`snapshot is not a directory: ${snapshotDir}`);
  const removed: string[] = [];
  await walk(snapshotDir, snapshotDir, true, removed);
  return removed.sort();
}

/** Fails closed: throws SnapshotNotCleanError if any tool-control path is still present. */
export async function assertSnapshotClean(snapshotDir: string): Promise<void> {
  const found = await findToolControlPaths(snapshotDir);
  if (found.length > 0) throw new SnapshotNotCleanError(found);
}

/** Creates the per-run scratch subdirectories. The scratch dir must not exist or must be empty. */
export async function prepareScratch(
  scratchDir: string,
  subdirs: readonly string[],
): Promise<void> {
  try {
    if ((await readdir(scratchDir)).length > 0) throw new ScratchNotFreshError(scratchDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  for (const sub of subdirs) await mkdir(join(scratchDir, sub), { recursive: true });
}
