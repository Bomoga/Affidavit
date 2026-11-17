import { createHash } from 'node:crypto';
import { Candidate } from '@affidavit/contracts';
import { MalformedReportError, type SourceTool } from './guards.js';
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
    a.endLine - b.endLine ||
    cmp(a.pkg?.name ?? '', b.pkg?.name ?? '') ||
    cmp(a.pkg?.version ?? '', b.pkg?.version ?? '')
  );
}

/** One input finding that ended up inside a candidate. */
export interface MergedMember {
  tool: SourceTool;
  ruleId: string;
  startLine: number;
  endLine: number;
  /** OSV only. */
  package?: { name: string; version: string };
}

/**
 * Lane 1 side record: every finding that fed a candidate, the primary included. `Candidate` has
 * only one rule id and range, so this is where the rest stays on record (the lead decides where it finally lives).
 */
export interface MergedRecord {
  candidateId: string;
  members: MergedMember[];
}

/** A stable id: the same issue at the same place gets the same id on every run. */
export function candidateId(f: RawFinding): string {
  // OSV findings have no real range (line 1 of the lockfile), so the advisory id keeps two
  // advisories in one lockfile apart.
  const key = [f.cls, f.file, f.startLine, f.endLine, f.tool === 'osv' ? f.ruleId : ''].join('\0');
  return `cand-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

function build(cluster: RawFinding[]): { candidate: Candidate; record: MergedRecord } {
  const sorted = [...cluster].sort(byPreference);
  const primary = sorted[0] as RawFinding;
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
  return {
    candidate: parsed.data,
    record: {
      candidateId: parsed.data.id,
      members: sorted.map((f) => ({
        tool: f.tool,
        ruleId: f.ruleId,
        startLine: f.startLine,
        endLine: f.endLine,
        ...(f.pkg ? { package: f.pkg } : {}),
      })),
    },
  };
}

/**
 * Splits one file-and-class group into clusters. The preferred unassigned finding is a primary;
 * the unassigned findings whose lines overlap the PRIMARY's range join it. Overlap is never
 * chained (a wide range does not bridge two separate issues), and each finding lands in exactly
 * one cluster. A segment tree over the start-sorted findings holds the largest end line still
 * unassigned, so a primary finds its members without scanning the whole group.
 */
function clusterByPrimary(group: RawFinding[]): RawFinding[][] {
  const byPref = [...group].sort(byPreference);
  const byStart = [...group].sort((a, b) => a.startLine - b.startLine || byPreference(a, b));
  const n = byStart.length;
  let size = 1;
  while (size < n) size *= 2;
  const tree = new Int32Array(2 * size).fill(-1);
  const pos = new Map<RawFinding, number>();
  byStart.forEach((f, i) => {
    pos.set(f, i);
    tree[size + i] = f.endLine;
  });
  for (let i = size - 1; i >= 1; i--)
    tree[i] = Math.max(tree[2 * i] as number, tree[2 * i + 1] as number);
  const remove = (i: number): void => {
    let k = size + i;
    tree[k] = -1;
    for (k >>= 1; k >= 1; k >>= 1)
      tree[k] = Math.max(tree[2 * k] as number, tree[2 * k + 1] as number);
  };
  const collect = (node: number, lo: number, hi: number, ub: number, s: number, out: number[]) => {
    if (lo >= ub || (tree[node] as number) < s) return;
    if (hi - lo === 1) {
      out.push(lo);
      return;
    }
    const mid = (lo + hi) >> 1;
    collect(2 * node, lo, mid, ub, s, out);
    collect(2 * node + 1, mid, hi, ub, s, out);
  };

  const clusters: RawFinding[][] = [];
  for (const primary of byPref) {
    const at = pos.get(primary) as number;
    if ((tree[size + at] as number) === -1) continue; // already in an earlier cluster
    remove(at);
    // Start-sorted findings whose start is within the primary's range.
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((byStart[mid] as RawFinding).startLine <= primary.endLine) lo = mid + 1;
      else hi = mid;
    }
    const found: number[] = [];
    collect(1, 0, size, lo, primary.startLine, found);
    const cluster = [primary];
    for (const i of found) {
      cluster.push(byStart[i] as RawFinding);
      remove(i);
    }
    clusters.push(cluster);
  }
  return clusters;
}

/**
 * Deduplicates findings and computes `toolAgreement`.
 *
 * Findings are grouped by file and class. Within a group the preferred finding is a primary and
 * every unassigned finding whose lines overlap the primary's range is merged into it, whichever
 * tool or rule reported it (no chaining, see clusterByPrimary). `toolAgreement` is the number of
 * distinct tools in the cluster, so two Semgrep rules on one line count once. OSV findings have no
 * real range, so they merge only with the same advisory id in the same lockfile.
 *
 * `merged` records every member of every candidate, so nothing is dropped unrecorded. Both lists
 * are sorted by file, start line, end line, class, then id, with bytewise comparison.
 */
export function mergeFindings(findings: readonly RawFinding[]): {
  candidates: Candidate[];
  merged: MergedRecord[];
} {
  const groups = new Map<string, RawFinding[]>();
  for (const f of findings) {
    const key = [f.file, f.cls, f.tool === 'osv' ? `osv:${f.ruleId}` : 'range'].join('\0');
    const g = groups.get(key);
    if (g) g.push(f);
    else groups.set(key, [f]);
  }

  const built: { candidate: Candidate; record: MergedRecord }[] = [];
  for (const [key, group] of groups) {
    const clusters = key.endsWith('\0range') ? clusterByPrimary(group) : [group];
    for (const c of clusters) built.push(build(c));
  }
  built.sort(
    (a, b) =>
      cmp(a.candidate.file, b.candidate.file) ||
      a.candidate.range.startLine - b.candidate.range.startLine ||
      a.candidate.range.endLine - b.candidate.range.endLine ||
      cmp(a.candidate.cls, b.candidate.cls) ||
      cmp(a.candidate.id, b.candidate.id),
  );
  return { candidates: built.map((b) => b.candidate), merged: built.map((b) => b.record) };
}
