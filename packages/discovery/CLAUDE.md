Read docs/plan.md, then docs/implementation-plan.md section 5 (Lane 1) before working in this package.

# @affidavit/discovery

**Owner:** Lane 1 (Intake and Platform)

**Mission:** Repo ingestion, the map, tool runners, and arraignment scoring.

## Commands

Run from this directory, or add `--filter @affidavit/discovery` from the repo root.

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Intended libraries (notes for later, not installed yet)

- tree-sitter
- Semgrep, CodeQL, OSV-Scanner, gitleaks (run as pinned Docker images, not npm deps)
- A SARIF parser (TBD)

Root CLAUDE.md rules apply here. Do not add dependencies without asking.
