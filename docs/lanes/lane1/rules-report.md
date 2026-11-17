# Own Semgrep rules: corpus regression report (L1-04)

Everything below comes from real runs. Anything not run is `[metric]`. The rules are written from scratch; no registry rule or rule text is used, and Semgrep is only ever given our own rules directory (`--config /rules`).

## Rules

All files are in `packages/discovery/rules/semgrep/`, one rule per file, each with a Semgrep test file of the same base name in `packages/discovery/rules/tests/`.

| Rule id                                      | Class     | Kind             | What it flags                                                                                                                                      |
| -------------------------------------------- | --------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `affidavit.injection.sql-concat`             | injection | pattern          | SQL text built by template interpolation or concatenation and passed to `query`, `execute`, `raw` and similar                                      |
| `affidavit.injection.sql-request-taint`      | injection | taint, one file  | `req.body`, `req.query`, `req.params`, headers or cookies reaching that SQL text without a numeric coercion                                        |
| `affidavit.injection.nosql-where-template`   | injection | pattern          | MongoDB `$where` built from a template or concatenation with a value that is not numeric (numeric coercions and literals are excluded)             |
| `affidavit.injection.nosql-operator-request` | injection | taint, one file  | a request value reaching a MongoDB filter as an object or field value (operator injection such as `{"$ne": null}`)                                 |
| `affidavit.idor.route-param-to-data-access`  | idor      | pattern, ordered | `req.params` read into a variable and later passed to a data-access call with no later comparison against `req.session.*` or `req.user.*`          |
| `affidavit.idor.request-id-to-data-access`   | idor      | pattern, ordered | the same for an id-like field (`id`, `*Id`, `*_id`) read from `req.body` or `req.query`. Broader than the task text, needed for the benefits label |

The IDOR rules report on the statement that reads the identifier, not on the data-access call, so the finding sits where the corpus labels the source of the issue. The wrapper's SARIF carries no data-flow trace, and a taint rule would have reported on the sink call instead.

Known limits, by design: every rule sees one file at a time (NodeGoat's gate issue crosses a file boundary, so it is caught by the pattern rule at the sink, not by taint); an ownership check in middleware, a role check, or a check in the data layer is not seen, so the IDOR rules over-report; `nosql-where-template` cannot tell a constant from request data when the constant is a variable, so it flags the corpus negative control, which is what the corpus expects.

## How a run is made

- Image: `docker.io/semgrep/semgrep@sha256:cc1b68266f267878b39739373ea9985b9a78e5d64497dd875c8de100b22695ed` (Semgrep 1.184.0, from `docker/tools/tools.json`).
- Command: `AFFIDAVIT_DOCKER_TESTS=1 AFFIDAVIT_RULES_STAMP=write pnpm --filter @affidavit/discovery exec vitest run corpus-regression.docker` (PowerShell: set the two variables with `$env:` first). It needs Docker and network access to github.com.
- The test (1) runs `semgrep --test` over the rule files and their test files, (2) fetches NodeGoat at the pinned commit with the corpus fetch script (commit, tree and archive hash verified), plus the safe variant and the negative control (corpus patches applied), (3) copies each tree without its `.git`, quarantines it, and runs the rules through `runTool` (the merged wrapper: no network, read-only source, hardened flags), (4) compares the per-rule results with the corpus labels and `packages/discovery/rules/corpus-expectations.json`, and fails on any difference it cannot explain.
- Every rule change runs it: `regression-stamp.json` holds a digest of the rules, rule tests and expectations. The always-on unit test `corpus-regression.test.ts` fails when that digest no longer matches, so a rule change cannot land without a new real run.
- Matching: a finding is counted against a labeled issue when it is in the label's file and its lines overlap the label's `range`, or the label's `source` range in the source file.

## Run

| Item               | Value                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| Date               | 2026-11-17                                                                                          |
| Repo commit        | `70fa64277137a5668230b1a8478d8b09e416bd5c` (clean working tree at run time)                         |
| Rules digest       | `ceb534796da6e2c28c0d01bdbfad2f6331e3b579484dd9519c0c0ee8e0f5d468`                                  |
| NodeGoat commit    | `c5cb68a7084e4ae7dcc60e6a98768720a81841e8`                                                          |
| Semgrep image      | `docker.io/semgrep/semgrep@sha256:cc1b68266f267878b39739373ea9985b9a78e5d64497dd875c8de100b22695ed` |
| Result of the test | 3 of 3 tests passed (about 45 seconds); the comparison reported no problems                         |

### Semgrep rule tests

All 6 rules pass `semgrep --test`. Annotated cases per rule, counted from the test files:

| Rule                                         | `ruleid` (must match) | `ok` (must not match) |
| -------------------------------------------- | --------------------- | --------------------- |
| `affidavit.injection.sql-concat`             | 4                     | 6                     |
| `affidavit.injection.sql-request-taint`      | 2                     | 4                     |
| `affidavit.injection.nosql-where-template`   | 6                     | 5                     |
| `affidavit.injection.nosql-operator-request` | 2                     | 3                     |
| `affidavit.idor.route-param-to-data-access`  | 3                     | 5                     |
| `affidavit.idor.request-id-to-data-access`   | 2                     | 2                     |

### Corpus: per rule

Labels are the corpus labels as they are. The gate issue is NoSQL injection in `app/data/allocations-dao.js` lines 77 to 79 (see CR-2 in `contract-requests.md`; nothing here resolves it).

| Rule                                         | Labeled issues caught (vulnerable tree) | Negative controls flagged    | Findings in code the safe patch fixed (safe tree) | Findings in no labeled issue (vulnerable / safe / control) |
| -------------------------------------------- | --------------------------------------- | ---------------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| `affidavit.injection.sql-concat`             | none                                    | none                         | 0                                                 | 0 / 0 / 0                                                  |
| `affidavit.injection.sql-request-taint`      | none                                    | none                         | 0                                                 | 0 / 0 / 0                                                  |
| `affidavit.injection.nosql-where-template`   | `nodegoat-nosqli-allocations-where`     | `nodegoat-nc-constant-where` | 0                                                 | 0 / 0 / 0                                                  |
| `affidavit.injection.nosql-operator-request` | none                                    | none                         | 0                                                 | 0 / 0 / 0                                                  |
| `affidavit.idor.route-param-to-data-access`  | `nodegoat-idor-allocations-userid`      | none                         | 0                                                 | 0 / 0 / 0                                                  |
| `affidavit.idor.request-id-to-data-access`   | `nodegoat-idor-benefits-userid`         | none                         | 0                                                 | 0 / 0 / 0                                                  |

Labeled issues caught by no rule, both outside the three MVP classes the task names:

- `nodegoat-ssjs-contributions-eval` (server-side JavaScript injection through `eval`).
- `nodegoat-loginj-login-username` (log injection).

Both are listed as "not targeted" in `corpus-expectations.json`. Of the 5 corpus labels, 3 are caught and 2 are not targeted. The SQL rules and `nosql-operator-request` have no corpus label to catch (NodeGoat has no SQL, and its operator-injection sites are cross-file), so they are covered by their Semgrep test files only. No SQL or operator-injection corpus app exists yet, so their corpus recall is `[metric]`.

### Findings per tree

| Tree             | Findings | Where                                                                                                                                    |
| ---------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| vulnerable       | 3        | `allocations-dao.js:77-79` (NoSQL), `routes/allocations.js:16-18` (IDOR), `routes/benefits.js:30-33` (IDOR)                              |
| safe             | 2        | the two IDOR findings. The NoSQL finding is gone, so the rule passes the differential check on the fixed site                            |
| negative control | 3        | the two IDOR findings and `allocations-dao.js:115-117` (the constant `$where`), which the corpus says `nosql-where-template` should flag |

The safe variant fixes only the gate issue, so the IDOR findings staying on the safe tree is the expected result.

### Semgrep notifications (partial runs)

Every run on every tree reported the same 4 notifications, all in vendored third-party files under `app/assets/vendor/`: a parse error in `chart/morris-0.4.3.min.js` and timeouts of three rules on `jquery.min.js`. The wrapper marks such a run `partial`, and the rules were deliberately not given a path exclusion for vendored or minified files, because a repo could hide code in a directory with such a name. The regression allows notifications only under `app/assets/vendor/` (listed in the expectations) and fails on any other. The timeouts depend on machine speed, so a faster or slower machine may report fewer or more; whether the regression should stay this tolerant is an open question for the Lead.

## Not measured

- Recall and false-positive rates on anything but NodeGoat: `[metric]`.
- Run time per rule: `[metric]` (only the whole test, about 45 seconds including the three fetches, was observed).
- Behavior on non-JavaScript repos: `[metric]`; the rules target JavaScript and TypeScript only.
