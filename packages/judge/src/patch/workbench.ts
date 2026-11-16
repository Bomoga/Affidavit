import type { CaseFile, PatchExhibit, TargetRef } from '@affidavit/contracts';
import type { ParsedDiff } from './diff.js';

/**
 * What the workbench is asked to build. The Judge has already parsed the diff, checked its paths
 * and size, and refused any patch that weakens the target's test suite (`findSuiteTampering`).
 */
export interface PatchPlan {
  /** The whole patch, test files included. The target's test suite runs on this. */
  full: ParsedDiff;
  /**
   * The patch with every test file removed (`isTestFile`). The witness family and the
   * counterexamples run against a target built from this, so code that loads a file from the
   * patch's own test files cannot change what they see. May have no files, when the patch only
   * adds tests; the target is then the vulnerable commit rebuilt as is.
   */
  code: ParsedDiff;
}

/** A patched target that is built and ready to run. Released by the Judge when it is done. */
export interface PreparedPatch {
  /** The vulnerable commit plus `PatchPlan.code`; `variant` is `patched`. */
  target: TargetRef;
  /**
   * Host path of the patched source tree (the vulnerable commit plus `PatchPlan.full`), handed
   * to the discovery re-scan. Written only by the jailed apply step; read only for the re-scan;
   * nothing the target, the suite or a witness runs can write it.
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
 * verifyPatch is driven by scripted workbenches in tests.
 *
 * Contract for the real workbench (patch-verification.md, "Workbench contract"):
 * - The diff is applied with `git apply` inside the jail, never with `--unsafe-paths`, and git's
 *   default refusal to write through a symlink already in the tree stays on: a path beyond a
 *   symlink in the vulnerable commit is an `apply` failure.
 * - `workspacePath` is written only by that jailed apply step. The host never writes into it, and
 *   nothing later (build, suite, witness, target) gets a writable handle to it.
 * - The suite command comes from the case's boot recipe, never from the patched manifest, and it
 *   always runs the vulnerable commit's own test files (the patch may only add to them; the Judge
 *   has already refused deletions and removed lines).
 * - The witness and counterexample target is built from `PatchPlan.code`; the suite runs on
 *   `PatchPlan.full`.
 *
 * Implementations throw only on infrastructure failure, never because the patch is bad.
 */
export interface PatchWorkbench {
  prepare(caseFile: CaseFile, patch: PatchExhibit, plan: PatchPlan): Promise<PrepareOutcome>;
  runSuite(caseFile: CaseFile, prepared: PreparedPatch): Promise<{ passed: boolean }>;
  /** Stops the patched target and deletes its workspace. Called exactly once per prepared patch. */
  release(prepared: PreparedPatch): Promise<void>;
}
