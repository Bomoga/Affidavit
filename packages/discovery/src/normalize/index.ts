// L1-03: turns Semgrep SARIF, CodeQL SARIF and OSV-Scanner JSON into Candidate objects.
// Gitleaks output is not a Candidate source (it feeds redaction).
import { lstat, readFile } from 'node:fs/promises';
import type { Candidate } from '@affidavit/contracts';
import type { ToolRunResult } from '../tools/index.js';
import { MalformedReportError, type SourceTool } from './guards.js';
import { mergeFindings } from './merge.js';
import { parseOsv, parseSarif, type SkippedFinding } from './parse.js';

export {
  MalformedReportError,
  LIMITS as NORMALIZE_LIMITS,
  type MalformedCode,
  type SourceTool,
} from './guards.js';
export { IDOR_CWES, INJECTION_CWES, classOf, cweNumber, cweNumbers } from './classify.js';
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
   * Findings that were read but not turned into candidates (outside the MVP classes, or no
   * location). Callers must record them; none is silently dropped.
   */
  skipped: SkippedFinding[];
  /** Tools whose run was partial, so an absent finding is not evidence of absence. */
  partialTools: SourceTool[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Normalizes already-parsed reports. Throws MalformedReportError (and nothing else) for a report
 * that is not valid SARIF or OSV JSON, has an unsafe path, or exceeds a size cap.
 */
export function normalizeReports(inputs: readonly ReportInput[]): NormalizeResult {
  try {
    const findings = [];
    const skipped: SkippedFinding[] = [];
    for (const input of inputs) {
      const parsed = input.tool === 'osv' ? parseOsv(input.doc) : parseSarif(input.tool, input.doc);
      findings.push(...parsed.findings);
      skipped.push(...parsed.skipped);
    }
    skipped.sort(
      (a, b) =>
        cmp(a.tool, b.tool) ||
        cmp(a.file ?? '', b.file ?? '') ||
        cmp(a.ruleId, b.ruleId) ||
        cmp(a.reason, b.reason),
    );
    const partialTools = [...new Set(inputs.filter((i) => i.partial === true).map((i) => i.tool))];
    return { candidates: mergeFindings(findings), skipped, partialTools: partialTools.sort(cmp) };
  } catch (e) {
    if (e instanceof MalformedReportError) throw e;
    // A bug or an engine limit must still surface as a typed error, never a crash.
    throw new MalformedReportError(
      inputs[0]?.tool ?? 'semgrep',
      'unexpected',
      '',
      e instanceof Error ? e.message : 'unexpected failure',
      { cause: e },
    );
  }
}

const DEFAULT_MAX_REPORT_BYTES = 128 * 1024 * 1024;

/**
 * Reads the report files of a successful L1-02 run into ReportInputs. A symlink, a non-regular
 * file, an oversize file or invalid JSON throws MalformedReportError. A run the wrapper marked
 * `empty` has no reports and yields none. Gitleaks runs are rejected: they are not findings.
 */
export async function readToolRunReports(
  run: ToolRunResult,
  options: { maxReportBytes?: number } = {},
): Promise<ReportInput[]> {
  if (run.name === 'gitleaks') {
    throw new MalformedReportError(
      'gitleaks',
      'unsupported-tool',
      '',
      'gitleaks output feeds redaction, not candidates',
    );
  }
  const tool: SourceTool = run.name === 'semgrep' ? 'semgrep' : 'osv';
  const max = options.maxReportBytes ?? DEFAULT_MAX_REPORT_BYTES;
  const out: ReportInput[] = [];
  for (const report of run.reports) {
    let size: number;
    try {
      const st = await lstat(report.file);
      if (!st.isFile()) {
        throw new MalformedReportError(tool, 'unreadable', report.file, 'not a regular file');
      }
      size = st.size;
    } catch (e) {
      if (e instanceof MalformedReportError) throw e;
      throw new MalformedReportError(tool, 'unreadable', report.file, 'cannot stat the report');
    }
    if (size > max) {
      throw new MalformedReportError(tool, 'too-large', report.file, `${size} bytes, limit ${max}`);
    }
    let doc: unknown;
    try {
      doc = JSON.parse(await readFile(report.file, 'utf8')) as unknown;
    } catch {
      throw new MalformedReportError(tool, 'invalid-json', report.file, 'not valid JSON');
    }
    out.push({ tool, doc, partial: run.partial });
  }
  return out;
}
