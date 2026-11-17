// L1-03: turns Semgrep SARIF, CodeQL SARIF and OSV-Scanner JSON into Candidate objects.
// Gitleaks output is not a Candidate source (it feeds redaction).
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { Candidate } from '@affidavit/contracts';
import type { ToolRunResult } from '../tools/index.js';
import { LIMITS, MalformedReportError, type SourceTool } from './guards.js';
import { mergeFindings, type MergedRecord } from './merge.js';
import { parseOsv, parseSarif, type RawFinding, type SkippedFinding } from './parse.js';

export {
  MalformedReportError,
  LIMITS as NORMALIZE_LIMITS,
  type MalformedCode,
  type SourceTool,
} from './guards.js';
export { IDOR_CWES, INJECTION_CWES, classOf, cweNumber, cweNumbers } from './classify.js';
export type { MergedMember, MergedRecord } from './merge.js';
export type { SkipReason, SkippedFinding } from './parse.js';

/** One parsed tool report. `partial` is the L1-02 flag: the tool may have missed things. */
export interface ReportInput {
  tool: SourceTool;
  doc: unknown;
  partial?: boolean;
}

export interface NormalizeResult {
  /** Deduplicated and sorted; reachability `unknown`, score 0 until arraignment (L1-06). */
  candidates: Candidate[];
  /**
   * Every input finding appears either in exactly one candidate's `members` here or in `skipped`.
   * A candidate carries one rule id and range; the other rules, tools and OSV packages that fed
   * it are kept here, in the same order as `candidates`.
   */
  merged: MergedRecord[];
  /**
   * Findings that were read but not turned into candidates (outside the MVP classes, no location,
   * or an unsafe path). Callers must record them; none is silently dropped.
   */
  skipped: SkippedFinding[];
  /** Tools whose run was partial, so an absent finding is not evidence of absence. */
  partialTools: SourceTool[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Normalizes already-parsed reports. Throws MalformedReportError (and nothing else) for a report
 * that is not valid SARIF or OSV JSON or exceeds a size cap. An unsafe path on one finding does
 * not fail the report: that finding is returned in `skipped`.
 */
export function normalizeReports(inputs: readonly ReportInput[]): NormalizeResult {
  let current: SourceTool = inputs[0]?.tool ?? 'semgrep';
  try {
    const findings: RawFinding[] = [];
    const skipped: SkippedFinding[] = [];
    for (const input of inputs) {
      current = input.tool;
      const parsed = input.tool === 'osv' ? parseOsv(input.doc) : parseSarif(input.tool, input.doc);
      findings.push(...parsed.findings);
      skipped.push(...parsed.skipped);
      if (findings.length > LIMITS.candidates) {
        throw new MalformedReportError(current, 'too-many', '', 'too many findings');
      }
    }
    skipped.sort(
      (a, b) =>
        cmp(a.tool, b.tool) ||
        cmp(a.file ?? '', b.file ?? '') ||
        cmp(a.ruleId, b.ruleId) ||
        cmp(a.reason, b.reason),
    );
    const partialTools = [...new Set(inputs.filter((i) => i.partial === true).map((i) => i.tool))];
    const { candidates, merged } = mergeFindings(findings);
    return { candidates, merged, skipped, partialTools: partialTools.sort(cmp) };
  } catch (e) {
    if (e instanceof MalformedReportError) throw e;
    // A bug or an engine limit must still surface as a typed error, never a crash.
    throw new MalformedReportError(
      current,
      'unexpected',
      '',
      e instanceof Error ? e.message : 'unexpected failure',
      { cause: e },
    );
  }
}

const DEFAULT_MAX_REPORT_BYTES = 128 * 1024 * 1024;

/** Explicit, so a new tool name is an error and never silently read as another tool's format. */
function sourceToolOf(name: string): SourceTool {
  switch (name) {
    case 'semgrep':
      return 'semgrep';
    case 'codeql':
      return 'codeql';
    case 'osv-scanner':
      return 'osv';
    case 'gitleaks':
      throw new MalformedReportError(
        'gitleaks',
        'unsupported-tool',
        '',
        'gitleaks output feeds redaction, not candidates',
      );
    default:
      throw new MalformedReportError('semgrep', 'unsupported-tool', '', 'unknown tool name');
  }
}

/**
 * Reads the report files of a successful L1-02 run into ReportInputs. A symlink, a non-regular
 * file, an oversize file or invalid JSON throws MalformedReportError. A run the wrapper marked
 * `empty` has no reports and yields none. Gitleaks runs and unknown tools are rejected.
 */
export async function readToolRunReports(
  run: ToolRunResult,
  options: { maxReportBytes?: number } = {},
): Promise<ReportInput[]> {
  const tool = sourceToolOf(run.name);
  const max = options.maxReportBytes ?? DEFAULT_MAX_REPORT_BYTES;
  const out: ReportInput[] = [];
  for (const report of run.reports) {
    const unreadable = (why: string) =>
      new MalformedReportError(tool, 'unreadable', report.file, why);
    let text: string;
    try {
      const before = await lstat(report.file);
      if (!before.isFile()) throw unreadable('not a regular file');
      // O_NOFOLLOW (where it exists) plus fstat on the opened handle, so a file swapped for a
      // symlink between the check and the open is not followed, and the size is the opened file's.
      const handle = await open(
        report.file,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      try {
        const st = await handle.stat();
        if (!st.isFile()) throw unreadable('not a regular file');
        if (st.size > max) {
          throw new MalformedReportError(
            tool,
            'too-large',
            report.file,
            `${st.size} bytes, limit ${max}`,
          );
        }
        // Read in chunks and stop past max: a file that grows after fstat is still bounded.
        const parts: Buffer[] = [];
        let total = 0;
        for (;;) {
          const b = Buffer.alloc(Math.min(1 << 20, max + 1 - total));
          const { bytesRead } = await handle.read(b, 0, b.length, total);
          if (bytesRead === 0) break;
          total += bytesRead;
          if (total > max) {
            throw new MalformedReportError(tool, 'too-large', report.file, `over ${max} bytes`);
          }
          parts.push(b.subarray(0, bytesRead));
        }
        text = Buffer.concat(parts).toString('utf8');
      } finally {
        await handle.close();
      }
    } catch (e) {
      if (e instanceof MalformedReportError) throw e;
      throw unreadable('cannot open the report');
    }
    let doc: unknown;
    try {
      doc = JSON.parse(text) as unknown;
    } catch {
      throw new MalformedReportError(tool, 'invalid-json', report.file, 'not valid JSON');
    }
    out.push({ tool, doc, partial: run.partial });
  }
  return out;
}
