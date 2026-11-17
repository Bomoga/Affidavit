Read docs/plan.md, then docs/implementation-plan.md section 5 (Lane 1) before working in this package.

# @affidavit/worker

**Owner:** Lane 1 (Intake and Platform)

**Mission:** Composition root: wires real or fake implementations to the ports. Wiring and config only, no business logic.

## Commands

Run from this directory, or add `--filter @affidavit/worker` from the repo root.

- `pnpm typecheck`, `pnpm lint`, `pnpm test` (unit tests only)
- `pnpm test:pg` runs the end-to-end suite. It needs Docker and `AFFIDAVIT_TEST_POSTGRES_PASSWORD` (a fresh random value, set in your shell only). The suite starts its own Postgres container from the digest in `docker/compose.yaml` on a random localhost port, kills real worker processes with SIGKILL, and removes only the container it created. Without the variable it skips with a message.

## Layout

- `config.ts`: environment only, validated, no secret ever in an error or in `describeConfig`. The two database URLs are the `affidavit_app` and `affidavit_worker` role URLs.
- `handlers.ts`: `selectCores` picks stage work by config (`AFFIDAVIT_INTAKE_IMPL`, `AFFIDAVIT_TRIAL_IMPL`, `AFFIDAVIT_JUDGE_IMPL`, each `fake` or `real`; `real` fails at startup until wired) and wraps it with `@affidavit/db`'s `stageHandler`.
- `worker.ts`: opens the two role pools, runs Graphile Worker, and calls `@affidavit/db`'s `reconcileOnce` on an interval. The handler ordering, lease guard, attempt numbering, recovery policy and review flags live in `packages/db` (see "Orchestration" in its CLAUDE.md), not here.
- `fakes/stages.ts`: scripted stand-ins. All of intake, map, arraign, defense, prosecution, remedy, verify, jury and the Judge (`FakeJudge`) are fakes today. They emit events idempotently before their transition.
- `test-child.ts`: a real worker in its own process for the kill tests; not part of the API.

## Invariants

- No logic that belongs to a lane: fakes are scripted and labelled `[fake]`.
- The fake arraign never dismisses (a high-score candidate is never silently dismissed).
- Events are emitted once (`recordOnce`) before the transition, which is the last write, so a retry cannot repeat them.

Root CLAUDE.md rules apply here. Do not add dependencies without asking.
