import { createHash } from 'node:crypto';
import { Candidate } from '@affidavit/contracts';
import { LIMITS, MalformedReportError, type SourceTool } from './guards.js';
import type { RawFinding } from './parse.js';

// Lower is preferred when several tools report the same issue: the Candidate carries the
// preferred tool's rule id and range.
const PRIORITY: Record<SourceTool, number> = { semgrep: 0, codeql: 1, osv: 2 };

/** Bytewise string order, so output never depends on the runtime locale. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function byPreference(a: RawFinding, b: RawFinding): number {
  return (
    PRIORITY[a.tool] - PRIORITY[b.tool] ||
    cmp(a.ruleId, b.ruleId) ||
    a.startLine - b.startLine ||
    a.endLine - b.endLine
  );
}

/** A stable id: the same issue at the same place gets the same id on every run. */
export function candidateId(f: RawFinding): string {
  // OSV findings have no real range (line 1 of the lockfile), so the advisory id keeps two
  // advisories in one lockfile apart.
  const key = [f.cls, f.file, f.startLine, f.endLine, f.tool === 'osv' ? f.ruleId : ''].join('\0');
  return `cand-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

function build(cluster: RawFinding[]): Candidate {
  const primary = [...cluster].sort(byPreference)[0] as RawFinding;
  const candidate = {
    schemaVersion: 1,
    id: candidateId(primary),
    tool: primary.tool,
    ruleId: primary.ruleId,
    cls: primary.cls,
    file: primary.file,
    range: { startLine: primary.startLine, endLine: primary.endLine },
    // Reachability and the score belong to arraignment (L1-06); these are the neutral values.
    reachability: 'unknown' as const,
    score: 0,
    scoreInputs: {},
    toolAgreement: new Set(cluster.map((f) => f.tool)).size,
  };
  const parsed = Candidate.safeParse(candidate);
  if (!parsed.success) {
    throw new MalformedReportError(
      primary.tool,
      'invalid-candidate',
      '',
      `finding for ${primary.ruleId} does not make a valid Candidate`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

/**
 * Deduplicates findings and computes `toolAgreement`.
 *
 * Findings are grouped by file and class. Within a group, line ranges that overlap (sharing at
 * least one line, directly or through a chain of overlapping ranges) are one issue, whichever tool
 * or rule reported them. `toolAgreement` is the number of distinct tools in that issue, so two
 * Semgrep rules on one line count once. OSV findings have no real range, so they merge only with
 * an identical advisory id in the same lockfile.
 *
 * The result is sorted by file, start line, end line, class, then id, with bytewise comparison.
 */
export function mergeFindings(findings: readonly RawFinding[]): Candidate[] {
  const groups = new Map<string, RawFinding[]>();
  for (const f of findings) {
    const key = [f.file, f.cls, f.tool === 'osv' ? `osv:${f.ruleId}` : 'range'].join('\0');
    const g = groups.get(key);
    if (g) g.push(f);
    else groups.set(key, [f]);
  }

  const out: Candidate[] = [];
  for (const [key, group] of [...groups].sort((a, b) => cmp(a[0], b[0]))) {
    if (!key.endsWith('\0range')) {
      out.push(build(group));
      continue;
    }
    const sorted = [...group].sort(
      (a, b) => a.startLine - b.startLine || a.endLine - b.endLine || byPreference(a, b),
    );
    let cluster: RawFinding[] = [];
    let end = 0;
    for (const f of sorted) {
      if (cluster.length > 0 && f.startLine > end) {
        out.push(build(cluster));
        cluster = [];
      }
      cluster.push(f);
      end = Math.max(end, f.endLine);
    }
    if (cluster.length > 0) out.push(build(cluster));
  }
  if (out.length > LIMITS.candidates) {
    throw new MalformedReportError('semgrep', 'too-many', '', 'too many candidates');
  }
  return out.sort(
    (a, b) =>
      cmp(a.file, b.file) ||
      a.range.startLine - b.range.startLine ||
      a.range.endLine - b.range.endLine ||
      cmp(a.cls, b.cls) ||
      cmp(a.id, b.id),
  );
}
