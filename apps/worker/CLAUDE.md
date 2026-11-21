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
- `handlers.ts`: `prepareCores(config, components?)` picks stage work by config (`AFFIDAVIT_INTAKE_IMPL`, `AFFIDAVIT_TRIAL_IMPL`, `AFFIDAVIT_JUDGE_IMPL`, each `fake` or `real`), checks host prerequisites first and throws before anything starts; `buildHandlers` wraps the cores with `@affidavit/db`'s `stageHandler`. `components` are the test seams (discover, model, judge, probe, env); production passes none.
- `real/`: the real wiring (L1-10b). `intake.ts` re-derives the case file with `discoverCase` and refuses unless it reproduces the stored one; `trial.ts` runs `Orchestrator.run` per stage job through `stageScopedPorts`; `components.ts` builds the tool runner, discovery, the model port, and the Judge through Lane 2's `createRealJudge` (`realJudgeConfig` maps the settings); `prereqs.ts` is the startup check. Runbook: `docs/lanes/lane1/real-wiring.md`.
- `open-case.ts` (`pnpm open-case -- --tenant --repo --commit`): opens one case from real discovery output.
- `worker.ts`: opens the two role pools, runs Graphile Worker, and calls `@affidavit/db`'s `reconcileOnce` on an interval. The handler ordering, lease guard, attempt numbering, recovery policy and review flags live in `packages/db` (see "Orchestration" in its CLAUDE.md), not here.
- `fakes/stages.ts`: scripted stand-ins, the default for every stage and the Judge (`FakeJudge`). They emit events idempotently before their transition.
- `test-child.ts`: a real worker in its own process for the kill tests; not part of the API.

## Invariants

- No logic that belongs to a lane: fakes are scripted and labelled `[fake]`.
- The fake arraign never dismisses (a high-score candidate is never silently dismissed). The real intake never dismisses either: any outcome other than a reproduced case file fails the attempt, and recovery flags it for review.
- No secret in any message: config, prerequisite and stage errors name variables, never values (repository sources and database URLs included).
- Events are emitted once (`recordOnce`) before the transition, which is the last write, so a retry cannot repeat them.

Root CLAUDE.md rules apply here. Do not add dependencies without asking.
