Read docs/plan.md, then docs/implementation-plan.md section 6 (Lane 2) before working in this package.

# @affidavit/sandbox

**Owner:** Lane 2 (Judge and Evidence), @Thearius123

**Mission:** Isolation runner and witness jail (gVisor first, deny-all egress).

## Commands

Run from this directory, or add `--filter @affidavit/sandbox` from the repo root.

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test` (unit tests, no Docker needed)
- `pnpm test:sandbox-host` runs the gVisor runner and boot recipe tests (needs a sandbox host; set `AFFIDAVIT_NODEGOAT_DIR` to a NodeGoat checkout for the gate target, see `docs/lanes/lane2/boot-recipes.md`)
- `pnpm containment` runs the L2-01 containment suite against Docker and updates `docs/lanes/lane2/containment.md`. Run it after every change to this package or `packages/judge`.

## Intended libraries (notes for later, not installed yet)

- gVisor (runsc) as a host runtime, not an npm dep
- A Docker API client (TBD)

Root CLAUDE.md rules apply here. Do not add dependencies without asking.
