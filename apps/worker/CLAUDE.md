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
- `handlers.ts`: `prepareCores(config, components?)` picks stage work by config (`AFFIDAVIT_INTAKE_IMPL`, `AFFIDAVIT_TRIAL_IMPL`, `AFFIDAVIT_JUDGE_IMPL`, each `fake` or `real`), checks host prerequisites and builds every env-derived component first, throwing ONE PrerequisiteError with all problems before anything starts, then builds the real Judge last and closes it if a later step throws; `buildHandlers` wraps the cores with `@affidavit/db`'s `stageHandler`. `components` are the seams (discover, model, judge, realJudgeFactory, probe, env); production passes only `env`, the sealed snapshot.
- `real/`: the real wiring (L1-10b). `intake.ts` re-derives the case file with `discoverCase` and refuses unless it reproduces the stored one; `trial.ts` runs `Orchestrator.run` per stage job through `stageScopedPorts`; `components.ts` builds the tool runner, discovery, the model port, and the Judge through Lane 2's `createRealJudge` (`realJudgeConfig` maps the settings); `prereqs.ts` is the startup check; `child-env.ts` is `childEnv` (the minimal environment for the worker's own child processes) and `sealSecrets` (called by `main.ts` and `open-case` after `loadConfig`); `open.ts` is what `open-case` does with a discovery run. Runbook: `docs/lanes/lane1/real-wiring.md`.
- `open-case.ts` (`pnpm open-case -- --tenant --repo --commit`): opens the trial case from real discovery output and records every F3 hold of the scan as its own case flagged `f3-hold` (`openHeldCase`).
- `worker.ts`: opens the two role pools, runs Graphile Worker, and calls `@affidavit/db`'s `reconcileOnce` on an interval. The handler ordering, lease guard, attempt numbering, recovery policy and review flags live in `packages/db` (see "Orchestration" in its CLAUDE.md), not here.
- `fakes/stages.ts`: scripted stand-ins, the default for every stage and the Judge (`FakeJudge`). They emit events idempotently before their transition.
- `test-child.ts`: a real worker in its own process for the kill tests; not part of the API.

## Invariants

- No logic that belongs to a lane: fakes are scripted and labelled `[fake]`.
- The fake arraign never dismisses (a high-score candidate is never silently dismissed). The real intake never dismisses either: any outcome other than a reproduced case file fails the attempt (`DiscoveryOutcomeError` names a dismissal, hold or not-found; `CaseFileMismatchError` names differing fields), and recovery flags it for review. `open-case` never drops an F3 hold.
- No child process sees a secret: the entry points seal `ANTHROPIC_API_KEY`, the database URLs and `AFFIDAVIT_REPO_SOURCES` out of `process.env`; the worker's own children get `childEnv()`.
- Intake scanners run under gVisor by default; plain Docker only with `AFFIDAVIT_TOOLRUNNER=docker`, and startup warns.
- No secret in any message: config, prerequisite and stage errors name variables, never values (repository sources and database URLs included).
- Events are emitted once (`recordOnce`) before the transition, which is the last write, so a retry cannot repeat them.

Root CLAUDE.md rules apply here. Do not add dependencies without asking.
