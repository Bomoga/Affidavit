import type { CaseFile, PatchExhibit, TargetRef } from '@affidavit/contracts';
import type { ParsedDiff } from './diff.js';

/** A patched target that is built and ready to run. Released by the Judge when it is done. */
export interface PreparedPatch {
  /** The vulnerable commit plus the patch; `variant` is `patched`. */
  target: TargetRef;
  /**
   * Host path of the patched source tree, handed to the discovery re-scan. Read only for the
   * re-scan; nothing the target or a witness runs can write it.
   */
  workspacePath: string;
}

export type PrepareOutcome =
  | { ok: true; prepared: PreparedPatch }
  /**
   * `apply`: the patch does not apply cleanly to the vulnerable commit (the Judge records
   * `schema`). `build`: it applied but the target no longer builds or boots (`suite-fails`).
   */
  | { ok: false; stage: 'apply' | 'build'; detail: string };

/**
 * Applies a patch to the vulnerable commit, builds and boots the result, and runs the target's own
 * test suite, all inside the sandbox. The real workbench needs boot recipes (L2-04); until then
 * verifyPatch is driven by scripted workbenches in tests. The Judge has already parsed the diff
 * and checked its paths and size before `prepare` is called.
 *
 * Implementations throw only on infrastructure failure, never because the patch is bad.
 */
export interface PatchWorkbench {
  prepare(caseFile: CaseFile, patch: PatchExhibit, diff: ParsedDiff): Promise<PrepareOutcome>;
  runSuite(caseFile: CaseFile, prepared: PreparedPatch): Promise<{ passed: boolean }>;
  /** Stops the patched target and deletes its workspace. Called exactly once per prepared patch. */
  release(prepared: PreparedPatch): Promise<void>;
}
