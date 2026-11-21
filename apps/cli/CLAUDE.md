Read docs/plan.md, then docs/implementation-plan.md section 5 (Lane 1) before working in this package.

# @affidavit/cli

**Owner:** Lane 1 (Intake and Platform)

**Mission:** CLI entry point: `affidavit scan`, `status`, and `replay` (v0, L1-11).

## Commands

Run from this directory, or add `--filter @affidavit/cli` from the repo root.

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test` (unit tests; no database)
- `pnpm test:pg` (end to end against a worker with all fakes; needs Docker and `AFFIDAVIT_TEST_POSTGRES_PASSWORD` set to a fresh random value in your shell only. The test starts and removes its own Postgres container.)
- `pnpm affidavit <command>` runs the CLI from source.

## What v0 does

- `scan <target>` is FAKE INTAKE: it refuses unless `AFFIDAVIT_INTAKE_IMPL=fake`, builds the case file from the recorded `nodegoat-sqli-001` fixture (fresh case id, tenant from `AFFIDAVIT_TENANT_ID`, `target.repo` from the argument), calls `startCase`, then polls `PgEventSink.events(caseId, afterSeq)` until a terminal event or timeout (CR-9). A worker must be running. `AFFIDAVIT_INTAKE_IMPL=real` exits 4.
- `status <caseId>` prints the stage, event count and the last events.
- `replay <bundle>` uses `replayBundle` from `@affidavit/evidence` when it exists; until L2-08 it exits 4 ("not implemented").
- Configuration comes from the environment only: `AFFIDAVIT_APP_DATABASE_URL` (secret), `AFFIDAVIT_TENANT_ID`, `AFFIDAVIT_INTAKE_IMPL`.

## Exit codes

See `src/exit.ts` and `affidavit --help`: 0 ok, 1 unexpected, 2 usage, 3 config, 4 not implemented, 5 timeout, 6 case not found, 7 database unavailable, 10 escalated, 11 budget exhausted, 130 interrupted.

## Invariants

- All event text is untrusted. Everything printed from an event goes through `sanitize` in `src/render.ts` (ANSI and control stripping, bidi and zero-width removal, length caps).
- No secret in output or errors: errors name variables, never values, and database URLs and their passwords are scrubbed (`toCliError`).
- No em dashes in user-facing copy.

Root CLAUDE.md rules apply here. Do not add dependencies without asking. `@affidavit/worker` is a devDependency for the end-to-end test only.
