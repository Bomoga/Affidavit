/**
 * The discovery re-scan of a patched tree (L1-17), Lane 1's `RescanPort` for the Judge's
 * `verifyPatch`. After the Judge's jailed apply step has written the vulnerable commit plus the
 * whole patch to `patchedWorkspacePath`, this re-runs the scanner and rule that produced the
 * case's candidate (our Semgrep rules, through `ToolRunnerPort`, with the same quarantine and the
 * same normalizer as intake) and says whether that finding is gone.
 *
 * `clean` is never the default. It is true only when ALL of these hold, so anything this cannot
 * show fails closed:
 *
 * - the candidate came from Semgrep (the only scanner whose findings go to trial today; any other
 *   tool is not re-run and is never clean);
 * - the patched tree is within the copy limits (`RESCAN_LIMITS`);
 * - the case's candidate file is a plain relative path, and every part of it is listed with that
 *   exact spelling in its parent directory and is a regular file in the patched tree (a patch that
 *   deletes or renames the file, case-only renames included, is not clean: a person decides);
 * - that file is plain text Semgrep reads whole: at most `maxCaseFileBytes`, no NUL byte, valid
 *   UTF-8 (so no UTF-16), no signature or control bytes `classifyHead` refuses, and no line over
 *   `maxLineBytes` (a minified-looking file Semgrep may skip without a finding);
 * - the run's SARIF lists the case's rule id among the rules it loaded (a rule missing or renamed
 *   since intake is never clean);
 * - the Semgrep run reported no coverage loss. Semgrep's notifications carry no reliable path, so
 *   any notification anywhere in the tree refuses clean (global on purpose);
 * - no finding of the same rule id is in that file, as any member of any merged candidate or as a
 *   skipped finding. Lines move when a patch adds or removes lines, so the file and rule are
 *   compared, not the exact range: a second finding of the same rule elsewhere in the same file
 *   also makes the re-scan not clean (conservative on purpose).
 *
 * `candidates` is everything the re-scan found in the patched tree (normalized, unscored), for the
 * record. The patched workspace is never written: it is copied (symlinks, special files and `.git`
 * left out, as intake does) into a fresh directory under `workRoot`, which is always removed; a
 * failed removal is logged (by name only) and never changes the outcome. Tool failures and
 * malformed reports throw, like intake; the Judge treats a throw as an infrastructure failure.
 */
import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import type { CaseFile, Candidate, RescanPort, ToolRunnerPort } from '@affidavit/contracts';
import { PROSE_MARKER } from '../casefile/slice.js';
import { normalizeReports, readToolRunReports, type ReportInput } from '../normalize/index.js';
import {
  classifyHead,
  loadToolManifest,
  quarantineSnapshot,
  repoRoot,
  runTool,
  type ToolManifest,
} from '../tools/index.js';

/**
 * Limits of the re-scan. Design constants, not measurements ([metric] until real runs): a tree
 * past the copy limits is never scanned and never clean.
 */
export interface RescanLimits {
  /** Regular files copied from the patched tree. */
  maxFiles: number;
  /** Bytes copied from the patched tree. */
  maxBytes: number;
  /** Size of the case's file. */
  maxCaseFileBytes: number;
  /** Longest line of the case's file. */
  maxLineBytes: number;
}

export const RESCAN_LIMITS: Readonly<RescanLimits> = {
  maxFiles: 50_000,
  maxBytes: 512 * 1024 * 1024,
  maxCaseFileBytes: 1_000_000,
  maxLineBytes: 4096,
};

export interface RescanDeps {
  /** The only way a scanner runs. Must be allowed to mount `workRoot`. */
  runner: ToolRunnerPort;
  /** Existing directory. Each re-scan makes its own subdirectory here and removes it afterwards. */
  workRoot: string;
  manifest?: ToolManifest | undefined;
  /** Our Semgrep rules. Default `packages/discovery/rules/semgrep`, the same as intake. */
  rulesDir?: string | undefined;
  limits?: Partial<RescanLimits> | undefined;
  /** Directory listing used for the exact-name check (tests). Default `readdirSync`. */
  listDir?: ((dir: string) => string[]) | undefined;
  /** Removes the run directory (tests). Default `rmSync(dir, { recursive, force })`. */
  removeDir?: ((dir: string) => void) | undefined;
  /** Where a failed cleanup is reported. Names a class of error, never a path or content. */
  log?: ((message: string) => void) | undefined;
}

/** Why a re-scan is or is not clean. Fixed values only, never repository text. */
export type RescanReason =
  | 'clean'
  | 'tool-not-rescannable'
  | 'tree-too-large'
  | 'unsafe-candidate-path'
  | 'file-missing'
  | 'not-plain-text'
  | 'rule-not-loaded'
  | 'scan-partial'
  | 'finding-present';

export interface RescanReport {
  clean: boolean;
  reason: RescanReason;
  candidates: Candidate[];
}

class TreeTooLarge extends Error {}

/** The parts of the case's file when it is a plain relative path, else null. */
function pathParts(file: string): string[] | null {
  if (file.includes(PROSE_MARKER) || isAbsolute(file) || file.includes('\\')) return null;
  const parts = file.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\0'))) return null;
  return parts;
}

/**
 * True when every part of `parts` is listed with exactly that spelling in its parent, so a
 * case-only rename cannot be found through a case-insensitive filesystem, and the last part is a
 * regular file (no symlink is ever copied, so none can be followed).
 */
function existsExactly(
  root: string,
  parts: readonly string[],
  listDir: (dir: string) => string[],
): boolean {
  let dir = root;
  for (const part of parts) {
    let names: string[];
    try {
      names = listDir(dir);
    } catch {
      return false;
    }
    if (!names.includes(part)) return false;
    dir = join(dir, part);
  }
  try {
    return lstatSync(dir).isFile();
  } catch {
    return false;
  }
}

/** Plain text Semgrep reads whole, judged on the opened file; see the header. */
function plainText(path: string, limits: RescanLimits): boolean {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > limits.maxCaseFileBytes) return false;
    const buf = Buffer.alloc(st.size + 1);
    let n = 0;
    for (;;) {
      const r = readSync(fd, buf, n, buf.length - n, n);
      if (r === 0) break;
      n += r;
      if (n > limits.maxCaseFileBytes) return false;
    }
    const bytes = buf.subarray(0, n);
    if (classifyHead(basename(path), bytes.subarray(0, 8192)) !== undefined) return false;
    if (bytes.includes(0x00)) return false;
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return false;
    }
    return text.split('\n').every((line) => Buffer.byteLength(line, 'utf8') <= limits.maxLineBytes);
  } finally {
    closeSync(fd);
  }
}

/**
 * Copies directories and regular files only (no symlinks, no special files, no `.git`), counting
 * files and bytes as it goes. Throws `TreeTooLarge` past a limit.
 */
function copyTree(from: string, to: string, limits: RescanLimits): void {
  let files = 0;
  let bytes = 0;
  const walk = (src: string, dst: string): void => {
    mkdirSync(dst);
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const s = join(src, entry.name);
      const d = join(dst, entry.name);
      const st = lstatSync(s);
      if (st.isDirectory()) walk(s, d);
      else if (st.isFile()) {
        files += 1;
        bytes += st.size;
        if (files > limits.maxFiles || bytes > limits.maxBytes) throw new TreeTooLarge();
        copyFileSync(s, d, constants.COPYFILE_EXCL);
      }
    }
  };
  walk(from, to);
}

/** Every rule id a SARIF report says it ran (`runs[].tool.driver.rules[].id`, and extensions). */
function loadedRules(reports: readonly ReportInput[]): Set<string> {
  const ids = new Set<string>();
  for (const r of reports) {
    const runs = (r.doc as { runs?: unknown }).runs;
    if (!Array.isArray(runs)) continue;
    for (const run of runs as { tool?: { driver?: unknown; extensions?: unknown } }[]) {
      const extensions: unknown[] = Array.isArray(run.tool?.extensions)
        ? (run.tool.extensions as unknown[])
        : [];
      const components: unknown[] = [run.tool?.driver, ...extensions];
      for (const c of components as { rules?: unknown }[]) {
        if (!Array.isArray(c?.rules)) continue;
        for (const rule of c.rules as { id?: unknown }[]) {
          if (typeof rule?.id === 'string') ids.add(rule.id);
        }
      }
    }
  }
  return ids;
}

/** `rescan`, plus a fixed reason, for logs and tests. */
export async function rescanPatchedTree(
  deps: RescanDeps,
  caseFile: CaseFile,
  patchedWorkspacePath: string,
): Promise<RescanReport> {
  const original = caseFile.candidate;
  if (original.tool !== 'semgrep') {
    return { clean: false, reason: 'tool-not-rescannable', candidates: [] };
  }
  const limits = { ...RESCAN_LIMITS, ...deps.limits };
  const source = resolve(patchedWorkspacePath);
  if (!lstatSync(source).isDirectory()) {
    throw new Error('the patched workspace is not a directory');
  }
  const runDir = mkdtempSync(join(deps.workRoot, 'rescan-'));
  try {
    return await scan(deps, original, source, runDir, limits);
  } finally {
    try {
      (deps.removeDir ?? ((d: string) => rmSync(d, { recursive: true, force: true })))(runDir);
    } catch (err) {
      // Never replaces the outcome above: a clean result stays clean only on its own merits, and
      // a throw still goes up.
      (deps.log ?? ((m: string) => console.error(`[discovery] ${m}`)))(
        `re-scan cleanup failed (${err instanceof Error ? err.name : 'unknown error'})`,
      );
    }
  }
}

async function scan(
  deps: RescanDeps,
  original: Candidate,
  source: string,
  runDir: string,
  limits: RescanLimits,
): Promise<RescanReport> {
  const refuse = (reason: RescanReason, candidates: Candidate[] = []): RescanReport => ({
    clean: false,
    reason,
    candidates,
  });
  // A copy, so the quarantine never touches the Judge's tree.
  const snapDir = join(runDir, 'snap');
  try {
    copyTree(source, snapDir, limits);
  } catch (err) {
    if (err instanceof TreeTooLarge) return refuse('tree-too-large');
    throw err;
  }
  const parts = pathParts(original.file);
  if (parts === null) return refuse('unsafe-candidate-path');
  const root = resolve(snapDir);
  const target = resolve(root, ...parts);
  if (!target.startsWith(root + sep)) return refuse('unsafe-candidate-path');
  if (!existsExactly(root, parts, deps.listDir ?? ((d) => readdirSync(d)))) {
    return refuse('file-missing');
  }
  if (!plainText(target, limits)) return refuse('not-plain-text');

  const manifest = deps.manifest ?? loadToolManifest();
  const run = await runTool(deps.runner, manifest, 'semgrep', {
    snapshot: await quarantineSnapshot(snapDir),
    outputDir: join(runDir, 'out'),
    scratchDir: join(runDir, 'scratch'),
    rulesDir: deps.rulesDir ?? join(repoRoot(), 'packages', 'discovery', 'rules', 'semgrep'),
  });
  const partial = run.notifications.length > 0;
  const reports = await readToolRunReports(run);
  const normalized = normalizeReports(reports.map((r) => ({ ...r, partial })));
  const candidates = normalized.candidates;

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const present =
    normalized.merged.some(
      (m) =>
        byId.get(m.candidateId)?.file === original.file &&
        m.members.some((x) => x.tool === 'semgrep' && x.ruleId === original.ruleId),
    ) ||
    normalized.skipped.some(
      (s) =>
        s.tool === 'semgrep' &&
        s.ruleId === original.ruleId &&
        (s.file === undefined || s.file === original.file),
    );
  if (present) return refuse('finding-present', candidates);
  if (!loadedRules(reports).has(original.ruleId)) return refuse('rule-not-loaded', candidates);
  if (partial) return refuse('scan-partial', candidates);
  return { clean: true, reason: 'clean', candidates };
}

/** Lane 1's `RescanPort` (contracts `ports/index.ts`), built once per worker. */
export class DiscoveryRescan implements RescanPort {
  constructor(private readonly deps: RescanDeps) {}

  async rescan(
    caseFile: CaseFile,
    patchedWorkspacePath: string,
  ): Promise<{ clean: boolean; candidates: readonly Candidate[] }> {
    const report = await rescanPatchedTree(this.deps, caseFile, patchedWorkspacePath);
    return { clean: report.clean, candidates: report.candidates };
  }
}
