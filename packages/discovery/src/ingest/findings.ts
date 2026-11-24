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

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** An absent list is empty; anything present that is not an array means the report is unreadable. */
function listOf(value: unknown, what: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error(`gitleaks SARIF report is malformed: ${what} is not a list`);
  return value;
}

const posInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : undefined;

/**
 * Reads gitleaks SARIF reports (snapshot, quarantine and windows passes) into one list. A result
 * whose location cannot be read is reported in `malformed`, never skipped: the caller fails
 * closed. Nothing is dropped in favour of another pass: the windows pass only guarantees that a
 * stretch of about 16,000 bytes lands in one window, so a longer secret (a big private key) can be
 * found by the snapshot pass alone. A finding in a file over 100 KB has columns that cannot be
 * trusted, and the map then falls back to whole lines.
 */
export async function readGitleaksFindings(
  reports: readonly ToolReport[],
): Promise<{ findings: GitleaksFinding[]; malformed: number }> {
  const seen = new Set<string>();
  const findings: GitleaksFinding[] = [];
  let malformed = 0;
  for (const report of reports) {
    const parsed: unknown = JSON.parse(await readFile(report.file, 'utf8'));
    if (!isRecord(parsed)) throw new Error('gitleaks SARIF report is malformed: not an object');
    const doc = parsed as SarifDoc;
    for (const run of listOf(doc.runs, 'runs') as NonNullable<SarifDoc['runs']>) {
      if (!isRecord(run))
        throw new Error('gitleaks SARIF report is malformed: a run is not an object');
      for (const result of listOf(run.results, 'results') as NonNullable<
        NonNullable<SarifDoc['runs']>[number]['results']
      >) {
        if (!isRecord(result)) {
          throw new Error('gitleaks SARIF report is malformed: a result is not an object');
        }
        const ruleId =
          typeof result.ruleId === 'string' && result.ruleId ? result.ruleId : 'secret';
        const locations = listOf(result.locations, 'locations') as NonNullable<
          typeof result.locations
        >;
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
