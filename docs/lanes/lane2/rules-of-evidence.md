# Rules of evidence (L2-06)

Code: `packages/judge/src/rules.ts` (the rules, pure), `judge.ts` (the `JudgePort` implementation), `artifact.ts` (the result artifact the runner writes), `executor.ts` (the port to the jail), `jail/` (the real executor, L2-03; see `witness-jail.md`).

## How a witness is judged

1. The Judge validates the witness (or counterexample) and the case file. A malformed exhibit, an exhibit for another case, a witness whose vulnerability class differs from the candidate's, a source or parameter space over its size limit, a family larger than `maxFamilySize`, or input too deeply nested or cyclic to read is rejected by `schema` without running anything. A malformed case file or a bad variant list is a caller bug and throws.
2. It runs three attempts on `vulnerable`, then three on `safe` when the case file has a safe variant. The safe variant always runs when it exists, whatever variants the caller passed, so differential proof cannot be skipped (F2). Attempts run one at a time.
3. Each attempt runs the whole family and leaves a result artifact with one pass or fail per parameter combination. The Judge reads it as untrusted bytes: a size cap first, then JSON, then an exact shape check. It never evaluates it.
4. The rules below are applied in order and the first one that fails is recorded in `rejectedBy`.

| Order | Rule           | Fails when                                                                                                                               |
| ----- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `schema`       | The exhibit is malformed, or any result artifact is oversized, not JSON, has extra keys, or does not report every parameter exactly once |
| 2     | `completes`    | Any attempt timed out, was OOM-killed, never exited, or exited without writing an artifact                                               |
| 3     | `stable-3of3`  | On either variant, the three attempts disagree on any parameter                                                                          |
| 4     | `no-egress`    | Any attempt recorded an egress attempt, or its syscall trace was tampered with (so the absence of egress cannot be shown)                |
| 5     | `time-budget`  | Any completed attempt took longer than `timeBudgetMs` (a soft budget below the hard kill timeout)                                        |
| 6     | `differential` | Some parameter did not pass on `vulnerable`, or, with a safe variant, some parameter did not fail on `safe`                              |

Patch rules (`literal-only-patch`, `diff-too-large`, `suite-fails`, `counterexample-survives`) belong to `verifyPatch`, task L2-07; see `patch-verification.md`.

## Semantics other lanes rely on

- **A family passes only as a whole.** An attempt passes when every parameter passed. A witness with one non-exploiting parameter is rejected by `differential`. Authors should keep the parameter space to inputs that all exploit the bug.
- **`vulnPass` is only credited to evidence that got as far as `differential`.** A witness rejected by an earlier rule reports `vulnPass: false` even if its runs passed.
- **`safeVariantFail` is absent when no safe variant was run.** An admitted witness without it rests on the vulnerable runs alone, and the trial must lean on the Prosecution counterexample (plan.md, F2 risk row).
- **`familyResults`** are reported once evidence reaches `differential`, from vulnerable attempt 1 (all three are equal by then).
- **Exhibit ids are minted by the Judge**, for witnesses and counterexamples alike, from the exhibit's case, code and parameter space, and for patches from the case and diff (see "Exhibit ids" below). The submitted `Witness.id` and `Exhibit.id` are never echoed back, in `runWitness`, `runCounterexample` or `verifyPatch`.
- **Counterexamples** run under the same rules as witnesses, over the witness's parameter space (in `verifyPatch`, over the params in their header), on `vulnerable` and (when it exists) `safe`.
- **What `admissible` and `passed` mean for a counterexample.** `admissible` means the counterexample is usable evidence: it passed every rule above, so the whole family passes on `vulnerable` and, when a safe variant exists, fails on `safe`. `passed` always equals `admissible`. Neither says anything about a patch. Whether a counterexample defeats a patch is `VerifyResult.counterexamples[].survived`, decided by `verifyPatch` (L2-07), which reruns only admissible counterexamples. An inadmissible counterexample cannot be used against a patch.
- **The vulnerable and safe variants are indistinguishable to the witness.** The executor boots the variant it is asked for, but the witness never learns which one it is talking to: both are reached at the same internal hostname and port, with the same environment variables, mounts, parameters and limits. The variant name and the target ref stay outside the jail. A witness that could tell the variants apart could pass the differential rule by branching on the variant instead of exploiting the bug, so any executor that leaks the variant (a different hostname, an env var, a label visible inside the jail) is a bug.
- **stdout and stderr are hashed, never stored** in the result. The executor caps each stream at `maxOutputBytes` while the run goes; output over the cap means the executor did not, and the Judge throws instead of judging.
- **A run that never exited** is recorded with exit code `-1`.
- **Executor failures throw.** An infrastructure failure is never turned into a rejection that blames the witness. The same goes for an executor that returns nonsense (a NaN or negative egress count, a negative duration): the Judge throws instead of judging, so an executor bug cannot slip a witness past `no-egress`.

## Exhibit ids

Lane 3 needs these ids (to match an `ExhibitResult` to the exhibit it submitted, and to name a counterexample in an appeal) without importing `@affidavit/judge`. The recipe is part of the contract:

1. Build an object with exactly four keys:
   - `caseId`: `Witness.caseId`, or `Exhibit.caseId` for a counterexample.
   - `kind`: `"witness"` or `"counterexample"`.
   - `params`: the `ParamSpace` the exhibit runs over. For a witness, `Witness.params`. For a counterexample, the `params` of the witness passed to `runCounterexample` alongside it; in `verifyPatch`, the params in the counterexample's own header line (CR-T8, see `patch-verification.md`).
   - `template`: `Witness.template`, or `Exhibit.code` for a counterexample.
2. Serialize it as canonical JSON: no whitespace, object keys sorted by UTF-16 code unit order (JavaScript's default `Array.prototype.sort`) at every level, array order kept, strings and numbers exactly as `JSON.stringify` writes them.
3. Take the SHA-256 of the UTF-8 bytes, in lowercase hex.
4. The id is `exhibit-<kind>-<first 24 hex digits>`.

`Witness.sha256` and `Exhibit.sha256` are not inputs. The Judge does not trust a hash the caller computed, so the id is derived only from the fields that decide what runs.

Test vectors (asserted in `judge.test.ts`), for `caseId: "case-x"`, `template` or `code` `"t"`, and `params: [{"name":"p","values":[1]}]`:

| Kind           | Canonical JSON                                                                                    | Id                                                |
| -------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| witness        | `{"caseId":"case-x","kind":"witness","params":[{"name":"p","values":[1]}],"template":"t"}`        | `exhibit-witness-065ed82f887fd688aef7d3a3`        |
| counterexample | `{"caseId":"case-x","kind":"counterexample","params":[{"name":"p","values":[1]}],"template":"t"}` | `exhibit-counterexample-acffdfb8b1fadd693641b6d2` |

Because `caseId` is an input, the same code submitted to two cases gets two ids, and a witness and a counterexample with the same code and family never share an id. An exhibit too malformed to read its fields gets `exhibit-<kind>-invalid-<24 hex>`, hashed from the raw input, and is always rejected by `schema`.

### Patch exhibit ids

`verifyPatch` (L2-07) mints the patch id the same way, and never echoes `PatchExhibit.id`. Lane 3 builds the PatchExhibit with the same recipe (`packages/trial/src/patch.ts`):

1. Build an object with exactly three keys: `caseId` (`PatchExhibit.caseId`), `diff` (`PatchExhibit.diff`) and `kind: "patch"`.
2. Serialize it as canonical JSON, as above.
3. Take the SHA-256 of the UTF-8 bytes, in lowercase hex.
4. The id is `exhibit-patch-<first 24 hex digits>`.

The Judge also refuses a patch with `schema` when `PatchExhibit.sha256` is not the SHA-256 of `diff`, or when `PatchExhibit.code` is not exactly `diff`, so the fields cannot describe two different patches.

Test vector (asserted in `verify.test.ts`), for `caseId: "case-x"` and `diff: "d"`:

| Canonical JSON                                  | Id                                       |
| ----------------------------------------------- | ---------------------------------------- |
| `{"caseId":"case-x","diff":"d","kind":"patch"}` | `exhibit-patch-4252faa67f9f45500b6a7ce8` |

## Result artifact format

The runner side is `docker/sandbox/witness-runner/run.mjs` (L2-05, `witness-protocol.md`). The format is fixed here so both sides agree:

```json
{ "schemaVersion": 1, "results": [{ "paramIndex": 0, "passed": true }] }
```

`paramIndex` indexes the cartesian product of the `ParamSpace` in order, with the last parameter varying fastest. There is exactly one entry per index. Default size cap: 64 KiB.

## Policy defaults

These are configuration placeholders, not measurements. Tune them per corpus app once real runs exist.

| Setting            | Default                                          |
| ------------------ | ------------------------------------------------ |
| `hardTimeoutMs`    | 120000                                           |
| `timeBudgetMs`     | 60000                                            |
| `maxArtifactBytes` | 65536                                            |
| `maxFamilySize`    | 64                                               |
| `maxSourceBytes`   | 262144                                           |
| `maxParamsBytes`   | 65536                                            |
| `maxOutputBytes`   | 1048576 (each of stdout and stderr, per attempt) |

## Open questions for the contracts owner

1. `Witness.sha256` is documented as a hash of the "canonical template plus params", but the canonical form is not defined. The Judge does not check it yet. It could check it against `canonicalJson` from this package, if Lane 3 hashes the same way.
2. The `fixtures/exhibit-results/rejected-*.json` files show three clean passing runs for every rule, which is not what the Judge would produce (for example, a `completes` rejection always has a run that did not complete). The table tests compare only the fields a rule decides. Once the Judge is integrated, these fixtures could be regenerated from its output; that changes what Lane 3's fakes see, so it needs a heads-up first.
3. `ExhibitResult` has no field for why a rule failed (for example, the artifact parse error). A short `rejectionDetail` string would help Defense retry and help human review. That would be an additive contract change.
