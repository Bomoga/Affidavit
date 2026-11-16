# Lane 2 progress: Judge and Evidence

Owner: @Thearius123 (claimed 2026-11-14)
Contracts version in use: v1.0

## Tasks
| ID | Status (todo, doing, done, blocked) | Branch or PR | Notes |
| --- | --- | --- | --- |
| L2-01 | done | PR #12 (`lane2/L2-01-containment-suite`) | 8 probes in `packages/sandbox/src/containment`, run with `pnpm --filter @affidavit/sandbox containment`. Plain Docker: 7 of 8 contained, 1 of 8 recorded. See `containment.md` |
| L2-02 | todo |  | |
| L2-03 | todo |  | |
| L2-04 | todo |  | |
| L2-05 | doing |  | Result artifact format defined in `packages/judge/src/artifact.ts` (with L2-06). Runner image and witness execution still to do, needs L2-03 |
| L2-06 | done | `lane2/L2-06-rules-of-evidence` | `Judge` implements `runWitness` and `runCounterexample` over a `WitnessExecutor` port. Real executor arrives with L2-03 and L2-05. See `rules-of-evidence.md` |
| L2-07 | todo |  | |
| L2-08 | todo |  | |
| L2-09 | todo |  | |
| L2-10 | todo |  | |
| L2-11 | todo |  | |
| L2-12 | todo |  | |

## Blocked
- L2-02: needs the Linux sandbox host with gVisor (P0-10, no owner in `docs/decisions.md`).

## Decisions made in this lane
- 2026-11-14: A probe passes only if contained and recorded. Containment is judged from the host side where possible, and a probe with no start marker is never counted as contained.
- 2026-11-14: The containment runner feeds the probe on stdin and gives it a tmpfs `/scratch`, so no host path is mounted. It reuses `buildDockerRunArgs` so it measures the Phase 1 flags Lane 1 actually runs with.
- 2026-11-14: Follow-ups for the lead from the first run: add `--memory-swap` to `buildDockerRunArgs` (memory bound breached through swap), and decide on SELinux relabeling for tool mounts. Details in `containment.md`.

## Metrics from real runs
- None yet. Report `[metric]` until a run produces a number.
