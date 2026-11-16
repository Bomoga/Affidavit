Read docs/plan.md, then docs/implementation-plan.md section 7 (Lane 3) before working in this package.

# @affidavit/trial

**Owner:** Lane 3 (Trial and Courtroom)

**Mission:** Trial orchestrator, agent roles, and the jury.

## Commands

Run from this directory, or add `--filter @affidavit/trial` from the repo root.

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Known gaps

- Terminal verdicts (dismissed, escalated) cite the exhibits the current `Orchestrator` instance
  saw as events. The seen-exhibit set is in memory, like the cost ledger, so a case resumed in a
  new instance cites only exhibits seen after the resume. A fix needs a seen-exhibit record in
  `TrialWorkspace` (separate from the admitted-only `getExhibits`).
- A dismissed case resumed in a new instance with no verdict cannot be repaired: the recorded
  Dismissal is not readable from there, so the orchestrator throws instead of inventing one.

## Intended libraries (notes for later, not installed yet)

- Claude Agent SDK
- Graphile Worker
- @affidavit/contracts and @affidavit/judge (workspace deps)

Root CLAUDE.md rules apply here. Do not add dependencies without asking.
