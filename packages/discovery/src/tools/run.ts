import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { remapWindowReport, windowPathParts, writeWindows } from './windows.js';

export type RunToolOptions = Omit<ToolRunOptions, 'sourceDir'> & {
  /** The quarantined scan copy. Its removed-path list is passed through on the result. */
  snapshot: QuarantinedSnapshot;
  /** Largest report file runTool will read, in bytes. Default 128 MiB. */
  maxReportBytes?: number | undefined;
  /** Largest total of window bytes written for the gitleaks windows pass. Default 256 MiB. */
  maxWindowBytes?: number | undefined;
};

const DEFAULT_MAX_REPORT_BYTES = 128 * 1024 * 1024;

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
  origin: 'snapshot' | 'quarantine' | 'windows';
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
   * gitleaks was given files it may skip or cut through (see UnscannableKind), a quarantined .git
   * hid content from Semgrep and OSV, or OSV-Scanner's report lacks a lockfile
   * the snapshot has. Findings are then incomplete. Treat it as a signal, not as "clean".
   */
  partial: boolean;
  notifications: ToolNotification[];
  /**
   * Image, audio and video files whose extension agrees with their signature. gitleaks reads these as text (probed on the pinned image),
   * so a plaintext secret inside is found; they are listed for information only and, unlike
   * everything in `notifications`, do not make the run `partial`. Archives, PDFs, SQLite files and
   * executables are NOT here: gitleaks skips them, so they are coverage losses.
   */
  binaryMediaFiles: string[];
  /**
   * Text files over 100,000 bytes that were also scanned in overlapping windows (see windows.ts),
   * as `/src/<path>`. The windows report (origin 'windows') maps findings back to these files and
   * lines. A finding can appear in both the snapshot report and the windows report; merge them by
   * rule, path and region.
   */
  windowedFiles: string[];
  /** The output directory the run wrote into (the one passed in options). */
  outputPath: string;
  /** Name of the main report file. When `empty`, no file was written under this name. */
  outputFile: string;
  /** Every report to read, with its origin. Empty when `empty`. */
  reports: ToolReport[];
  /** Original paths that quarantine moved aside. Record them as a signal on the case. */
  quarantined: readonly string[];
}

type Pass = 'snapshot' | 'quarantine' | 'windows';

const where = (pass: Pass) => (pass === 'snapshot' ? '' : ` (${pass} pass)`);

/** The tool exited normally but did not leave a regular, non-empty, valid report where expected. */
export class ToolOutputMissingError extends Error {
  readonly tool: ToolName;
  readonly quarantined: readonly string[];
  constructor(
    tool: ToolName,
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
  tool: ToolName,
  file: string,
  q: readonly string[],
  pass: Pass,
  maxBytes: number,
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
  if (st.size > maxBytes) {
    throw new ToolOutputMissingError(
      tool,
      file,
      `report too large (${st.size} bytes, limit ${maxBytes}); not read`,
      q,
      pass,
    );
  }
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    throw new ToolOutputMissingError(tool, file, 'not valid JSON (truncated?)', q, pass);
  }
  // Shape check, so a well-formed but wrong document (or one an attacker shaped) is a typed
  // failure and not a silent "no findings".
  const isObject = typeof doc === 'object' && doc !== null && !Array.isArray(doc);
  const runs = isObject ? (doc as { runs?: unknown }).runs : undefined;
  if (tool === 'osv-scanner' ? !isObject : !Array.isArray(runs)) {
    throw new ToolOutputMissingError(
      tool,
      file,
      tool === 'osv-scanner' ? 'not an OSV report object' : 'not a SARIF document (no runs array)',
      q,
      pass,
    );
  }
  return doc;
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

const KIND_TEXT: Record<Exclude<Unscannable['kind'], 'binary-media'>, string> = {
  'binary-header-mismatch':
    'starts with a file signature gitleaks skips (archive, PDF, executable, database and similar) that does not match its extension, so a secret could be hidden behind that header',
  'skipped-file-type':
    'is a file type gitleaks skips (archive, PDF, SQLite, executable and similar). Archives it can unpack are searched, but members it cannot read (UTF-16, another skipped header) are not, and discovery does not unpack them',
  'non-text-content':
    'is not plain text (control characters at the start, or NUL bytes or invalid UTF-8 anywhere, as in UTF-16 text), so gitleaks may skip it',
  'chunk-split-risk':
    'is over 100 KB with a 25 KB stretch that has no blank line, so gitleaks may cut a chunk through a secret and miss it',
  'archive-name-mismatch':
    'has a name gitleaks reads as an archive (a .gz, .zip, .tar or similar, anywhere in the name) but is not one, so gitleaks drops it without scanning; it is scanned in a window under a neutral name instead',
  'multiline-split-risk':
    'holds a private-key block with a blank line inside it, in a file large enough to be cut into chunks, so gitleaks may split the key and miss it',
  unreadable:
    'could not be read by the host user (mode or ownership), so the jailed gitleaks may not read it either',
};

// Files in the quarantine sidecar are scanned by the sidecar pass only, never windowed, so the
// usual 'scanned in a window' wording would be wrong for them.
const QUARANTINED_ARCHIVE_TEXT =
  'was moved to the quarantine sidecar and has a name gitleaks reads as an archive but is not one, so gitleaks drops it and its content is NOT scanned (sidecar files are not windowed)';

const KIND_ORDER = [
  'binary-header-mismatch',
  'non-text-content',
  'unreadable',
  'skipped-file-type',
  'archive-name-mismatch',
  'chunk-split-risk',
  'multiline-split-risk',
] as const;

/**
 * Splits gitleaks coverage findings. Everything except media files (image, audio, video) is a
 * coverage loss: it becomes a notification, never truncated, listed by severity. gitleaks reads
 * media files as text (probed), so they lose nothing and are returned apart.
 */
function coverageSplit(files: readonly (Unscannable & { quarantined?: boolean })[]): {
  notifications: ToolNotification[];
  binaryMediaFiles: string[];
} {
  const notifications: ToolNotification[] = [];
  for (const kind of KIND_ORDER) {
    for (const f of files) {
      if (f.kind === kind) {
        notifications.push({
          level: 'warning',
          id: kind,
          message: `/src/${f.path} ${f.quarantined && kind === 'archive-name-mismatch' ? QUARANTINED_ARCHIVE_TEXT : KIND_TEXT[kind]}`,
        });
      }
    }
  }
  const binaryMediaFiles = files
    .filter((f) => f.kind === 'binary-media')
    .map((f) => `/src/${f.path}`);
  return { notifications, binaryMediaFiles };
}

/**
 * The notification for a path in the windows directory that gitleaks may skip. A hit that does
 * not map to a window (a directory, or anything else unexpected) is still reported, with its raw
 * path, and never discarded.
 */
export function windowHitNotification(
  hit: Unscannable,
  byName: ReadonlyMap<string, { original: string; startLine: number }>,
): ToolNotification {
  const parts = windowPathParts(hit.path);
  const w = parts === undefined ? undefined : byName.get(parts.name);
  return {
    level: 'warning',
    id: 'window-skipped',
    message:
      w !== undefined
        ? `/src/${w.original} has a window (from line ${w.startLine}) that gitleaks may skip (${hit.kind}), so a secret in that part may be missed`
        : `a path in the windows directory that gitleaks may skip (${hit.kind}) could not be mapped to a window: ${hit.path}`,
  };
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
  const { snapshot, maxReportBytes, maxWindowBytes, ...rest } = options;
  const maxBytes = maxReportBytes ?? DEFAULT_MAX_REPORT_BYTES;
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
    return {
      ...base,
      empty: true,
      partial: false,
      notifications: [],
      binaryMediaFiles: [],
      windowedFiles: [],
      reports: [],
    };
  }

  const file = join(outputDir, run.inv.outputFile);
  const doc = await readJsonReport(name, file, q, 'snapshot', maxBytes);
  const reports: ToolReport[] = [{ file, origin: 'snapshot' }];
  const notifications: ToolNotification[] = [];
  let binaryMediaFiles: string[] = [];
  let windowedFiles: string[] = [];

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
    const unscanned: (Unscannable & { quarantined?: boolean })[] = await findGitleaksUnscannable(
      snapshot.dir,
    );
    if (snapshot.sidecarDir !== null) {
      // git's index and object store are expected to be binary and are not walked at all. Every
      // other file inside a quarantined .git (config, info/exclude, hooks, refs, ...) is text
      // and is checked like any other.
      const isGitBulk = (rel: string): boolean => {
        const original = mapSidecarPath(rel, snapshot.mapping);
        return original !== undefined && /(?:^|\/)\.git\/(?:index|objects)(?:\/|$)/i.test(original);
      };
      const side = await findGitleaksUnscannable(snapshot.sidecarDir, {
        skip: (rel) => isGitBulk(rel),
      });
      for (const f of side) {
        const original = mapSidecarPath(f.path, snapshot.mapping);
        if (original !== undefined)
          unscanned.push({ path: original, kind: f.kind, quarantined: true });
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
      const sideDoc = await readJsonReport(name, sideFile, q, 'quarantine', maxBytes);
      await rewriteSidecarReport(sideFile, sideDoc, snapshot.mapping);
      reports.push({ file: sideFile, origin: 'quarantine' });
    }
    // Windows pass: every plain text file over 100,000 bytes again, in overlapping windows under
    // 100,000 bytes, so gitleaks reads each window in one piece and cannot cut through a secret.
    // A directory unique to this call: it is created here and only what this call created is
    // removed, so two runs on one copy (or a leftover from another run) never delete each
    // other's windows.
    const windowsDir = await mkdtemp(`${resolve(snapshot.dir)}.windows-`);
    try {
      // files that already carry a coverage flag are windowed first if the budget is tight
      const priority = new Set(
        unscanned
          .filter((f) =>
            ['chunk-split-risk', 'multiline-split-risk', 'archive-name-mismatch'].includes(f.kind),
          )
          .map((f) => f.path),
      );
      const win = await writeWindows(snapshot.dir, windowsDir, {
        maxBytes: maxWindowBytes,
        priority,
      });
      for (const f of win.failed) {
        notifications.push({
          level: 'warning',
          id: 'window-skipped',
          message: `/src/${f.original} could not be windowed (${f.why}), so a secret across a gitleaks chunk cut in it may be missed`,
        });
      }
      for (const f of win.skippedForBudget) {
        notifications.push({
          level: 'warning',
          id: 'windows-budget-exceeded',
          message: `/src/${f} was not scanned in windows because the window byte budget ran out, so a secret across a gitleaks chunk cut in it may be missed`,
        });
      }
      if (win.entries.length > 0) {
        // A window can still be skipped as binary by an offset signature (for example `ustar` at
        // byte 257). Check every window with the same table and report hits against the original.
        const byName = new Map(win.entries.map((e) => [e.name, e]));
        for (const hit of await findGitleaksUnscannable(windowsDir)) {
          notifications.push(windowHitNotification(hit, byName));
        }
        const winOut = `${outputDir}-windows`;
        await execute(
          runner,
          manifest,
          name,
          {
            ...rest,
            sourceDir: windowsDir,
            outputDir: winOut,
            scratchDir: `${scratchDir}-windows`,
          },
          q,
          'windows',
        );
        const winFile = join(winOut, run.inv.outputFile);
        const winDoc = await readJsonReport(name, winFile, q, 'windows', maxBytes);
        remapWindowReport(winDoc, win.entries);
        await writeFile(winFile, JSON.stringify(winDoc));
        reports.push({ file: winFile, origin: 'windows' });
        windowedFiles = [...new Set(win.entries.map((e) => `/src/${e.original}`))];
      }
    } finally {
      // The windows are scratch data and can be large. Remove them, on success or failure. This
      // is the unique directory created above, never a path another run could own.
      await rm(windowsDir, { recursive: true, force: true });
    }
    const split = coverageSplit(unscanned.sort((a, b) => a.path.localeCompare(b.path)));
    notifications.push(...split.notifications);
    binaryMediaFiles = split.binaryMediaFiles;
  }

  return {
    ...base,
    empty: false,
    partial: notifications.length > 0,
    notifications,
    binaryMediaFiles,
    windowedFiles,
    reports,
  };
}
