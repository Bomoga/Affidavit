# Patch verification (L2-07)

`Judge.verifyPatch` decides whether a Remedy patch fixes the bug. It lives in `packages/judge` (`src/judge.ts`, `src/patch/`, `judgePatchedFamily` and `counterexampleSurvives` in `src/rules.ts`).

## Order of checks

Static checks run first, so a bad patch never costs a build.

| Step | Check                                                                                                                                                   | Fails with                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1    | Patch exhibit parses, belongs to this case, is authored by `remedy`, diff within `maxSourceBytes`; witness parses and fits the case                     | `schema`                                                                                 |
| 2    | Diff is a plain unified diff of text files with safe paths (see below), and the declared `filesTouched` and `linesChanged` equal what the diff contains | `schema`                                                                                 |
| 3    | Added plus removed lines at most `maxPatchLinesChanged` (100), files at most `maxPatchFiles` (5)                                                        | `diff-too-large`                                                                         |
| 4    | No added code line special-cases a witness value (see below)                                                                                            | `literal-only-patch`                                                                     |
| 5    | `PatchWorkbench.prepare` applies the patch to the vulnerable commit and builds it                                                                       | `schema` if it does not apply, `suite-fails` if it does not build                        |
| 6    | The witness family reruns 3 times on `vulnerable` (must pass on every parameter) and 3 times on `patched` (must fail on every parameter)                | the first of `completes`, `stable-3of3`, `no-egress`, `time-budget`, else `differential` |
| 7    | The target's own test suite passes on the patch                                                                                                         | `suite-fails`                                                                            |
| 8    | Every counterexample reruns 3 times on `patched` over the witness's parameters and fails on every parameter                                             | `counterexample-survives`                                                                |
| 9    | Discovery re-scan of the patched tree (`RescanPort`, Lane 1) is clean                                                                                   | `rescanClean: false` (no rule of its own in contracts v1.0)                              |

Once the patch is built, steps 6 to 9 all run, so an appeal gets the whole picture. `rejectedBy` names the first failure in table order. When a check never ran, its flag is `false` and every counterexample is reported as surviving: nothing was shown. The patched target is released exactly once, also when a run throws.

The caps in steps 3 are configuration, not measurements. Tune them once real Remedy patches exist.

## Diff rules

The Judge counts from the diff itself and never trusts what the author declared. Refused: binary patches, renames and copies, mode changes, symlinks and submodules, a file appearing twice, absolute paths, `.` or `..` segments, anything under `.git`, quoted or unusual path characters, hunks whose line counts disagree with their header, and any trailing text that is not part of a hunk.

## `literal-only-patch`

The plan rejects a patch "whose only change is special-casing a literal value from the witness's parameters". "Only" cannot be checked statically against an author who pads the patch with an unrelated hunk, so the Judge is stricter: any added code line that special-cases a witness value rejects the patch. A real fix does not need the exploit's own payload.

Counted as special-casing, on added lines outside test files and outside comment lines:

- a string literal equal to a parameter string or object key (2 characters or more), or containing one or contained in one when the shorter side has 4 or more;
- raw code containing a parameter string of 4 characters or more (regex literals, template strings);
- a parameter number, bare or quoted, compared for equality (`===`, `!==`, `==`, `!=`) or used as a `case` label, unless the other side is a `.length` or `.size`.

Test files (`test/`, `tests/`, `__tests__/`, `spec/`, `*.test.*`, `*.spec.*`) are exempt so a regression test can replay the payload. Known gaps: a payload built at run time from pieces, or a special case placed in a file named like a test, passes this check. The family rerun in step 6 is the dynamic half of the same rule: a patch that only blocks some parameters does not flip the family.

## What is real and what is scripted

- Real: everything in the Judge, and the family and counterexample reruns through `JailExecutor` on gVisor. `pnpm --filter @affidavit/judge test:sandbox-host` runs `verifyPatch` against stub targets in the jail: a correct fix flips the whole family, and a fix that blocks one payload does not.
- Scripted until later tasks: `PatchWorkbench` (applying the diff, building and booting the patched target, running its suite) needs boot recipes (L2-04). The re-scan uses `FakeRescan` until Lane 1 provides `RescanPort`.
- The gate patch in tests (`GATE_PATCH_DIFF` in `src/test-helpers.ts`) is hand-written against the case file's candidate; it is not yet applied to a real NodeGoat checkout.

## Results from real runs

- [metric] until the gate case runs end to end on the sandbox host.
