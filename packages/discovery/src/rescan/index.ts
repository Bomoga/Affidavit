/**
 * The discovery re-scan of a patched tree (L1-17), Lane 1's `RescanPort` for the Judge's
 * `verifyPatch`. After the Judge's jailed apply step has written the vulnerable commit plus the
 * whole patch to `patchedWorkspacePath`, this re-runs the scanner and rule that produced the
 * case's candidate (our Semgrep rules, through `ToolRunnerPort`, with the same quarantine and the
 * same normalizer as intake) and says whether that finding is gone.
 *
 * `clean` is true only when ALL of these hold, so anything this cannot show fails closed:
 *
 * - the candidate came from Semgrep (the only scanner whose findings go to trial today; any other
 *   tool is not re-run and is never clean);
 * - the case's candidate file is a plain relative path that exists as a regular file in the
 *   patched tree (a patch that deletes or renames the file is not clean: a person decides);
 * - the Semgrep run reported no coverage loss (a partial run is never clean);
 * - no finding of the same rule id is in that file, as any member of any merged candidate or as a
 *   skipped finding. Lines move when a patch adds or removes lines, so the file and rule are
 *   compared, not the exact range: a second finding of the same rule elsewhere in the same file
 *   also makes the re-scan not clean (conservative on purpose).
 *
 * `candidates` is everything the re-scan found in the patched tree (normalized, unscored), for the
 * record. The patched workspace is never written: it is copied (symlinks and `.git` left out, as
 * intake does) into a fresh directory under `workRoot`, which is always removed. Tool failures and
 * malformed reports throw, like intake; the Judge treats a throw as an infrastructure failure.
 */
import { cpSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CaseFile, Candidate, RescanPort, ToolRunnerPort } from '@affidavit/contracts';
import { PROSE_MARKER } from '../casefile/slice.js';
import { normalizeReports, readToolRunReports } from '../normalize/index.js';
import {
  loadToolManifest,
  quarantineSnapshot,
  repoRoot,
  runTool,
  type ToolManifest,
} from '../tools/index.js';

export interface RescanDeps {
  /** The only way a scanner runs. Must be allowed to mount `workRoot`. */
  runner: ToolRunnerPort;
  /** Existing directory. Each re-scan makes its own subdirectory here and removes it afterwards. */
  workRoot: string;
  manifest?: ToolManifest | undefined;
  /** Our Semgrep rules. Default `packages/discovery/rules/semgrep`, the same as intake. */
  rulesDir?: string | undefined;
}

/** Why a re-scan is not clean. Fixed values only, never repository text. */
export type RescanReason =
  | 'clean'
  | 'tool-not-rescannable'
  | 'unsafe-candidate-path'
  | 'file-missing'
  | 'scan-partial'
  | 'finding-present';

export interface RescanReport {
  clean: boolean;
  reason: RescanReason;
  candidates: Candidate[];
}

/** The case's candidate file inside `root`, or null when it is not a plain relative path. */
function candidatePath(root: string, file: string): string | null {
  if (file.includes(PROSE_MARKER) || isAbsolute(file) || file.includes('\\')) return null;
  if (file.split('/').some((p) => p === '' || p === '.' || p === '..')) return null;
  const abs = resolve(root, file);
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return abs.startsWith(root + sep) ? abs : null;
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
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
  const source = resolve(patchedWorkspacePath);
  if (!lstatSync(source).isDirectory()) {
    throw new Error('the patched workspace is not a directory');
  }
  const runDir = mkdtempSync(join(deps.workRoot, 'rescan-'));
  try {
    // A copy, so the quarantine never touches the Judge's tree. Symlinks are not followed or
    // copied, and only directories and regular files are, the same tree shape intake scans.
    const snapDir = join(runDir, 'snap');
    cpSync(source, snapDir, {
      recursive: true,
      filter: (p) => {
        if (p === source) return true;
        if (basename(p) === '.git') return false;
        const st = lstatSync(p);
        return st.isDirectory() || st.isFile();
      },
    });
    const target = candidatePath(resolve(snapDir), original.file);
    if (target === null) return { clean: false, reason: 'unsafe-candidate-path', candidates: [] };
    if (!isRegularFile(target)) return { clean: false, reason: 'file-missing', candidates: [] };

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
    if (present) return { clean: false, reason: 'finding-present', candidates };
    if (partial) return { clean: false, reason: 'scan-partial', candidates };
    return { clean: true, reason: 'clean', candidates };
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
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
