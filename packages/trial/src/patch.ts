import {
  PatchExhibit,
  type AdmissibilityRule,
  type CaseFile,
  type ExhibitId,
  type VerifyResult,
} from '@affidavit/contracts';
import { canonicalJson, sha256Hex } from './canonical.js';

export interface DiffStats {
  filesTouched: string[];
  linesChanged: number;
}

/** Repo paths only: relative, no parent segments, no drive letters, no NUL. */
function isSafeRepoPath(p: string): boolean {
  if (p.length === 0 || p.includes('\0') || p.includes('\\')) return false;
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  return !p.split('/').some((seg) => seg === '..' || seg === '');
}

function stripPrefix(raw: string): string | null {
  const path = raw.split('\t')[0]?.trim() ?? '';
  if (path === '/dev/null') return null;
  return path.replace(/^[ab]\//, '');
}

/**
 * Counts what a unified diff touches. Computed here from the diff text, never taken from the
 * agent. Throws on a path that could point outside the case workspace.
 */
export function diffStats(diff: string): DiffStats {
  const files = new Set<string>();
  let linesChanged = 0;
  let pendingOld: string | null = null;
  // Lines left in the current hunk, from its @@ header, so a removed line that starts with
  // "-- " is never mistaken for a file header.
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('-')) {
        oldLeft--;
        linesChanged++;
      } else if (line.startsWith('+')) {
        newLeft--;
        linesChanged++;
      } else if (!line.startsWith('\\')) {
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      if (files.size === 0) throw new Error('diff has a hunk before any file header');
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      continue;
    }
    if (line.startsWith('--- ')) {
      pendingOld = stripPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      const target = stripPrefix(line.slice(4)) ?? pendingOld;
      if (target !== null) {
        if (!isSafeRepoPath(target)) throw new Error(`diff touches an unsafe path: ${target}`);
        files.add(target);
      }
      pendingOld = null;
    }
  }
  return { filesTouched: [...files].sort(), linesChanged };
}

/**
 * Builds the contract PatchExhibit around a diff. Id, hash, author, and the diff stats are set in
 * code. Throws (a ZodError or a path error) when the diff touches nothing or an unsafe path.
 */
export function buildPatchExhibit(caseFile: CaseFile, diff: string): PatchExhibit {
  const { filesTouched, linesChanged } = diffStats(diff);
  const sha256 = sha256Hex(diff);
  const digest = sha256Hex(canonicalJson({ caseId: caseFile.id, diff, kind: 'patch' }));
  return PatchExhibit.parse({
    schemaVersion: 1,
    id: `exhibit-patch-${digest.slice(0, 24)}` as ExhibitId,
    caseId: caseFile.id,
    kind: 'patch',
    author: 'remedy',
    code: diff,
    sha256,
    diff,
    filesTouched,
    linesChanged,
  });
}

/** Accepted only when the Judge names no rule and every check it reports is clean. */
export function isAccepted(r: VerifyResult): boolean {
  return (
    r.rejectedBy === undefined &&
    r.familyFlipped &&
    r.suitePassed &&
    r.rescanClean &&
    r.counterexamples.every((c) => !c.survived)
  );
}

/**
 * The rule to record when a patch is not accepted: the Judge's own when it gave one, otherwise the
 * rule that matches the failed check. A result that fails only on the family or the rescan has no
 * matching rule in v1.0, so nothing is invented for it (see contract request CR-1).
 */
export function rejectionRule(r: VerifyResult): AdmissibilityRule | undefined {
  if (r.rejectedBy) return r.rejectedBy;
  if (!r.suitePassed) return 'suite-fails';
  if (r.counterexamples.some((c) => c.survived)) return 'counterexample-survives';
  return undefined;
}

export function describeVerify(r: VerifyResult): string {
  const flags = [
    r.familyFlipped ? null : 'family not flipped',
    r.suitePassed ? null : 'suite failed',
    r.rescanClean ? null : 'rescan not clean',
    r.counterexamples.some((c) => c.survived) ? 'counterexample survived' : null,
  ].filter((f): f is string => f !== null);
  return `judge: ${r.rejectedBy ?? 'not accepted'}${flags.length ? ` [${flags.join(', ')}]` : ''}`;
}
