# Lane 2 progress: Judge and Evidence

Owner: @Thearius123 (claimed 2026-11-14)
Contracts version in use: v1.0

## Tasks

| ID    | Status (todo, doing, done, blocked) | Branch or PR                             | Notes                                                                                                                                                                                                                                                        |
| ----- | ----------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L2-01 | done                                | PR #12 (`lane2/L2-01-containment-suite`) | 8 probes in `packages/sandbox/src/containment`, run with `pnpm --filter @affidavit/sandbox containment`. Plain Docker: 7 of 8 contained, 1 of 8 recorded. See `containment.md`                                                                               |
| L2-02 | doing                               | PR #14 (`lane2/L2-02-gvisor-runner`)     | `packages/sandbox/src/gvisor`: hardened gVisor runner, syscall trace parser, mount allowlist, `ToolRunnerPort` for Lane 1. Containment suite 8 of 8 on the owner's workstation; done when it also passes on the shared sandbox host. See `sandbox-runner.md` |
| L2-03 | todo                                |                                          |                                                                                                                                                                                                                                                              |
| L2-04 | todo                                |                                          |                                                                                                                                                                                                                                                              |
| L2-05 | doing                               |                                          | Result artifact format defined in `packages/judge/src/artifact.ts` (with L2-06). Runner image and witness execution still to do, needs L2-03                                                                                                                 |
| L2-06 | done                                | PR #13 (`lane2/L2-06-rules-of-evidence`) | `Judge` implements `runWitness` and `runCounterexample` over a `WitnessExecutor` port. Real executor arrives with L2-03 and L2-05. See `rules-of-evidence.md`                                                                                                |
| L2-07 | todo                                |                                          |                                                                                                                                                                                                                                                              |
| L2-08 | todo                                |                                          |                                                                                                                                                                                                                                                              |
| L2-09 | todo                                |                                          |                                                                                                                                                                                                                                                              |
| L2-10 | todo                                |                                          |                                                                                                                                                                                                                                                              |
| L2-11 | todo                                |                                          |                                                                                                                                                                                                                                                              |
| L2-12 | todo                                |                                          |                                                                                                                                                                                                                                                              |

## Blocked

- L2-02 sign-off: the suite passes on the Lane 2 owner's workstation, but the shared sandbox host and CI runner (P0-10, open decision 1) do not exist yet.

## Skipped tests

- `packages/sandbox/src/gvisor/runner.integration.test.ts` (6 tests) is skipped in plain `pnpm test` because it needs Docker with the `runsc-affidavit` runtime. It runs with `pnpm --filter @affidavit/sandbox test:sandbox-host` and passed on 2026-11-14 on the owner's workstation. It moves into CI with L2-11 once a sandbox host runner exists.

## Decisions made in this lane

- 2026-11-14: A probe passes only if contained and recorded. Containment is judged from the host side where possible, and a probe with no start marker is never counted as contained.
- 2026-11-14: The containment runner feeds the probe on stdin and gives it a tmpfs `/scratch`, so no host path is mounted. It reuses `buildDockerRunArgs` so it measures the Phase 1 flags Lane 1 actually runs with.
- 2026-11-14: Follow-ups for the lead from the first run: add `--memory-swap` to `buildDockerRunArgs` (memory bound breached through swap), and decide on SELinux relabeling for tool mounts. Details in `containment.md`.

- 2026-11-14: The gVisor runner runs every container with `--security-opt label=disable`, because gVisor cannot start under an SELinux process label. Isolation comes from gVisor instead. Needs the lead's sign-off; see `sandbox-runner.md`.
- 2026-11-14: Lane 1 tools run on gVisor with the same flags but without the syscall trace. A witness run whose trace is malformed is refused, never judged.

## Metrics from real runs

- None yet. Report `[metric]` until a run produces a number.
