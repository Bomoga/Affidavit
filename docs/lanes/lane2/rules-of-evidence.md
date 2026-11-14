# Rules of evidence (L2-06)

Code: `packages/judge/src/rules.ts` (the rules, pure), `judge.ts` (the `JudgePort` implementation), `artifact.ts` (the result artifact the runner writes), `executor.ts` (the port to the jail).

## How a witness is judged

1. The Judge validates the witness (or counterexample) and the case file. A malformed exhibit, an exhibit for another case, a witness whose vulnerability class differs from the candidate's, a source or parameter space over its size limit, a family larger than `maxFamilySize`, or input too deeply nested or cyclic to read is rejected by `schema` without running anything. A malformed case file or a bad variant list is a caller bug and throws.
2. It runs three attempts on `vulnerable`, then three on `safe` when the case file has a safe variant. The safe variant always runs when it exists, whatever variants the caller passed, so differential proof cannot be skipped (F2). Attempts run one at a time.
3. Each attempt runs the whole family and leaves a result artifact with one pass or fail per parameter combination. The Judge reads it as untrusted bytes: a size cap first, then JSON, then an exact shape check. It never evaluates it.
4. The rules below are applied in order and the first one that fails is recorded in `rejectedBy`.

| Order | Rule | Fails when |
| --- | --- | --- |
| 1 | `schema` | The exhibit is malformed, or any result artifact is oversized, not JSON, has extra keys, or does not report every parameter exactly once |
| 2 | `completes` | Any attempt timed out, was OOM-killed, never exited, or exited without writing an artifact |
| 3 | `stable-3of3` | On either variant, the three attempts disagree on any parameter |
| 4 | `no-egress` | Any attempt recorded an egress attempt |
| 5 | `time-budget` | Any completed attempt took longer than `timeBudgetMs` (a soft budget below the hard kill timeout) |
| 6 | `differential` | Some parameter did not pass on `vulnerable`, or, with a safe variant, some parameter did not fail on `safe` |

Patch rules (`literal-only-patch`, `diff-too-large`, `suite-fails`, `counterexample-survives`) belong to `verifyPatch`, task L2-07.

## Semantics other lanes rely on

- **A family passes only as a whole.** An attempt passes when every parameter passed. A witness with one non-exploiting parameter is rejected by `differential`. Authors should keep the parameter space to inputs that all exploit the bug.
- **`vulnPass` is only credited to evidence that got as far as `differential`.** A witness rejected by an earlier rule reports `vulnPass: false` even if its runs passed.
- **`safeVariantFail` is absent when no safe variant was run.** An admitted witness without it rests on the vulnerable runs alone, and the trial must lean on the Prosecution counterexample (plan.md, F2 risk row).
- **`familyResults`** are reported once evidence reaches `differential`, from vulnerable attempt 1 (all three are equal by then).
- **Exhibit ids are minted by the Judge.** A witness gets `exhibit-witness-<24 hex>` from a SHA-256 over canonical JSON of its template and parameter space, so the same witness always gets the same id. A counterexample keeps its own `Exhibit.id`.
- **Counterexamples** run under the same rules as witnesses, over the witness's parameter space.
- **stdout and stderr are hashed, never stored** in the result.
- **A run that never exited** is recorded with exit code `-1`.
- **Executor failures throw.** An infrastructure failure is never turned into a rejection that blames the witness. The same goes for an executor that returns nonsense (a NaN or negative egress count, a negative duration): the Judge throws instead of judging, so an executor bug cannot slip a witness past `no-egress`.

## Result artifact format

The runner side is L2-05. The format is fixed here so both sides agree:

```json
{ "schemaVersion": 1, "results": [{ "paramIndex": 0, "passed": true }] }
```

`paramIndex` indexes the cartesian product of the `ParamSpace` in order, with the last parameter varying fastest. There is exactly one entry per index. Default size cap: 64 KiB.

## Policy defaults

These are configuration placeholders, not measurements. Tune them per corpus app once real runs exist.

| Setting | Default |
| --- | --- |
| `hardTimeoutMs` | 120000 |
| `timeBudgetMs` | 60000 |
| `maxArtifactBytes` | 65536 |
| `maxFamilySize` | 64 |
| `maxSourceBytes` | 262144 |
| `maxParamsBytes` | 65536 |

## Open questions for the contracts owner

1. `Witness.sha256` is documented as a hash of the "canonical template plus params", but the canonical form is not defined. The Judge does not check it yet. It could check it against `canonicalJson` from this package, if Lane 3 hashes the same way.
2. The `fixtures/exhibit-results/rejected-*.json` files show three clean passing runs for every rule, which is not what the Judge would produce (for example, a `completes` rejection always has a run that did not complete). The table tests compare only the fields a rule decides. Once the Judge is integrated, these fixtures could be regenerated from its output; that changes what Lane 3's fakes see, so it needs a heads-up first.
3. `ExhibitResult` has no field for why a rule failed (for example, the artifact parse error). A short `rejectionDetail` string would help Defense retry and help human review. That would be an additive contract change.
