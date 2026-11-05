Read docs/plan.md, then docs/implementation-plan.md section 5 (Lane 1) before working in this package.

# @affidavit/cli

**Owner:** Lane 1 (Intake and Platform)

**Mission:** CLI entry point: affidavit scan, status, and replay.

## Commands

Run from this directory, or add `--filter @affidavit/cli` from the repo root.

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Intended libraries (notes for later, not installed yet)

- A CLI argument parser (commander or citty, decided in L1-11)
- @affidavit/evidence (replay)

Root CLAUDE.md rules apply here. Do not add dependencies without asking.
