# Lane 1 progress: Intake and Platform

Owner: [unassigned]
Contracts version in use: v1.0

## Tasks

| ID     | Status (todo, doing, done, blocked) | Branch or PR                                  | Notes                                                                                                                                                                                                                                                                                                                |
| ------ | ----------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1-01  | blocked                             | #32 (open)                                    | Ingestion, after 3 fix rounds. Round 4 review found one blocker and three majors (see Blocked). Held pending lead decision on a fourth fix round.                                                                                                                                                                    |
| L1-02  | done                                | #23, #34                                      | Scanner images pinned by digest (#23). Discovery tools follow-ups (#34).                                                                                                                                                                                                                                             |
| L1-03  | done                                | #31                                           | SARIF normalizer.                                                                                                                                                                                                                                                                                                    |
| L1-04  | done                                | #33                                           | Own Semgrep rules and corpus regression harness. Minors follow-up is committed locally on `lane1/L1-04b-discovery-minors`, not pushed (see Blocked).                                                                                                                                                                 |
| L1-05  | blocked                             |                                               | Map. Blocked on L1-01.                                                                                                                                                                                                                                                                                               |
| L1-06  | blocked                             |                                               | Blocked on L1-01.                                                                                                                                                                                                                                                                                                    |
| L1-07  | blocked                             |                                               | Blocked on L1-01 and gated on CR-1, CR-2.                                                                                                                                                                                                                                                                            |
| L1-08  | done                                | #21                                           | Corpus manifest and loader. CR-1, CR-2 filed.                                                                                                                                                                                                                                                                        |
| L1-09  | done                                | #24, #35, #37                                 | Drizzle schema, forced RLS, append-only verdicts, Graphile queue, real CaseStore and EventSink. Follow-ups in #35 (L1-09b) and minors in #37 (L1-09c). Postgres tests not yet in CI.                                                                                                                                 |
| L1-10  | done                                | #30                                           | Worker.                                                                                                                                                                                                                                                                                                              |
| L1-10b | doing                               | lane1/L1-10b-real-wiring (#60, stacks on #57) | Real wiring behind `AFFIDAVIT_*_IMPL=real` (discovery, trial orchestrator on the real model port, jail Judge), startup prerequisite checks, `open-case`, runbook `docs/lanes/lane1/real-wiring.md`. A real verdict is still blocked on CR-11 (per-case targets), CR-7 and L3-11.                                     |
| L1-10c | doing                               | lane1/L1-10c-wiring-followup                  | Review follow-ups to #60: env checks before the Judge (closed on a later failure), minimal child env and sealed secrets (CR-12), every F3 hold recorded by `open-case` (`f3-hold` review flag, CR-13), `DiscoveryOutcomeError` naming the outcome, gVisor default for intake (plain Docker by name, with a warning). |
| L1-11  | done                                | #36                                           | CLI v0 with fake intake.                                                                                                                                                                                                                                                                                             |
| L1-12  | done                                | lane1/L1-12-api                               | Fastify API: ApiRoutes, SSE with id = seq and Last-Event-ID or ?after resume (CR-T10 resolved, cr-t10-sse-resume.md), dev auth (loopback only) and GitHub OAuth (refuses to start without credentials), CSRF, CSP, rate limits, HMAC webhook skeleton. Bundles route is a 501 stub until L2-08/L2-09.                |
| L1-13  | blocked                             |                                               | Blocked on L1-01.                                                                                                                                                                                                                                                                                                    |
| L1-14  | blocked                             |                                               | Corpus expansion. Gated on Juice Shop and DVNA licensing.                                                                                                                                                                                                                                                            |
| L1-15  | blocked                             |                                               | GitHub App. Gated on App credentials.                                                                                                                                                                                                                                                                                |
| L1-16  | blocked                             |                                               | Blocked on L1-01.                                                                                                                                                                                                                                                                                                    |

## L1-01c: NodeGoat ingestion without the escape hatch

Branch `lane1/L1-01c-nodegoat-ingest`, stacked on #51 (`lane1/L1-07-casefile`). Real ingestion of the pinned NodeGoat checkout now returns `ok`, so the L1-07 case file test runs end to end without `AFFIDAVIT_CASEFILE_UNINGESTED_OK` and the case file carries the real redaction locations (three: a private key and two generic API keys; locations only).

- Fonts (TrueType, OpenType, WOFF, WOFF2, EOT) whose structure checks out are left out of the workspace with reason `font-file`, like media. A font that fails the structure check, or sits under an archive name or in the quarantine sidecar, is still a coverage loss.
- `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml` and SVG files flagged `chunk-split-risk` are covered when the windows pass proves it (`src/tools/windowproof.ts`, rule bounds in `src/tools/matchbound.ts`). Anything else stays fail-closed.
- Review follow-up (#54 nits): the font absence post-check counts only `ENOENT` as absent (any other `lstat` error returns `incomplete`); the proof hashes the gitleaks config file the container mounts, resolved from the invocation's own `--config` and mounts; the gate-word search also covers each line's base64, hex and percent-decoded text to gitleaks' decode depth; rule bounds honor `(?i)` folding (k to U+212A, 3 bytes; s to U+017F, 2 bytes); `fontkit.testutil.ts` is test-only and left out of the build (`tsconfig.build.json`); a UTF-8 byte-order mark was removed from `fonts.ts`.
- Known gaps: (1) a match stitched together from decoded text on several lines (shared with every file over 100 KB); (2) the decoded gate-word search uses its own segment finder, which decodes more than gitleaks does (shorter minimum runs, every alignment) but is not gitleaks' exact decoder; (3) the WOFF2 check covers the header, size field and metadata and private block bounds only, not the compressed table stream, which is safe only because every font is left out of the workspace.
- Lane 3 still reads `fixtures/casefiles/nodegoat-sqli-001.json` (Lead generated). Pointing its tests at `fixtures/casefiles/nodegoat-nosqli-where-001.json` is a Lane 3 code change, so it is listed in the PR, not done here.

## Blocked

- L1-01 (#32): round 4 review found one blocker and three majors. Waiting on lead decision about a fourth fix round.
  - Blocker: gitleaks snapshot findings are dropped for "fully windowed" files when a secret longer than the window overlap is cut by every window.
  - Major: the git floor still admits 2.37.7 and 2.38.5.
  - Major: the library SIGTERM handler breaks worker graceful shutdown.
  - Major: an in-repo `.gitattributes` changes checkout bytes.
- Downstream of L1-01: L1-05 (map), L1-06, L1-07 (also gated on CR-1 and CR-2), L1-13, L1-16.
- Gated on external inputs: L1-14 (Juice Shop and DVNA licensing), L1-15 (App credentials).
- Discovery minors follow-up (rules regression `handlerEndLine` fixes and normalizer minors) is committed locally on `lane1/L1-04b-discovery-minors` but not pushed. Its docker regression run needs a permission the agent did not have.
- CI has no Postgres service, so `@affidavit/db` test:pg and the discovery docker tests only run locally. Waiting on lead decision.
- Contract requests CR-1, CR-2, CR-3 and CR-5 in `docs/lanes/lane1/contract-requests.md` await the lead.

## Deferred follow-ups

- CLI: shutdown hang (`pool.end` waits on a checked-out client during SIGINT or timeout), unguarded open, shared deadline, more invisible characters to strip, dead column padding.
- db: pool sizing knob derived from concurrency, pool test fast-fail, `leaseLost` clock wording, compatibility shim for dropped functions.
- API (L1-12): a Postgres-backed SessionStore (sessions table, forced RLS) for more than one API instance; an API token provider for machine clients (apps/mcp sends a bearer token); org-based tenancy instead of one tenant per GitHub user; trustProxy and per-client rate limits behind a proxy; push instead of 1 s polling for SSE; wire apps/worker and apps/cli to start the API (not a pure config change, so not done).

## Decisions made in this lane

- Scanner images are pinned by digest; CodeQL is disabled pending a lead decision.
- Separate `affidavit_app`, `affidavit_worker` and non-superuser `affidavit_owner` roles; forced RLS on every table.
- SSE resume (CR-T10): id is the seq; Last-Event-ID or ?after, the larger wins; a permanent seq hole is skipped after 5 s.
- Stage jobs are idempotent on caseId, stage and attempt via SECURITY DEFINER enqueue and claim functions with leases.

## Metrics from real runs

- None yet. Report `[metric]` until a run produces a number.
