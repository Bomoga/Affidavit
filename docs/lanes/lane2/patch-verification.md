# Patch verification (L2-07)

`Judge.verifyPatch` decides whether a Remedy patch fixes the bug. It lives in `packages/judge` (`src/judge.ts`, `src/patch/`, `judgePatchedFamily` and `counterexampleSurvives` in `src/rules.ts`).

## Order of checks

Static checks run first, so a bad patch never costs a build.

| Step | Check                                                                                                                                                                                                         | Fails with                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1    | Patch exhibit parses, belongs to this case, is authored by `remedy`, `sha256` is the SHA-256 of `diff`, `code` equals `diff`, diff within `maxSourceBytes`; witness parses and fits the case                  | `schema`                                                                                 |
| 1b   | Every counterexample that parses as an Exhibit carries a readable params header (see "Counterexample params header"); a missing or bad header refuses the whole patch                                         | `schema`                                                                                 |
| 2    | Diff is a plain git diff of text files with safe paths and exact file names, no line over 2000 characters (see below), and the declared `filesTouched` and `linesChanged` equal what the diff contains        | `schema`                                                                                 |
| 3    | Added plus removed lines at most `maxPatchLinesChanged` (100), files at most `maxPatchFiles` (5)                                                                                                              | `diff-too-large`                                                                         |
| 4    | The patch does not weaken the target's test suite (see "Suite guard")                                                                                                                                         | `suite-fails`                                                                            |
| 5    | No added code line special-cases a witness value or an admitted counterexample value or loads one of the patch's test files (see below)                                                                       | `literal-only-patch`                                                                     |
| 6    | `PatchWorkbench.prepare` checks git reads the same files and line counts, applies the patch to the vulnerable commit, checks every `package.json` keeps its suite keys, and builds it                         | `schema` if it does not apply or git disagrees, `suite-fails` otherwise                  |
| 7    | The witness family reruns 3 times on `vulnerable` (must pass on every parameter) and 3 times on `patched` (must fail on every parameter)                                                                      | the first of `completes`, `stable-3of3`, `no-egress`, `time-budget`, else `differential` |
| 8    | The vulnerable commit's own test suite passes on the patched build the witness ran against; the patch's own tests, if run, do not fail                                                                        | `suite-fails`                                                                            |
| 9    | Every counterexample is first judged for admissibility (3 runs on `vulnerable`, 3 on `safe` when it exists, every rule of evidence); each admissible one reruns 3 times on `patched` and must fail everywhere | `counterexample-survives`                                                                |
| 10   | Discovery re-scan of the patched tree (`RescanPort`, Lane 1) is clean                                                                                                                                         | `rescanClean: false` (no rule of its own in contracts v1.0)                              |

Once the patch is built, steps 7 to 10 all run, so an appeal gets the whole picture. `rejectedBy` names the first failure in table order. When a check never ran, its flag is `false`. The patched target is released exactly once, also when a run throws.

The caps in step 3 are configuration, not measurements. Tune them once real Remedy patches exist.

## Ids

The Judge mints every id in a `VerifyResult` and never echoes a submitted one. The patch id is `exhibit-patch-` plus the first 24 hex digits of the SHA-256 of canonical JSON `{caseId, diff, kind: "patch"}`, the same recipe Lane 3 uses; counterexample ids are `counterexampleExhibitId(counterexample, headerParams)`, where `headerParams` is the parameter space in the counterexample's own header (CR-T8). That is the id Prosecution computed (`packages/trial/src/counterexample.ts`, `counterexampleExhibitId`), so Remedy's exact-id check matches. The result has exactly one entry per submitted counterexample, in submission order, also when the patch is refused early. An exhibit too malformed to read gets the `exhibit-<kind>-invalid-<24 hex>` fallback. Recipes and test vectors: `rules-of-evidence.md`, "Exhibit ids".

## Counterexample params header (CR-T8)

Lead decision (2026-11-20): CR-T8 is resolved inside Lane 2, with no contract change. A Prosecution counterexample is the family template run over a parameter space Prosecution chose (a subset of the Defense values, or new values of a declared parameter). Lane 3 writes that space as the first line of the code:

```
// affidavit counterexample params: <canonical JSON ParamSpace, U+2028 and U+2029 escaped>
<family template>
```

`verifyPatch` reads it with `readCounterexampleParams` (`packages/judge/src/counterexample.ts`) and runs the counterexample over that space on `vulnerable`, `safe` and `patched`, never over the witness's family. The header is accepted only when:

1. it is the first line, starts with the prefix above, and code follows it after a newline (`\n`);
2. the JSON parses as the contract `ParamSpace`, with no `__proto__` key at any depth;
3. the line is byte for byte what `counterexampleParamsHeader` writes for that space (canonical JSON, separators escaped), so one space has one header and one id;
4. the parameter names are the witness family's, in the family's order (values may differ);
5. the space is within `maxFamilySize` combinations and `maxParamsBytes`.

A counterexample that parses as an Exhibit but fails any of these refuses the whole patch with `schema` before anything is built. It is never skipped into a pass. Its entry gets the `exhibit-counterexample-invalid-<24 hex>` id.

Not changed here: `runCounterexample` still runs over the witness passed with it. Lane 3 passes a carrier witness whose params equal the header, so its ids already match. A counterexample that cannot be run as submitted is a construction error, like a bad header, and refuses the whole patch with `schema` before anything is built: not a readable Exhibit, another case's `caseId`, a `kind` other than `counterexample`, or code over `maxSourceBytes` (review 2026-11-20; it used to be reported `survived: false` and the patch could still pass).

## Counterexamples

Lead decision (2026-11-15, flagged on PR #17): a counterexample counts against a patch only when it is admissible evidence. Before it can defeat a patch it reruns on `vulnerable`, and on `safe` when the case has one, under every rule of evidence (exactly what `runCounterexample` does). Only an admissible counterexample is rerun on `patched`; there it survives unless its runs are clean and every parameter fails.

What is reported for each submitted counterexample:

| Counterexample                                                                     | `survived`                                          |
| ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| Parses as an Exhibit, but its params header is missing or bad                      | patch refused with `schema`; entry `false`          |
| Malformed, another case, wrong kind, or over `maxSourceBytes`                      | `false` (not used)                                  |
| Readable but inadmissible (for example it also passes on `safe`, or is unstable)   | `false` (not used)                                  |
| Admissible, and fails every parameter on `patched` with clean runs                 | `false`                                             |
| Admissible, and passes any parameter on `patched`, or its patched runs are unclean | `true`                                              |
| Readable, but the patch was refused before any counterexample ran                  | `true` (nothing was shown against it, so it stands) |

The reasoning: a counterexample that also passes on the safe variant, or that never completes on the vulnerable commit, proves nothing about the bug, so it cannot be allowed to block a correct fix. `survived: false` is kept for evidence that ran and was ruled inadmissible; Prosecution sees it and the counterexample's own `runCounterexample` result says why. A malformed counterexample is never silently dropped: it refuses the patch with `schema`.

## Diff rules

The Judge counts from the diff itself and never trusts what the author declared. Refused: binary patches, renames and copies, mode changes, symlinks and submodules, a file appearing twice, absolute paths, `.` or `..` segments, anything under `.git`, quoted or unusual path characters, hunks whose line counts disagree with their header, any trailing text that is not part of a hunk, and any line over 2000 characters (`MAX_LINE_CHARS`; minified or generated code has no place in a fix, and the cap keeps every pattern the Judge runs on a line cheap).

### File names must be exactly what git writes

Every file section must start with `diff --git a/P b/P`, its `---` name must be exactly `a/P` or `/dev/null`, and its `+++` name exactly `b/P` or `/dev/null`. Anything else is `schema`.

The reason: `git apply` (default `-p1`) strips the first path component of whatever name it is given. An earlier reader stripped `a/` and `b/` only when present, so the Judge and git could read different files. Found in the PR #17 re-review:

| Section names                                | Earlier Judge reading        | What `git apply` does |
| -------------------------------------------- | ---------------------------- | --------------------- |
| `--- z/test/a.js`, `+++ /dev/null`           | deletes `z/test/a.js` (code) | deletes `test/a.js`   |
| `--- test/src/app.js`, `+++ test/src/app.js` | edits a test file (exempt)   | edits `src/app.js`    |

Chained, they made a fake fix pass: a code section added `if (!globalThis.__ok) deny();` (in the witness build, so every payload was refused), and a "test" section that git writes to `src/app.js` set `globalThis.__ok = true` (only in the suite's build, so the suite passed). Both builds are now one (`PatchPlan.code`), and as a second line of defence the workbench compares `git apply --numstat` with the Judge's reading (see "Workbench contract").

## Test files

A test file is a file under a test root (`test/`, `tests/`, `__tests__/`, `spec/`) at the repository root or at a package root (`packages/<name>/`, `apps/<name>/`, `libs/<name>/`, `modules/<name>/`, `services/<name>/`). Nothing else counts: a `guard.test.js` next to the code, or a `test/` folder deep inside `src/`, is code and held to every rule. The narrow definition fails closed.

Test files get two exemptions, and both are fenced:

- The literal check skips their added lines, so a regression test may replay the payload.
- The workbench makes one patched build, from the patch without its test files (`PatchPlan.code`). The witness, the counterexamples and the vulnerable commit's own suite all run against it. So code that loads a file from the patch's test files sees nothing at run time, and app code cannot tell a suite run from a witness run by the files in its tree. The patch's test files (`PatchPlan.tests`) only feed the extra added-tests check (see "Suite guard").

A file that looks like a test to a runner's default discovery (`*.test.js`, `*.spec.ts`, a `__tests__`, `test`, `tests` or `spec` directory) but is not under a recognised test root is not a test file: it would be in the code build, where the vulnerable commit's runner could pick it up. A patch may not touch one at all (step 4).

On top of that, step 5 rejects any non-test added line that names one of the patch's test files: its path, its file name, or its name without the last extension as the last segment of a string (`require('./guard.test.js')`, `require('../test/guard.test')`), or any relative path into a test root (`require('../test')`).

## Suite guard

The suite that decides `suite-fails` is the vulnerable commit's own: its test files, its `package.json` test script and its runner config, run on the same patched build as the witness. A patch may therefore not change anything that decides what that suite runs. Step 4 refuses, with `suite-fails` and before any build:

- deleting a test file, removing any line from one (an edit counts as a removal), or adding a line to one that skips, narrows or cuts short the suite (`.only`, `.skip`, `.todo`, `xit`, `fdescribe`, a runtime `this.skip()`, `process.exit`, `process.kill`);
- adding, deleting or changing any test runner or coverage config file, in any name and format the runners read (`RUNNER_CONFIG`): `.mocharc*`, `mocha.opts`, `.nycrc*`, `.c8rc*`, `.taprc`, `jest.config.*`, `vitest.config.*`, `vite.config.*`, `karma.conf.*`, `ava.config.*`, `cypress.config.*`, `playwright.config.*`, `jasmine.json`, `Gruntfile.*`, `gulpfile.*`, with `.js`, `.cjs`, `.mjs`, `.ts`, `.json`, `.yml`, `.yaml` and other variants. A config inside a test root (`spec/support/jasmine.json`) is still a config;
- any change to `scripts`, `config`, or a runner block (`jest`, `mocha`, `nyc`, `c8`, `ava`, `jasmine`, `tap`, `vitest`, `karma`, `cypress`, `playwright`) in a `package.json`, and adding or deleting a `package.json`. The diff shows only a window of the file, so this pass catches changed lines that name one of those keys or a suite script (`test`, `pretest`, `test:*`, `ci`, `coverage`, `spec`), and changed lines inside one of those blocks when its opening line is in the hunk. The workbench makes the exact check on the applied files (`suiteManifestChange`, see "Workbench contract");
- touching a test-like file outside a test root (see "Test files").

Dependency bumps in `package.json` stay allowed.

The patch's own test files are an extra check, never a requirement. If the workbench runs them (`runAddedTests`, on top of the patched build), a failure counts as `suite-fails`; a pass, or not running them, changes nothing.

Bypasses from the PR #17 re-review, each now refused with its own test: a new `test/000.js` with `process.exit(0)`; `before(function () { this.skip(); })` added to an existing test; a new `.mocharc.json` with `{"spec":"nothing/**"}`; edits to `jest.config.json`; added or edited `jest`, `mocha` or `nyc` blocks in `package.json`; an added `"pretest": "rm -rf test"`.

Known gaps: app code can still tell a suite run from a witness run by its environment (`NODE_ENV`, process arguments, the runner's globals) and behave differently; the suite verdict is only as good as the runner's exit code. The family rerun in step 7 is unaffected, because the witness runs against the booted target.

## `literal-only-patch`

The plan rejects a patch "whose only change is special-casing a literal value from the witness's parameters". "Only" cannot be checked statically against an author who pads the patch with an unrelated hunk, so the Judge is stricter: any added code line that special-cases a witness value rejects the patch. Everything below, up to the counterexample subsection, is the check on the witness family's values. A real fix does not need the exploit's own payload.

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
- a constant on another line (`const BAD = 1337;` then `if (id === BAD)`) holding a family value (a counterexample's new value is caught there, see below);
- a string split across literals or lines (`'0\' || ' + "'1'=='1"`);
- a case change before the compare (`t.toLowerCase() === 'select'` against an upper-case payload);
- a BigInt literal (`1337n`), and comparisons through a function (`Object.is(+id, 1337)`);
- membership through something other than `.includes`, `.indexOf`, `.lastIndexOf` or `new Set` on an inline array (`[1337].some((x) => x === id)`, an object-key lookup `({ 1337: 1 })[id]`);
- a JSON or other data file of payload values added by the patch and used through `.includes`;
- a `/` the regex-literal heuristic misreads can keep a real comment as code (a false positive, never a miss).

Considered and not done for the family: flagging every added numeric literal equal to a parameter number above 2, wherever it appears. It would catch the constant-on-another-line case, but parameter numbers often coincide with values a real fix uses (HTTP statuses such as `403`, limits, ports), so it would refuse correct fixes. The family rerun covers the dynamic side.

### Counterexample values

Prosecution's counterexamples can add values the family never had. Those are checked too, with a separate rule (`findExactLiteralUses`, run after the build, review 2026-11-20):

- only values of a counterexample that was admitted (passes on vulnerable, fails on safe); a counterexample that was not admitted contributes nothing;
- only values that are not already in the family's own params. A counterexample that reuses family values (an index pick, a parameter it did not choose) adds nothing here, because those values already had the family check above; giving them a second, stricter check would let Prosecution veto a correct patch (for example `rows.length !== 1` or `rows[0]` with family values `1` and `0`);
- a new string value of 4 characters or more is a hit anywhere in an added code line, including a longer string, a regex literal or a template literal: `if (p === "..%2fetc%2fpasswd") return 403;`, `const BAD = '..%2fetc%2fpasswd'; if (p === BAD)` and `/^(?:..%2fetc%2fpasswd)$/` are all rejected;
- a shorter new value, and a new number, is a hit only as a whole literal on any kind of added line (conditional, declaration, assignment, array member, `case`), never inside another literal or an identifier.

Known gaps, accepted because an admitted counterexample with a nearby value then survives the patch (`counterexample-survives`): a value split across literals (`'..%2f' + 'etc%2fpasswd'`) or built in a `${}` template, a case-insensitive pattern (`/ADMIN/i` against `admin`), a value built with `String.fromCharCode` or decoded with `atob`, and a constant array of values declared elsewhere.

Each line is at most 2000 characters (step 2), and every pattern in `literal.ts` and `diff.ts` is linear or bounded by that cap. The left-operand pattern in the number check used to restart at every position of a long run of identifier characters (quadratic: 128K characters took about 18 s in review); it now starts only where a run starts.

## Workbench contract

`PatchWorkbench` (`src/patch/workbench.ts`) is scripted in tests until boot recipes (L2-04) land. The real workbench must:

- before applying `renderDiff(plan.code)` (the build) and `renderDiff(plan.full)` (the re-scan workspace), run `git apply --numstat` on each inside the jail and return `apply` (`schema`) when `numstatMismatch` reports any path or line count that differs from the Judge's reading;
- apply with `git apply` (default `-p1`) inside the jail, never with `--unsafe-paths`, and keep git's default refusal to write through a symlink already in the tree: a path beyond a symlink in the vulnerable commit is an `apply` failure (`schema`);
- after applying, compare every `package.json` with the vulnerable commit's (`suiteManifestChange`) and return `suite` (`suite-fails`) on any difference in `scripts`, `config` or a runner block;
- write `workspacePath` only from that jailed apply step: the host never writes into it, and nothing later (build, suite, witness, target) gets a writable handle to it;
- make one patched build, from `PatchPlan.code`, and run the witness, the counterexamples and the suite against it. `PatchPlan.code` may have no files, when the patch only adds tests; the build is then the vulnerable commit rebuilt as is;
- in `runSuite`, run the vulnerable commit's own suite (its test files, test script and runner config, all unchanged in that build), with the command from the case's boot recipe, never from the patched manifest;
- in `runAddedTests`, run only `PatchPlan.tests` on top of that build, in a separate run, and return null when there are none or they are not run.

## What is real and what is scripted

- Real: everything in the Judge, and the family and counterexample reruns through `JailExecutor` on gVisor. `pnpm --filter @affidavit/judge test:sandbox-host` runs `verifyPatch` against stub targets in the jail: a correct fix flips the whole family, a fix that blocks one payload does not, and only an admissible counterexample is used against the patch. The counterexample test was added on 2026-11-15 and has not been run on a sandbox host yet.
- Scripted until later tasks: `PatchWorkbench` (applying the diff, building and booting the patched target, running its suite) needs boot recipes (L2-04). The re-scan uses `FakeRescan` until Lane 1 provides `RescanPort`.
- The gate patch in tests (`GATE_PATCH_DIFF` in `src/test-helpers.ts`) is hand-written against the case file's candidate; it is not yet applied to a real NodeGoat checkout.

## Results from real runs

- [metric] until the gate case runs end to end on the sandbox host.
