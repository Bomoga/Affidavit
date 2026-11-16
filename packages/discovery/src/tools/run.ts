import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ToolRunnerPort } from '@affidavit/contracts';
import { buildInvocation, type ToolInvocation, type ToolRunOptions } from './invocations.js';
import { findOsvLockfiles } from './lockfiles.js';
import { isEmptyExit, isOkExit, type ToolManifest, type ToolName } from './manifest.js';
import {
  assertSnapshotClean,
  gitDirExtraContent,
  prepareOutput,
  prepareScratch,
  type QuarantinedSnapshot,
} from './quarantine.js';
import { findGitleaksUnscannable, type Unscannable } from './unscannable.js';

export type RunToolOptions = Omit<ToolRunOptions, 'sourceDir'> & {
  /** The quarantined scan copy. Its removed-path list is passed through on the result. */
  snapshot: QuarantinedSnapshot;
};

export interface ToolNotification {
  level: string;
  /** Tool-specific kind, for example Semgrep's "Syntax error" or "binary-looking-file". */
  id?: string;
  message: string;
}

export interface ToolReport {
  /** Absolute host path of a report file. */
  file: string;
  /** `quarantine` reports cover the files moved out of the snapshot; paths are mapped back. */
  origin: 'snapshot' | 'quarantine';
}

/**
 * A successful run. A failed run never produces one: it throws ToolFailedError, so a missing or
 * partial report cannot be parsed as a result.
 */
export interface ToolRunResult {
  name: ToolName;
  exitCode: number;
  /** True when the tool said there was nothing to scan and wrote no report (OSV-Scanner 128). */
  empty: boolean;
  /**
   * True when the run may have missed something: Semgrep reported a timeout or unparsed file,
   * gitleaks was given files it silently skips as binary, or OSV-Scanner's report lacks a lockfile
   * the snapshot has. Findings are then incomplete. Treat it as a signal, not as "clean".
   */
  partial: boolean;
  notifications: ToolNotification[];
  /** The output directory the run wrote into (the one passed in options). */
  outputPath: string;
  /** Name of the main report file. When `empty`, no file was written under this name. */
  outputFile: string;
  /** Every report to read, with its origin. Empty when `empty`. */
  reports: ToolReport[];
  /** Original paths that quarantine moved aside. Record them as a signal on the case. */
  quarantined: readonly string[];
}

type Pass = 'snapshot' | 'quarantine';

const where = (pass: Pass) => (pass === 'quarantine' ? ' (quarantine pass)' : '');

/** The tool exited normally but did not leave a regular, non-empty, valid report where expected. */
export class ToolOutputMissingError extends Error {
  readonly tool: string;
  readonly quarantined: readonly string[];
  constructor(
    tool: string,
    file: string,
    why: string,
    quarantined: readonly string[] = [],
    pass: Pass = 'snapshot',
  ) {
    super(`${tool}${where(pass)} did not produce a usable report at ${file}: ${why}`);
    this.name = 'ToolOutputMissingError';
    this.tool = tool;
    this.quarantined = quarantined;
  }
}

/** The tool failed, or exited in a way that cannot be trusted as a result. */
export class ToolFailedError extends Error {
  readonly tool: ToolName;
  readonly exitCode: number;
  readonly quarantined: readonly string[];
  constructor(
    tool: ToolName,
    exitCode: number,
    why: string,
    quarantined: readonly string[],
    pass: Pass = 'snapshot',
  ) {
    super(`${tool}${where(pass)} failed (exit ${exitCode}): ${why}`);
    this.name = 'ToolFailedError';
    this.tool = tool;
    this.exitCode = exitCode;
    this.quarantined = quarantined;
  }
}

/** Requires a regular, non-empty file (lstat, so a symlink is refused) holding valid JSON. */
async function readJsonReport(
  tool: string,
  file: string,
  q: readonly string[],
  pass: Pass,
): Promise<unknown> {
  let st;
  try {
    st = await lstat(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new ToolOutputMissingError(
      tool,
      file,
      code === 'ENOENT' ? 'file does not exist' : `cannot stat it (${code ?? 'unknown error'})`,
      q,
      pass,
    );
  }
  if (!st.isFile()) throw new ToolOutputMissingError(tool, file, 'not a regular file', q, pass);
  if (st.size === 0) throw new ToolOutputMissingError(tool, file, 'file is empty', q, pass);
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    throw new ToolOutputMissingError(tool, file, 'not valid JSON (truncated?)', q, pass);
  }
}

/** Semgrep reports skipped, timed-out and unparsed files as SARIF notifications, with exit 0. */
function semgrepNotifications(doc: unknown): ToolNotification[] {
  const sarif = doc as {
    runs?: {
      invocations?: {
        executionSuccessful?: boolean;
        toolExecutionNotifications?: {
          level?: string;
          descriptor?: { id?: string };
          message?: { text?: string };
        }[];
      }[];
    }[];
  };
  const out: ToolNotification[] = [];
  for (const run of sarif.runs ?? []) {
    for (const inv of run.invocations ?? []) {
      for (const n of inv.toolExecutionNotifications ?? []) {
        out.push({
          level: n.level ?? 'warning',
          ...(n.descriptor?.id ? { id: n.descriptor.id } : {}),
          message: n.message?.text ?? '',
        });
      }
      if (inv.executionSuccessful === false) {
        out.push({ level: 'error', message: 'tool reported executionSuccessful=false' });
      }
    }
  }
  return out;
}

/** OSV-Scanner JSON: lockfiles the snapshot has that never show up as a source in the report. */
function osvMissingLockfiles(doc: unknown, lockfiles: readonly string[]): string[] {
  const report = doc as { results?: { source?: { path?: string } }[] };
  const sources = (report.results ?? []).map((r) => r.source?.path ?? '');
  return lockfiles.filter(
    // Exact paths only: a suffix match would let a good extra/package-lock.json hide a malformed
    // package-lock.json at the root.
    (lf) => !sources.some((s) => s === `/src/${lf}` || s === lf),
  );
}

const MAX_FILE_NOTES = 200;

const KIND_TEXT: Record<Unscannable['kind'], string> = {
  'binary-asset': 'is a binary file, which gitleaks does not scan',
  'binary-header-mismatch':
    'starts with a binary file signature that does not match its extension, so gitleaks may skip it; a secret could be hidden behind that header',
  'non-text-header':
    'does not start like plain text (NUL bytes, invalid UTF-8 or control characters, or UTF-16), so gitleaks may skip it',
  unreadable: 'could not be read (mode or ownership), so the jailed gitleaks cannot read it either',
};

function binaryNotes(files: readonly Unscannable[]): ToolNotification[] {
  const notes = files.slice(0, MAX_FILE_NOTES).map((f) => ({
    level: 'warning',
    id: f.kind,
    message: `/src/${f.path} ${KIND_TEXT[f.kind]}`,
  }));
  if (files.length > MAX_FILE_NOTES) {
    notes.push({
      level: 'warning',
      id: 'binary-asset',
      message: `${files.length - MAX_FILE_NOTES} more files not listed`,
    });
  }
  return notes;
}

/** Maps a sidecar entry (`q0001/...`) back to its original path under /src. */
function mapSidecarPath(path: string, mapping: ReadonlyMap<string, string>): string | undefined {
  const m = /^(q\d+)(\/.*)?$/.exec(path);
  const original = m?.[1] ? mapping.get(m[1]) : undefined;
  return original === undefined ? undefined : `${original}${m?.[2] ?? ''}`;
}

/** Rewrites a gitleaks SARIF uri inside the sidecar to `/src/<original path>`. */
function mapSidecarUri(uri: string, mapping: ReadonlyMap<string, string>): string {
  const stripped = uri.replace(/^file:\/\//, '').replace(/^\/?(?:src\/)?/, '');
  const mapped = mapSidecarPath(stripped, mapping);
  return mapped === undefined ? uri : `/src/${mapped}`;
}

async function rewriteSidecarReport(
  file: string,
  doc: unknown,
  mapping: ReadonlyMap<string, string>,
): Promise<void> {
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const [k, val] of Object.entries(o)) {
        if (k === 'uri' && typeof val === 'string') o[k] = mapSidecarUri(val, mapping);
        else walk(val);
      }
    }
  };
  walk(doc);
  await writeFile(file, JSON.stringify(doc));
}

interface Exec {
  inv: ToolInvocation;
  exitCode: number;
}

async function execute(
  runner: ToolRunnerPort,
  manifest: ToolManifest,
  name: ToolName,
  options: ToolRunOptions,
  quarantined: readonly string[],
  pass: Pass,
): Promise<Exec> {
  const inv = buildInvocation(manifest, name, options);
  await prepareScratch(options.scratchDir, inv.scratchSubdirs);
  await prepareOutput(options.outputDir);
  // The runner's returned outputPath is deliberately not compared with options.outputDir: the
  // runners in use return a directory fixed at construction and ignore the /out mount. What counts
  // is that the tool wrote its report into the mount, which readJsonReport verifies.
  let res;
  try {
    res = await runner.run(inv.image, inv.args, inv.mounts);
  } catch (e) {
    // Runners reject mounts, time out or crash in ways of their own. Always surface a typed error.
    const why = e instanceof Error ? e.message : String(e);
    throw new ToolFailedError(name, -1, `the runner threw: ${why}`, quarantined, pass);
  }
  if (!isOkExit(manifest, name, res.exitCode)) {
    throw new ToolFailedError(name, res.exitCode, 'unexpected exit code', quarantined, pass);
  }
  return { inv, exitCode: res.exitCode };
}

/**
 * Runs one tool through the port. Fails closed:
 * - refuses a snapshot that still holds tool-control paths (SnapshotNotCleanError),
 * - refuses scratch and output directories that are not new and empty,
 * - throws ToolFailedError for any exit code the manifest does not list as normal,
 * - after the run, requires the report to be a regular, non-empty file holding valid JSON
 *   (ToolOutputMissingError). A symlink planted at the report path is refused because lstat does
 *   not follow it,
 * - OSV-Scanner exit 128 ("no packages found") is an empty result only if discovery's own check
 *   finds no lockfile the tool could read; otherwise it is a failed parse and throws.
 *
 * Runs that succeed but may have missed something come back with `partial: true` and the reasons
 * in `notifications` (see ToolRunResult).
 *
 * gitleaks also scans the quarantined files (the sidecar) so a secret in a removed file is not
 * missed. That second report goes to `<outputDir>-quarantine` with paths mapped back to
 * `/src/<original>`, and is listed in `reports`. Sidecar files are scanned under neutral names, so
 * rules or allowlists that match on path see `q0001` and not the real name (accepted gap).
 */
export async function runTool(
  runner: ToolRunnerPort,
  manifest: ToolManifest,
  name: ToolName,
  options: RunToolOptions,
): Promise<ToolRunResult> {
  const { snapshot, ...rest } = options;
  const q = snapshot.removed;
  const outputDir = resolve(options.outputDir);
  const scratchDir = resolve(options.scratchDir);
  await assertSnapshotClean(snapshot.dir);
  const run = await execute(
    runner,
    manifest,
    name,
    { ...rest, outputDir, scratchDir, sourceDir: snapshot.dir },
    q,
    'snapshot',
  );
  const base = {
    name,
    exitCode: run.exitCode,
    outputPath: outputDir,
    outputFile: run.inv.outputFile,
    quarantined: q,
  };

  const lockfiles = name === 'osv-scanner' ? await findOsvLockfiles(snapshot.dir) : [];
  if (isEmptyExit(manifest, name, run.exitCode)) {
    if (lockfiles.length > 0) {
      throw new ToolFailedError(
        name,
        run.exitCode,
        `reported no packages although the snapshot has lockfiles (${lockfiles.slice(0, 5).join(', ')}); a lockfile probably failed to parse`,
        q,
      );
    }
    return { ...base, empty: true, partial: false, notifications: [], reports: [] };
  }

  const file = join(outputDir, run.inv.outputFile);
  const doc = await readJsonReport(name, file, q, 'snapshot');
  const reports: ToolReport[] = [{ file, origin: 'snapshot' }];
  const notifications: ToolNotification[] = [];

  if (name === 'semgrep') notifications.push(...semgrepNotifications(doc));

  if (name === 'semgrep' || name === 'osv-scanner') {
    // .git directories are moved aside and never scanned by these tools. Anything in one that is
    // not git metadata was hidden from them.
    for (const extra of await gitDirExtraContent(snapshot)) {
      notifications.push({
        level: 'warning',
        id: 'git-dir-extra-content',
        message: `/src/${extra} sits inside a quarantined .git directory and was not scanned by ${name}`,
      });
    }
  }

  if (name === 'osv-scanner') {
    const missing = osvMissingLockfiles(doc, lockfiles);
    for (const lf of missing) {
      notifications.push({
        level: 'warning',
        id: 'lockfile-not-in-report',
        message: `/src/${lf} is not in the report: it may have failed to parse, or hold no packages`,
      });
    }
  }

  if (name === 'gitleaks') {
    const unscanned = await findGitleaksUnscannable(snapshot.dir);
    if (snapshot.sidecarDir !== null) {
      const side = await findGitleaksUnscannable(snapshot.sidecarDir);
      for (const f of side) {
        const original = mapSidecarPath(f.path, snapshot.mapping);
        // Git history (objects and packs) is an accepted gap, not a per-file signal. Other files
        // inside a quarantined .git directory are still checked.
        if (original !== undefined && !/(?:^|\/)\.git\/objects(?:\/|$)/i.test(original)) {
          unscanned.push({ path: original, kind: f.kind });
        }
      }
    }

    if (snapshot.sidecarDir !== null) {
      const sideOut = `${outputDir}-quarantine`;
      await execute(
        runner,
        manifest,
        name,
        {
          ...rest,
          sourceDir: snapshot.sidecarDir,
          outputDir: sideOut,
          scratchDir: `${scratchDir}-quarantine`,
        },
        q,
        'quarantine',
      );
      const sideFile = join(sideOut, run.inv.outputFile);
      const sideDoc = await readJsonReport(name, sideFile, q, 'quarantine');
      await rewriteSidecarReport(sideFile, sideDoc, snapshot.mapping);
      reports.push({ file: sideFile, origin: 'quarantine' });
    }
    notifications.push(...binaryNotes(unscanned.sort((a, b) => a.path.localeCompare(b.path))));
  }

  return { ...base, empty: false, partial: notifications.length > 0, notifications, reports };
}
