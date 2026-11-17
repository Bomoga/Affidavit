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
- `handlers.ts`: `selectCores` picks stage work by config (`AFFIDAVIT_INTAKE_IMPL`, `AFFIDAVIT_TRIAL_IMPL`, `AFFIDAVIT_JUDGE_IMPL`, each `fake` or `real`; `real` fails at startup until wired). `stageHandler` wraps stage work in the order the db package requires: work and case transition, then enqueue the next stage, then `ctx.complete(tx)` last. Every port write goes through `GuardedCaseStore` and `GuardedEventSink`, which refuse once the lease signal aborted.
- `reconcile.ts`: the recovery pass (`resumeDecision`): abandon a dead attempt before enqueueing attempt + 1, charge the retry, adopt an attempt whose case already moved on, and enqueue the stage the case is at. Beyond `AFFIDAVIT_MAX_STAGE_ATTEMPTS` or with an exhausted budget a case is reported as needs-review and is never dropped.
- `fakes/stages.ts`: scripted stand-ins. All of intake, map, arraign, defense, prosecution, remedy, verify, jury and the Judge (`FakeJudge`) are fakes today.
- `test-child.ts`: a real worker in its own process for the kill tests; not part of the API.

## Invariants

- No logic that belongs to a lane: fakes are scripted and labelled `[fake]`.
- The fake arraign never dismisses (a high-score candidate is never silently dismissed).
- Events are emitted by the exiting stage after the transition, so a retry cannot repeat them.

Root CLAUDE.md rules apply here. Do not add dependencies without asking.
