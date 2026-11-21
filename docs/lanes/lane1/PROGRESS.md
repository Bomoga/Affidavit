# Lane 1 progress: Intake and Platform

Owner: [unassigned]
Contracts version in use: v1.0

## Tasks

| ID    | Status (todo, doing, done, blocked) | Branch or PR  | Notes                                                                                                                                                                                |
| ----- | ----------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L1-01 | blocked                             | #32 (open)    | Ingestion, after 3 fix rounds. Round 4 review found one blocker and three majors (see Blocked). Held pending lead decision on a fourth fix round.                                    |
| L1-02 | done                                | #23, #34      | Scanner images pinned by digest (#23). Discovery tools follow-ups (#34).                                                                                                             |
| L1-03 | done                                | #31           | SARIF normalizer.                                                                                                                                                                    |
| L1-04 | done                                | #33           | Own Semgrep rules and corpus regression harness. Minors follow-up is committed locally on `lane1/L1-04b-discovery-minors`, not pushed (see Blocked).                                 |
| L1-05 | blocked                             |               | Map. Blocked on L1-01.                                                                                                                                                               |
| L1-06 | blocked                             |               | Blocked on L1-01.                                                                                                                                                                    |
| L1-07 | blocked                             |               | Blocked on L1-01 and gated on CR-1, CR-2.                                                                                                                                            |
| L1-08 | done                                | #21           | Corpus manifest and loader. CR-1, CR-2 filed.                                                                                                                                        |
| L1-09 | done                                | #24, #35, #37 | Drizzle schema, forced RLS, append-only verdicts, Graphile queue, real CaseStore and EventSink. Follow-ups in #35 (L1-09b) and minors in #37 (L1-09c). Postgres tests not yet in CI. |
| L1-10 | done                                | #30           | Worker.                                                                                                                                                                              |
| L1-11 | done                                | #36           | CLI v0 with fake intake.                                                                                                                                                             |
| L1-12 | blocked                             |               | API. Gated on CR-T10 and OAuth credentials.                                                                                                                                          |
| L1-13 | blocked                             |               | Blocked on L1-01.                                                                                                                                                                    |
| L1-14 | blocked                             |               | Corpus expansion. Gated on Juice Shop and DVNA licensing.                                                                                                                            |
| L1-15 | blocked                             |               | GitHub App. Gated on App credentials.                                                                                                                                                |
| L1-16 | blocked                             |               | Blocked on L1-01.                                                                                                                                                                    |

## Blocked

- L1-01 (#32): round 4 review found one blocker and three majors. Waiting on lead decision about a fourth fix round.
  - Blocker: gitleaks snapshot findings are dropped for "fully windowed" files when a secret longer than the window overlap is cut by every window.
  - Major: the git floor still admits 2.37.7 and 2.38.5.
  - Major: the library SIGTERM handler breaks worker graceful shutdown.
  - Major: an in-repo `.gitattributes` changes checkout bytes.
- Downstream of L1-01: L1-05 (map), L1-06, L1-07 (also gated on CR-1 and CR-2), L1-13, L1-16.
- Gated on external inputs: L1-12 (CR-T10, OAuth credentials), L1-14 (Juice Shop and DVNA licensing), L1-15 (App credentials).
- Discovery minors follow-up (rules regression `handlerEndLine` fixes and normalizer minors) is committed locally on `lane1/L1-04b-discovery-minors` but not pushed. Its docker regression run needs a permission the agent did not have.
- CI has no Postgres service, so `@affidavit/db` test:pg and the discovery docker tests only run locally. Waiting on lead decision.
- Contract requests CR-1, CR-2, CR-3 and CR-5 in `docs/lanes/lane1/contract-requests.md` await the lead.

## Deferred follow-ups

- CLI: shutdown hang (`pool.end` waits on a checked-out client during SIGINT or timeout), unguarded open, shared deadline, more invisible characters to strip, dead column padding.
- db: pool sizing knob derived from concurrency, pool test fast-fail, `leaseLost` clock wording, compatibility shim for dropped functions.

## Decisions made in this lane

- Scanner images are pinned by digest; CodeQL is disabled pending a lead decision.
- Separate `affidavit_app`, `affidavit_worker` and non-superuser `affidavit_owner` roles; forced RLS on every table.
- Stage jobs are idempotent on caseId, stage and attempt via SECURITY DEFINER enqueue and claim functions with leases.

## Metrics from real runs

- None yet. Report `[metric]` until a run produces a number.
