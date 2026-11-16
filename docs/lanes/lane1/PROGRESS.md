# Lane 1 progress: Intake and Platform

Owner: [unassigned]
Contracts version in use: v1.0

## Tasks

| ID    | Status (todo, doing, done, blocked) | Branch or PR | Notes                                                                                                                         |
| ----- | ----------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| L1-01 | todo                                |              |                                                                                                                               |
| L1-02 | blocked                             | #23 (open)   | In review (round 11). Merge blocked on licensing decision for the vendored gitleaks config.                                   |
| L1-03 | todo                                |              |                                                                                                                               |
| L1-04 | todo                                |              |                                                                                                                               |
| L1-05 | todo                                |              |                                                                                                                               |
| L1-06 | todo                                |              |                                                                                                                               |
| L1-07 | todo                                |              |                                                                                                                               |
| L1-08 | done                                | #21          | Corpus manifest and loader. CR-1, CR-2 filed.                                                                                 |
| L1-09 | done                                | #24          | Drizzle schema, forced RLS, append-only verdicts, Graphile queue, real CaseStore and EventSink. Postgres tests not yet in CI. |
| L1-10 | todo                                |              |                                                                                                                               |
| L1-11 | todo                                |              |                                                                                                                               |
| L1-12 | todo                                |              |                                                                                                                               |
| L1-13 | todo                                |              |                                                                                                                               |
| L1-14 | todo                                |              |                                                                                                                               |
| L1-15 | todo                                |              |                                                                                                                               |
| L1-16 | todo                                |              |                                                                                                                               |

## Blocked

- L1-02 (#23): waiting on lead decision about the MIT notice for the vendored gitleaks config.
- Wave B (L1-01, L1-03, L1-04, L1-10): waiting on #23.
- CI has no Postgres service, so `@affidavit/db` test:pg and the discovery docker tests only run locally. Waiting on lead decision.
- Contract requests CR-1, CR-2, CR-3 in `docs/lanes/lane1/contract-requests.md` await the lead.

## Decisions made in this lane

- Scanner images are pinned by digest; CodeQL is disabled pending a lead decision.
- Separate `affidavit_app`, `affidavit_worker` and non-superuser `affidavit_owner` roles; forced RLS on every table.
- Stage jobs are idempotent on caseId, stage and attempt via SECURITY DEFINER enqueue and claim functions with leases.

## Metrics from real runs

- None yet. Report `[metric]` until a run produces a number.
