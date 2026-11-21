import type { CaseFile, PatchExhibit, TargetRef } from '@affidavit/contracts';
import type { ParsedDiff } from './diff.js';

/**
 * What the workbench is asked to build. The Judge has already parsed the diff (every section
 * headed `diff --git a/P b/P` with exactly `a/P` and `b/P` names), checked its paths and size,
 * and refused any patch that touches what the suite runs (`findSuiteTampering`).
 */
export interface PatchPlan {
  /** The whole patch, test files included. The re-scan workspace is the vulnerable commit plus this. */
  full: ParsedDiff;
  /**
   * The patch with every test file removed (`isTestFile`). The one patched build: the witness
   * family, the counterexamples and the target's own test suite all run against the vulnerable
   * commit plus this, so app code cannot tell a suite run from a witness run by its tree. May have
   * no files, when the patch only adds tests; the target is then the vulnerable commit rebuilt.
   */
  code: ParsedDiff;
  /** Only the patch's test files. Run, if at all, as the extra added-tests check. */
  tests: ParsedDiff;
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
   * `apply`: the patch does not apply cleanly to the vulnerable commit, or git would write other
   * paths or line counts than the Judge read (`numstatMismatch`); the Judge records `schema`.
   * `suite`: the applied tree changes what the suite runs (`suiteManifestChange` on a
   * `package.json`); `suite-fails`. `build`: it applied but the target no longer builds or boots;
   * `suite-fails`.
   */
  | { ok: false; stage: 'apply' | 'suite' | 'build'; detail: string };

/** One line of `git apply --numstat`: lines added, lines removed, path. */
export interface NumstatEntry {
  added: number;
  removed: number;
  path: string;
}

/** Parses `git apply --numstat` output. Binary entries (`-`) and odd lines are refused. */
export function parseNumstat(out: string): NumstatEntry[] | null {
  const entries: NumstatEntry[] = [];
  for (const line of out.split('\n')) {
    if (line === '') continue;
    const m = /^(\d+)\t(\d+)\t(.+)$/.exec(line);
    if (m === null) return null;
    entries.push({ added: Number(m[1]), removed: Number(m[2]), path: m[3] ?? '' });
  }
  return entries;
}

/**
 * Null when `git apply --numstat` (run inside the jail, on the same text the workbench is about to
 * apply) names exactly the files and line counts the Judge parsed; otherwise why not. Any
 * disagreement between the Judge's reading of a diff and git's is an `apply` failure.
 */
export function numstatMismatch(numstat: string, diff: ParsedDiff): string | null {
  const entries = parseNumstat(numstat);
  if (entries === null) return 'git apply --numstat output is not plain text numstat';
  const want = new Map(diff.files.map((f) => [f.path, f]));
  if (entries.length !== want.size) {
    return `git would touch ${entries.length} files, the Judge read ${want.size}`;
  }
  for (const e of entries) {
    const f = want.get(e.path);
    if (f === undefined)
      return `git would touch ${JSON.stringify(e.path)}, not in the Judge's reading`;
    if (f.added.length !== e.added || f.removed.length !== e.removed) {
      return `line counts for ${e.path} differ between git and the Judge`;
    }
    want.delete(e.path);
  }
  return null;
}

/**
 * Applies a patch to the vulnerable commit, builds and boots the result, and runs the target's own
 * test suite, all inside the sandbox. The real workbench needs boot recipes (L2-04); until then
 * verifyPatch is driven by scripted workbenches in tests.
 *
 * Contract for the real workbench (patch-verification.md, "Workbench contract"):
 * - Before applying `renderDiff(plan.code)` and `renderDiff(plan.full)`, it runs
 *   `git apply --numstat` on each inside the jail and returns `apply` when `numstatMismatch`
 *   reports anything. Git and the Judge must agree on every path and line count.
 * - The diff is applied with `git apply` (default `-p1`) inside the jail, never with
 *   `--unsafe-paths`, and git's default refusal to write through a symlink already in the tree
 *   stays on: a path beyond a symlink in the vulnerable commit is an `apply` failure.
 * - After applying, every `package.json` in the tree is compared with the vulnerable commit's
 *   (`suiteManifestChange`); any difference in `scripts` or a runner block is `suite`.
 * - `workspacePath` is written only by that jailed apply step. The host never writes into it, and
 *   nothing later (build, suite, witness, target) gets a writable handle to it.
 * - There is one patched build, from `PatchPlan.code`. The witness, the counterexamples and the
 *   suite all run against it.
 * - `runSuite` runs the vulnerable commit's own suite: its test files, its `package.json` test
 *   script and its runner config (all unchanged in the code build, which has no patch test
 *   files), with the command from the case's boot recipe, never from the patched manifest.
 *   When the vulnerable commit's own suite cannot be built in the sandbox (decided from the
 *   vulnerable commit, so a patch cannot make its suite unavailable), it returns
 *   `{ unavailable: reason }` instead; the Judge reports that and rejects the patch with
 *   `suite-fails` (fail closed, lead decision 2026-11-20).
 * - `runAddedTests` runs the patch's own test files (`PatchPlan.tests`) on top of that build, in a
 *   separate run. A failure counts against the patch; a pass is never required. It returns null
 *   when the plan has no test files or the workbench does not run them.
 *
 * Implementations throw only on infrastructure failure, never because the patch is bad.
 */
export interface PatchWorkbench {
  prepare(caseFile: CaseFile, patch: PatchExhibit, plan: PatchPlan): Promise<PrepareOutcome>;
  runSuite(
    caseFile: CaseFile,
    prepared: PreparedPatch,
  ): Promise<{ passed: boolean } | { unavailable: string }>;
  runAddedTests(caseFile: CaseFile, prepared: PreparedPatch): Promise<{ passed: boolean } | null>;
  /** Stops the patched target and deletes its workspace. Called exactly once per prepared patch. */
  release(prepared: PreparedPatch): Promise<void>;
}
