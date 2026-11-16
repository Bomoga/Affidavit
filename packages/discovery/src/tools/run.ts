import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolRunnerPort } from '@affidavit/contracts';
import { buildInvocation, type ToolRunOptions } from './invocations.js';
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

export interface ToolRunResult {
  name: ToolName;
  exitCode: number;
  /** True when the exit code is one the manifest lists as a normal result for this tool. */
  ok: boolean;
  /** True when the tool said there was nothing to scan and wrote no report (OSV-Scanner 128). */
  empty: boolean;
  outputPath: string;
  /** File written under the output directory. Verified to be a non-empty regular file unless `empty`. */
  outputFile: string;
  /** Paths quarantine removed from the snapshot. Record them as a signal on the case. */
  quarantined: readonly string[];
}

/** The tool exited normally but did not leave a regular, non-empty report where expected. */
export class ToolOutputMissingError extends Error {
  constructor(tool: string, file: string, why: string) {
    super(`${tool} did not produce a usable report at ${file}: ${why}`);
    this.name = 'ToolOutputMissingError';
  }
}

/**
 * Runs one tool through the port. Fails closed:
 * - refuses a snapshot that still holds tool-control paths (SnapshotNotCleanError),
 * - refuses scratch and output directories that are not new and empty,
 * - after the run, requires the report to be a regular, non-empty file (ToolOutputMissingError).
 *   A symlink planted at the report path is refused because lstat does not follow it.
 *
 * A non-ok exit code is returned as `ok: false`; callers must treat that as a failed scan, never as
 * "no findings".
 */
export async function runTool(
  runner: ToolRunnerPort,
  manifest: ToolManifest,
  name: ToolName,
  options: RunToolOptions,
): Promise<ToolRunResult> {
  const { snapshot, ...rest } = options;
  const inv = buildInvocation(manifest, name, { ...rest, sourceDir: snapshot.dir });
  await assertSnapshotClean(snapshot.dir);
  await prepareScratch(options.scratchDir, inv.scratchSubdirs);
  await prepareOutput(options.outputDir);
  const res = await runner.run(inv.image, inv.args, inv.mounts);
  const base = {
    name,
    exitCode: res.exitCode,
    ok: isOkExit(manifest, name, res.exitCode),
    outputPath: res.outputPath,
    outputFile: inv.outputFile,
    quarantined: snapshot.removed,
  };
  if (!base.ok) return { ...base, empty: false };
  if (isEmptyExit(manifest, name, res.exitCode)) return { ...base, empty: true };

  const file = join(options.outputDir, inv.outputFile);
  let st;
  try {
    st = await lstat(file);
  } catch {
    throw new ToolOutputMissingError(name, file, 'file does not exist');
  }
  if (!st.isFile()) throw new ToolOutputMissingError(name, file, 'not a regular file');
  if (st.size === 0) throw new ToolOutputMissingError(name, file, 'file is empty');
  return { ...base, empty: false };
}
