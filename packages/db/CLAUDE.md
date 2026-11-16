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
- The app connects as `affidavit_app` (not owner, not superuser, no BYPASSRLS). Migrations run as the owner. The login password is set at provisioning (`setAppRolePassword`), never in a migration or a committed file.
- Tenant is set per transaction (`withTenant`, `set_config(..., true)`). No tenant set means no rows.
- `verdicts` and `events` are insert-only for the app role, with a trigger that also stops the owner. No DELETE or TRUNCATE grants anywhere.
- Store rules match `FakeCaseStore` in `packages/testing`: `rejectTransition` plus a row lock in `transition`. Add a case to `src/transition-cases.ts` for any rule change.
- Queue jobs are keyed on tenant, case, stage and attempt. Graphile Worker's own tables are not tenant tables and carry ids only.
- Add a new tenant table: schema, migration with FORCE RLS, policy and grants, and a line in the isolation test.

Root CLAUDE.md rules apply here. Do not add dependencies without asking.
