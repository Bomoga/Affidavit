Read docs/plan.md, then docs/implementation-plan.md section 6 (Lane 2) before working in this package.

# @affidavit/judge

**Owner:** Lane 2 (Judge and Evidence), @Thearius123

**Mission:** Rules of evidence and the witness runner; the only bridge between agents and the sandbox.

## Commands

Run from this directory, or add `--filter @affidavit/judge` from the repo root.

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test` (unit tests, no Docker needed)
- `pnpm test:sandbox-host` runs the witness jail against real gVisor (needs a sandbox host, see `docs/lanes/lane2/sandbox-runner.md`)
- `pnpm runner-image` builds the witness runner image (`docker/sandbox/witness-runner`) and prints its image ID
- `pnpm patch-apply-image` builds the patch-apply image (`docker/sandbox/patch-apply`) and prints its image ID
- `pnpm containment` runs the L2-01 suite with every probe as a witness and updates `docs/lanes/lane2/containment.md`. Run it after every change to `src/jail` or `packages/sandbox`.

## Real Judge entry point

`createRealJudge(config)` (`src/jail/real.ts`) is the one factory the worker uses: `Judge` on the gVisor `JailExecutor`, a `CaseTargets` provider (`src/jail/targets.ts`) that boots each case's vulnerable and safe variants and records their image digests, the `JailedPatchWorkbench`, and the evidence store and signer client passed in built. It checks every host prerequisite first and throws `RealJudgePrerequisiteError` listing all of them. Host steps: `docs/lanes/lane2/real-judge-host.md`.

## Invariants

- A case with a safe variant is never judged without its booted safe target: `CaseTargets` boots both or neither, and a boot failure throws `CaseBootError` before any witness runs.
- The stored case file is never changed; the Judge runs on a copy with the booted `imageDigest`s, and `BootedTargets` serves a variant only for that exact image.
- Boot failures are typed outcomes (`unsupported`, `boot-failed`) and always tear down every case network the boot made.
- Startup messages name config fields and variables, never values.
- The orphan sweep is off by default and removes only case networks a lease proves belong to a dead worker on this host (`src/jail/lease.ts`); unproven ownership is never swept.
- `src/` is scanned by the sandbox egress guard; `child_process` only in the files it lists.

## Intended libraries (notes for later, not installed yet)

- Zod via @affidavit/contracts
- Vitest (as the witness runner inside the jail): installed in the runner image only, version 5.1.0, see `docs/lanes/lane2/witness-protocol.md`

Root CLAUDE.md rules apply here. Do not add dependencies without asking.
