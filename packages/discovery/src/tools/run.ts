import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ToolRunnerPort } from '@affidavit/contracts';
import { buildInvocation, type ToolInvocation, type ToolRunOptions } from './invocations.js';
import { findOsvLockfiles } from './lockfiles.js';
import { isEmptyExit, isOkExit, type ToolManifest, type ToolName } from './manifest.js';
import {
  assertSnapshotClean,
  prepareOutput,
  prepareScratch,
  type QuarantinedSnapshot,
} from './quarantine.js';

export type RunToolOptions = Omit<ToolRunOptions, 'sourceDir'> & {
  /** The quarantined scan copy. Its removed-path list is passed through on the result. */
  snapshot: QuarantinedSnapshot;
};

export interface ToolNotification {
  level: string;
  /** Tool-specific kind, for example Semgrep's "Syntax error". */
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
   * True when the tool reported that it skipped, timed out on, or failed to parse something.
   * Findings are then incomplete. Treat it as a signal, not as "clean".
   */
  partial: boolean;
  notifications: ToolNotification[];
  outputPath: string;
  /** Main report file name under the output directory. Absent only when `empty`. */
  outputFile: string;
  /** Every report to read, with its origin. Empty when `empty`. */
  reports: ToolReport[];
  /** Original paths that quarantine moved aside. Record them as a signal on the case. */
  quarantined: readonly string[];
}

/** The tool exited normally but did not leave a regular, non-empty report where expected. */
export class ToolOutputMissingError extends Error {
  constructor(tool: string, file: string, why: string) {
    super(`${tool} did not produce a usable report at ${file}: ${why}`);
    this.name = 'ToolOutputMissingError';
  }
}

/** The tool failed, or exited in a way that cannot be trusted as a result. */
export class ToolFailedError extends Error {
  readonly tool: ToolName;
  readonly exitCode: number;
  readonly quarantined: readonly string[];
  constructor(tool: ToolName, exitCode: number, why: string, quarantined: readonly string[]) {
    super(`${tool} failed (exit ${exitCode}): ${why}`);
    this.name = 'ToolFailedError';
    this.tool = tool;
    this.exitCode = exitCode;
    this.quarantined = quarantined;
  }
}

async function requireReport(tool: string, file: string): Promise<void> {
  let st;
  try {
    st = await lstat(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new ToolOutputMissingError(
      tool,
      file,
      code === 'ENOENT' ? 'file does not exist' : `cannot stat it (${code ?? 'unknown error'})`,
    );
  }
  if (!st.isFile()) throw new ToolOutputMissingError(tool, file, 'not a regular file');
  if (st.size === 0) throw new ToolOutputMissingError(tool, file, 'file is empty');
}

/** Semgrep reports skipped, timed-out and unparsed files as SARIF notifications, with exit 0. */
async function semgrepNotifications(file: string): Promise<ToolNotification[]> {
  const sarif = JSON.parse(await readFile(file, 'utf8')) as {
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

/** Maps a gitleaks SARIF uri inside the sidecar (`/src/q0001/...`) back to the original path. */
function mapSidecarUri(uri: string, mapping: ReadonlyMap<string, string>): string {
  const m = /^(?:file:\/\/)?\/?(?:src\/)?(q\d{4})(\/.*)?$/.exec(uri);
  const original = m?.[1] ? mapping.get(m[1]) : undefined;
  return original === undefined ? uri : `${original}${m?.[2] ?? ''}`;
}

async function rewriteSidecarReport(file: string, mapping: ReadonlyMap<string, string>) {
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
  const doc: unknown = JSON.parse(await readFile(file, 'utf8'));
  walk(doc);
  await writeFile(file, JSON.stringify(doc));
}

interface Exec {
  inv: ToolInvocation;
  exitCode: number;
  outputPath: string;
}

async function execute(
  runner: ToolRunnerPort,
  manifest: ToolManifest,
  name: ToolName,
  options: ToolRunOptions,
  quarantined: readonly string[],
): Promise<Exec> {
  const inv = buildInvocation(manifest, name, options);
  await prepareScratch(options.scratchDir, inv.scratchSubdirs);
  await prepareOutput(options.outputDir);
  const res = await runner.run(inv.image, inv.args, inv.mounts);
  if (!isOkExit(manifest, name, res.exitCode)) {
    throw new ToolFailedError(name, res.exitCode, 'unexpected exit code', quarantined);
  }
  if (resolve(res.outputPath) !== resolve(options.outputDir)) {
    throw new ToolOutputMissingError(
      name,
      options.outputDir,
      `the runner reported a different output path (${res.outputPath})`,
    );
  }
  return { inv, exitCode: res.exitCode, outputPath: res.outputPath };
}

/**
 * Runs one tool through the port. Fails closed:
 * - refuses a snapshot that still holds tool-control paths (SnapshotNotCleanError),
 * - refuses scratch and output directories that are not new and empty,
 * - throws ToolFailedError for any exit code the manifest does not list as normal,
 * - after the run, requires the report to be a regular, non-empty file (ToolOutputMissingError).
 *   A symlink planted at the report path is refused because lstat does not follow it,
 * - OSV-Scanner exit 128 ("no packages found") is an empty result only if discovery's own check
 *   finds no lockfile the tool could read; otherwise it is a failed parse and throws.
 *
 * gitleaks also scans the quarantined files (the sidecar) so a secret in a removed file is not
 * missed. That second report goes to `<outputDir>-quarantine` with paths mapped back to the
 * originals, and is listed in `reports`.
 */
export async function runTool(
  runner: ToolRunnerPort,
  manifest: ToolManifest,
  name: ToolName,
  options: RunToolOptions,
): Promise<ToolRunResult> {
  const { snapshot, ...rest } = options;
  const q = snapshot.removed;
  await assertSnapshotClean(snapshot.dir);
  const run = await execute(runner, manifest, name, { ...rest, sourceDir: snapshot.dir }, q);
  const base = {
    name,
    exitCode: run.exitCode,
    outputPath: run.outputPath,
    outputFile: run.inv.outputFile,
    quarantined: q,
  };

  if (isEmptyExit(manifest, name, run.exitCode)) {
    const lockfiles = name === 'osv-scanner' ? await findOsvLockfiles(snapshot.dir) : [];
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

  const file = join(options.outputDir, run.inv.outputFile);
  await requireReport(name, file);
  const reports: ToolReport[] = [{ file, origin: 'snapshot' }];
  const notifications = name === 'semgrep' ? await semgrepNotifications(file) : [];

  if (name === 'gitleaks' && snapshot.sidecarDir !== null) {
    const side = await execute(
      runner,
      manifest,
      name,
      {
        ...rest,
        sourceDir: snapshot.sidecarDir,
        outputDir: `${options.outputDir}-quarantine`,
        scratchDir: `${options.scratchDir}-quarantine`,
      },
      q,
    );
    const sideFile = join(`${options.outputDir}-quarantine`, side.inv.outputFile);
    await requireReport(name, sideFile);
    await rewriteSidecarReport(sideFile, snapshot.mapping);
    reports.push({ file: sideFile, origin: 'quarantine' });
  }

  return { ...base, empty: false, partial: notifications.length > 0, notifications, reports };
}
