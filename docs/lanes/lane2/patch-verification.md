# Patch verification (L2-07)

`Judge.verifyPatch` decides whether a Remedy patch fixes the bug. It lives in `packages/judge` (`src/judge.ts`, `src/patch/`, `judgePatchedFamily` and `counterexampleSurvives` in `src/rules.ts`).

## Order of checks

Static checks run first, so a bad patch never costs a build.

| Step | Check                                                                                                                                                                                                         | Fails with                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1    | Patch exhibit parses, belongs to this case, is authored by `remedy`, `sha256` is the SHA-256 of `diff`, `code` equals `diff`, diff within `maxSourceBytes`; witness parses and fits the case                  | `schema`                                                                                 |
| 2    | Diff is a plain unified diff of text files with safe paths (see below), and the declared `filesTouched` and `linesChanged` equal what the diff contains                                                       | `schema`                                                                                 |
| 3    | Added plus removed lines at most `maxPatchLinesChanged` (100), files at most `maxPatchFiles` (5)                                                                                                              | `diff-too-large`                                                                         |
| 4    | The patch does not weaken the target's test suite (see "Suite guard")                                                                                                                                         | `suite-fails`                                                                            |
| 5    | No added code line special-cases a witness value or loads one of the patch's test files (see below)                                                                                                           | `literal-only-patch`                                                                     |
| 6    | `PatchWorkbench.prepare` applies the patch to the vulnerable commit and builds it                                                                                                                             | `schema` if it does not apply, `suite-fails` if it does not build                        |
| 7    | The witness family reruns 3 times on `vulnerable` (must pass on every parameter) and 3 times on `patched` (must fail on every parameter)                                                                      | the first of `completes`, `stable-3of3`, `no-egress`, `time-budget`, else `differential` |
| 8    | The target's own test suite passes on the patch                                                                                                                                                               | `suite-fails`                                                                            |
| 9    | Every counterexample is first judged for admissibility (3 runs on `vulnerable`, 3 on `safe` when it exists, every rule of evidence); each admissible one reruns 3 times on `patched` and must fail everywhere | `counterexample-survives`                                                                |
| 10   | Discovery re-scan of the patched tree (`RescanPort`, Lane 1) is clean                                                                                                                                         | `rescanClean: false` (no rule of its own in contracts v1.0)                              |

Once the patch is built, steps 7 to 10 all run, so an appeal gets the whole picture. `rejectedBy` names the first failure in table order. When a check never ran, its flag is `false`. The patched target is released exactly once, also when a run throws.

The caps in step 3 are configuration, not measurements. Tune them once real Remedy patches exist.

## Ids

The Judge mints every id in a `VerifyResult` and never echoes a submitted one. The patch id is `exhibit-patch-` plus the first 24 hex digits of the SHA-256 of canonical JSON `{caseId, diff, kind: "patch"}`, the same recipe Lane 3 uses; counterexample ids are `counterexampleExhibitId(counterexample, witness.params)`, as in `runCounterexample`. An exhibit too malformed to read gets the `exhibit-<kind>-invalid-<24 hex>` fallback. Recipes and test vectors: `rules-of-evidence.md`, "Exhibit ids".

## Counterexamples

Lead decision (2026-11-15, flagged on PR #17): a counterexample counts against a patch only when it is admissible evidence. Before it can defeat a patch it reruns on `vulnerable`, and on `safe` when the case has one, under every rule of evidence (exactly what `runCounterexample` does). Only an admissible counterexample is rerun on `patched`; there it survives unless its runs are clean and every parameter fails.

What is reported for each submitted counterexample:

| Counterexample                                                                     | `survived`                                          |
| ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| Malformed, another case, wrong kind, or over `maxSourceBytes`                      | `false` (not used)                                  |
| Readable but inadmissible (for example it also passes on `safe`, or is unstable)   | `false` (not used)                                  |
| Admissible, and fails every parameter on `patched` with clean runs                 | `false`                                             |
| Admissible, and passes any parameter on `patched`, or its patched runs are unclean | `true`                                              |
| Readable, but the patch was refused before any counterexample ran                  | `true` (nothing was shown against it, so it stands) |

The reasoning: a counterexample that also passes on the safe variant, or that never completes on the vulnerable commit, proves nothing about the bug, so it cannot be allowed to block a correct fix. The trade-off is that a malformed counterexample from Prosecution is silently not used; Prosecution sees `survived: false` and the counterexample's own `runCounterexample` result says why.

## Diff rules

The Judge counts from the diff itself and never trusts what the author declared. Refused: binary patches, renames and copies, mode changes, symlinks and submodules, a file appearing twice, absolute paths, `.` or `..` segments, anything under `.git`, quoted or unusual path characters, hunks whose line counts disagree with their header, and any trailing text that is not part of a hunk.

## Test files

A test file is a file under a test root (`test/`, `tests/`, `__tests__/`, `spec/`) at the repository root or at a package root (`packages/<name>/`, `apps/<name>/`, `libs/<name>/`, `modules/<name>/`, `services/<name>/`). Nothing else counts: a `guard.test.js` next to the code, or a `test/` folder deep inside `src/`, is code and held to every rule. The narrow definition fails closed.

Test files get two exemptions, and both are fenced:

- The literal check skips their added lines, so a regression test may replay the payload.
- The workbench builds the target the witness and the counterexamples run against from the patch without its test files (`PatchPlan.code`). The suite runs on the whole patch (`PatchPlan.full`). So code that loads a file from the patch's test files sees nothing at run time, and the family rerun does not flip.

On top of that, step 5 rejects any non-test added line that names one of the patch's test files: its path, its file name, or its name without the last extension as the last segment of a string (`require('./guard.test.js')`, `require('../test/guard.test')`), or any relative path into a test root (`require('../test')`).

## Suite guard

A patch may add tests, never take them away. Step 4 refuses, with `suite-fails` and before any build:

- deleting a test file, or removing any line from an existing test file (an edit counts as a removal);
- adding a line to a test file that skips or narrows the suite (`.only`, `.skip`, `.todo`, `xit`, `fdescribe` and the like);
- removing a test or CI script (`test`, `pretest`, `posttest`, `test:*`, `ci`, `check`, `coverage`, `spec`) or the `scripts` key from a `package.json`;
- deleting, or removing lines from, a test runner config (`.mocharc*`, `.nycrc*`, `jest.config.*`, `vitest.config.*`, `karma.conf.*`, `mocha.config.*`, `Gruntfile.*`, `gulpfile.*`).

Dependency bumps in `package.json` stay allowed.

## `literal-only-patch`

The plan rejects a patch "whose only change is special-casing a literal value from the witness's parameters". "Only" cannot be checked statically against an author who pads the patch with an unrelated hunk, so the Judge is stricter: any added code line that special-cases a witness value rejects the patch. A real fix does not need the exploit's own payload.

Comment text is stripped before the check, never the whole line: complete `/* ... */` spans anywhere (string-aware, and a span holding a quote or backtick is kept, since the line may continue a string from an earlier line), and a `//` or `# ` comment only when it starts the line. So `/**/ if (id === "1'--") return;` and `*/ if (threshold === 3)` are both caught.

Counted as special-casing, on added lines outside test files:

- a string literal equal to a parameter string or object key (2 characters or more), or containing one or contained in one when the shorter side has 4 or more;
- remaining code containing a parameter string of 4 characters or more (regex literals, template strings);
- a numeric literal equal to a parameter number, compared for equality (`===`, `!==`, `==`, `!=`) or used as a `case` label, unless the other side is a `.length` or `.size`. The literal is read with its own sign and in any notation `Number()` reads, quoted or not: for parameter `37`, `37`, `'37'`, `37.0`, `0x25` and `3_7` all count; for parameter `1`, `-1` does not, so `indexOf(id) === -1` is accepted;
- an array literal holding a parameter number used with `.includes`, `.indexOf` or `.lastIndexOf`, or wrapped in `new Set(...)` (`[1, 2, 3].includes(+t)`);
- a reference to one of the patch's test files (see "Test files").

Known gaps (the family rerun in step 7 is the dynamic half of the same rule, and catches a patch that only blocks some parameters):

- range equality such as `t >= 3 && t <= 3`, or `Math.abs(t - 3) < 1`;
- a number or payload built at run time from pieces (`'1' + "'--"`, `30 + 7`), or held in a variable or array declared on another line;
- membership through a structure other than an inline array literal (an object map, a `switch` on a computed key);
- a `/` the regex-literal heuristic misreads can keep a real comment as code (a false positive, never a miss).

## Workbench contract

`PatchWorkbench` (`src/patch/workbench.ts`) is scripted in tests until boot recipes (L2-04) land. The real workbench must:

- apply the diff with `git apply` inside the jail, never with `--unsafe-paths`, and keep git's default refusal to write through a symlink already in the tree: a path beyond a symlink in the vulnerable commit is an `apply` failure (`schema`);
- write `workspacePath` only from that jailed apply step: the host never writes into it, and nothing later (build, suite, witness, target) gets a writable handle to it;
- take the suite command from the case's boot recipe, never from the patched manifest, and always run the vulnerable commit's own test files (the patch may only add to them; step 4 has refused deletions and removed lines);
- build the witness and counterexample target from `PatchPlan.code` and run the suite on `PatchPlan.full`. `PatchPlan.code` may have no files, when the patch only adds tests; the target is then the vulnerable commit rebuilt as is. `renderDiff` turns either plan back into text for `git apply`.

## What is real and what is scripted

- Real: everything in the Judge, and the family and counterexample reruns through `JailExecutor` on gVisor. `pnpm --filter @affidavit/judge test:sandbox-host` runs `verifyPatch` against stub targets in the jail: a correct fix flips the whole family, a fix that blocks one payload does not, and only an admissible counterexample is used against the patch. The counterexample test was added on 2026-11-15 and has not been run on a sandbox host yet.
- Scripted until later tasks: `PatchWorkbench` (applying the diff, building and booting the patched target, running its suite) needs boot recipes (L2-04). The re-scan uses `FakeRescan` until Lane 1 provides `RescanPort`.
- The gate patch in tests (`GATE_PATCH_DIFF` in `src/test-helpers.ts`) is hand-written against the case file's candidate; it is not yet applied to a real NodeGoat checkout.

## Results from real runs

- [metric] until the gate case runs end to end on the sandbox host.
