Read docs/plan.md, then docs/implementation-plan.md section 5 (Lane 1) before working in this package.

# @affidavit/db

**Owner:** Lane 1 (Intake and Platform)

**Mission:** Drizzle schema and migrations, row-level security, the Graphile Worker stage queue, and the real `CaseStore` and `EventSink` (`PgCaseStore`, `PgEventSink`).

## Commands

Run from this directory, or add `--filter @affidavit/db` from the repo root.

- `pnpm typecheck`, `pnpm lint`, `pnpm test` (pure unit tests only)
- `pnpm test:pg` runs the Postgres suites. It needs `AFFIDAVIT_TEST_DATABASE_URL`, the superuser URL of a throwaway server (for example compose Postgres). Each suite creates and drops its own database. Without the variable the suites skip with an explicit message. CI does not run them until a Postgres service is added.
- `pnpm db:generate` after editing `src/schema.ts`. Security objects (roles, RLS, grants, triggers) live in the hand-written `drizzle/0001_security.sql`; add later ones with `pnpm db:generate --custom --name=<name>`.

## Invariants

- Every table has `tenant_id`; RLS is enabled and forced on all of them; every foreign key includes `tenant_id`.
- Two login roles, both plain (not owner, not superuser, no BYPASSRLS, no memberships, no TEMP): `affidavit_app` (tenant tables under RLS, plus `enqueue_stage()`) and `affidavit_worker` (queue schema only, no tenant tables). Migrations run as the owner. Passwords are set at provisioning (`setRolePassword`, SCRAM verifier), never in a migration or a committed file. Open pools with `openPool`, which refuses an unsafe role.
- Tenants are created by the owner (`provisionTenant`), not the app role.
- Tenant is set per transaction (`withTenant`, `set_config(..., true)`), and the connection is `DISCARD ALL`ed before it returns to the pool. No tenant set means no rows. RLS defends against query-building bugs; code with arbitrary SQL as the app role could still call `set_config`.
- The app role cannot touch the Graphile Worker tables. It enqueues only through `enqueue_stage()` (SECURITY DEFINER; tenant forced from the transaction setting; checks the case exists; writes a durable `stage_jobs` record; returns false when the key is already queued, running or failed). The worker role claims through `claim_stage_run()`, which refuses a payload with no matching `stage_jobs` record, so a forged or rewritten job fails at claim and shows in `listFailedStageJobs`. An attempt starts at most once (`stage_runs`, with a lease). Handlers get a `StageContext`: complete the attempt in the handler's own final transaction (`ctx.complete(tx)`). Handler errors set `failed_at` and `error`. A killed worker leaves an open attempt; the orchestrator (L1-10) calls `resumeDecision` and moves to a new attempt (`failStageRun` to abandon, then `enqueueStage` with attempt + 1); a case that already left the stage counts as complete (`completeStageRun`). Graphile retries are off (`max_attempts` 1): resume is explicit.
- Append-only (triggers stop the application roles; the owner could still disable them): verdicts, events, ballots, stages, cost_rows, escalations, stage_jobs. Write-once: `exhibits.result`, `stage_runs.completed_at` and `failed_at`. Inserts are guarded too (cases start at intake with zero counters, exhibits and stage runs start without a result). `cases` identity, file, score and floor are immutable; stage changes are also checked in SQL (table, F3, appeals).
- Migrations must run as the designated owner role: the `owner_access` policies on `tenants`, `stage_jobs` and `stage_runs` name the role that ran them. After a Graphile Worker upgrade, re-run `applyMigrations` to grant and add policies for new queue tables.
- Budget arithmetic: `remaining_usd` is exact `numeric` rounded half away from zero at 6 decimals; `FakeCaseStore` rounds a float with `Math.round`. They can differ by one micro-dollar on exact half-micro values.
- `AFFIDAVIT_TEST_DATABASE_URL` must never point at a shared server: the tests create and alter cluster-wide roles (`affidavit_app`, `affidavit_worker`) and temporary roles. Use a throwaway container.
- Every function pins `search_path`; raw SQL names `public.<table>` (Drizzle cannot qualify `public`).
- Store rules match `FakeCaseStore` in `packages/testing`: `rejectTransition` plus a row lock in `transition`. Add a case to `src/transition-cases.ts` for any rule change.
- Queue jobs are keyed on tenant, case, stage and attempt.
- Add a new tenant table: schema, migration with FORCE RLS, policy and grants, and a line in the isolation test.

Root CLAUDE.md rules apply here. Do not add dependencies without asking.
