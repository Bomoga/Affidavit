Read docs/plan.md, then docs/implementation-plan.md section 6 (Lane 2) before working in this package.

# @affidavit/sandbox

**Owner:** Lane 2 (Judge and Evidence)

**Mission:** Isolation runner and witness jail (gVisor first, deny-all egress).

## Commands

Run from this directory, or add `--filter @affidavit/sandbox` from the repo root.

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Intended libraries (notes for later, not installed yet)

- gVisor (runsc) as a host runtime, not an npm dep
- A Docker API client (TBD)

Root CLAUDE.md rules apply here. Do not add dependencies without asking.
