import type { ToolRunnerPort } from '@affidavit/contracts';
import { buildInvocation, type ToolRunOptions } from './invocations.js';
import { isOkExit, type ToolManifest, type ToolName } from './manifest.js';
import { assertSnapshotClean, prepareScratch } from './quarantine.js';

export interface ToolRunResult {
  name: ToolName;
  exitCode: number;
  /** True when the exit code is one the manifest lists as a normal result for this tool. */
  ok: boolean;
  outputPath: string;
  /** File written under the mounted output directory. */
  outputFile: string;
}

/**
 * Runs one tool through the port. Fails closed: refuses a snapshot that still holds tool-control
 * paths (quarantine it first) and a scratch directory that is not new and empty.
 */
export async function runTool(
  runner: ToolRunnerPort,
  manifest: ToolManifest,
  name: ToolName,
  options: ToolRunOptions,
): Promise<ToolRunResult> {
  const inv = buildInvocation(manifest, name, options);
  await assertSnapshotClean(options.sourceDir);
  await prepareScratch(options.scratchDir, inv.scratchSubdirs);
  const res = await runner.run(inv.image, inv.args, inv.mounts);
  return {
    name,
    exitCode: res.exitCode,
    ok: isOkExit(manifest, name, res.exitCode),
    outputPath: res.outputPath,
    outputFile: inv.outputFile,
  };
}
