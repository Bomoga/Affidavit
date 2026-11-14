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
- `pnpm containment` runs the L2-01 suite with every probe as a witness and updates `docs/lanes/lane2/containment.md`. Run it after every change to `src/jail` or `packages/sandbox`.

## Intended libraries (notes for later, not installed yet)

- Zod via @affidavit/contracts
- Vitest (as the witness runner inside the jail): installed in the runner image only, version 5.1.0, see `docs/lanes/lane2/witness-protocol.md`

Root CLAUDE.md rules apply here. Do not add dependencies without asking.
