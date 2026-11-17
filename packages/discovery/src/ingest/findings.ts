import { readFile } from 'node:fs/promises';
import type { ToolReport } from '../tools/index.js';
import type { Region } from './redactor.js';

export interface GitleaksFinding {
  ruleId: string;
  /** Repo-relative posix path. */
  file: string;
  region: Region;
  origin: ToolReport['origin'];
  /** Set when `file` has a `!`: the path before it, the archive if no file named `file` exists. */
  outer?: string | undefined;
}

interface SarifDoc {
  runs?: {
    results?: {
      ruleId?: unknown;
      locations?: {
        physicalLocation?: {
          artifactLocation?: { uri?: unknown };
          region?: Record<string, unknown>;
        };
      }[];
    }[];
  }[];
}

/** `/src/a/b.js`, `file:///src/a/b.js` or `src/a/b.js` to `a/b.js`. Undefined if it escapes. */
export function relFromUri(uri: string): string | undefined {
  return splitUri(uri)?.file;
}

/**
 * `/src/a.zip!inner.js` names a member inside an archive. `file` is the whole path as reported (a real
 * file may have a `!` in its name); `outer` is the part before the first `!`, set only when there
 * is one, for the caller to fall back to when no file of the whole name exists.
 */
export function splitUri(uri: string): { file: string; outer?: string } | undefined {
  const file = plainRel(uri);
  if (file === undefined) return undefined;
  const bang = file.indexOf('!');
  return bang > 0 ? { file, outer: file.slice(0, bang) } : { file };
}

function plainRel(uri: string): string | undefined {
  const rel = uri.replace(/^file:\/\//, '').replace(/^\/?src\//, '');
  if (rel === '' || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return undefined;
  if (rel.split('/').some((s) => s === '..' || s === '.' || s === '')) return undefined;
  return rel;
}

const posInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : undefined;

/**
 * Reads gitleaks SARIF reports (snapshot, quarantine and windows passes) into one list. A result
 * whose location cannot be read is reported in `malformed`, never skipped: the caller fails
 * closed. `windowedFiles` (`/src/<path>`) are files the windows pass scanned whole; their
 * snapshot-pass findings are dropped because gitleaks columns after its first 100 KB chunk are
 * unreliable (the windows columns are remapped and are not).
 */
export async function readGitleaksFindings(
  reports: readonly ToolReport[],
  windowedFiles: readonly string[],
): Promise<{ findings: GitleaksFinding[]; malformed: number }> {
  const windowed = new Set(windowedFiles.map((f) => f.replace(/^\/src\//, '')));
  const hasWindows = reports.some((r) => r.origin === 'windows');
  const seen = new Set<string>();
  const findings: GitleaksFinding[] = [];
  let malformed = 0;
  for (const report of reports) {
    const doc = JSON.parse(await readFile(report.file, 'utf8')) as SarifDoc;
    for (const run of doc.runs ?? []) {
      for (const result of run.results ?? []) {
        const ruleId =
          typeof result.ruleId === 'string' && result.ruleId ? result.ruleId : 'secret';
        const locations = result.locations ?? [];
        if (locations.length === 0) malformed++;
        for (const loc of locations) {
          const pl = loc.physicalLocation;
          const uri = pl?.artifactLocation?.uri;
          const parts = typeof uri === 'string' ? splitUri(uri) : undefined;
          const rel = parts?.file;
          const r = pl?.region;
          const startLine = posInt(r?.['startLine']);
          const endLine = posInt(r?.['endLine']) ?? startLine;
          const startColumn = posInt(r?.['startColumn']);
          const endColumn = posInt(r?.['endColumn']);
          if (
            rel === undefined ||
            startLine === undefined ||
            endLine === undefined ||
            startColumn === undefined ||
            endColumn === undefined
          ) {
            malformed++;
            continue;
          }
          if (report.origin === 'snapshot' && hasWindows && windowed.has(rel)) continue;
          const key = [ruleId, rel, startLine, startColumn, endLine, endColumn].join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          findings.push({
            ruleId,
            file: rel,
            region: { startLine, startColumn, endLine, endColumn },
            origin: report.origin,
            outer: parts?.outer,
          });
        }
      }
    }
  }
  findings.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.region.startLine - b.region.startLine ||
      a.region.startColumn - b.region.startColumn ||
      a.ruleId.localeCompare(b.ruleId),
  );
  return { findings, malformed };
}
