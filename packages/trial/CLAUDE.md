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
- A dismissed case is repaired by a new instance (terminal case, no verdict) only if the
  Orchestrator was given the same `TrialWorkspace`, which holds the recorded Dismissal. Without a
  stored Dismissal the orchestrator throws instead of inventing one. The verdict is written after
  the transition, so a refused transition leaves no verdict. A verdict on a case still in
  progress makes `run` throw rather than rerun agents.
- A verdict repaired by a new instance (dismissed or escalated) has empty exhibits, cost,
  promptVersions and modelIds, because those are in memory only.
- A crash between the escalation transition and its events leaves no `escalated` event; only the
  verdict is repaired on rerun.
- Verify records one `verify-result` per entry in `PatchOutcome.verifyResults` (CR-1). Those
  events are not deduplicated, so a verify stage run twice for one Remedy run records them twice.

## Prosecution counterexample rule (L3-08)

The agent submits `{ choices: [{ name, indices?, values? }] }`, never code. A counterexample is sent to the Judge only if every chosen name is declared by the Defense witness family and chosen once, indices are in range, new values are JSON of a kind the family already uses for that parameter and at most 1024 characters, and the product of the resulting space is at most 64 (placeholders; `DEFAULT_PARAM_LIMITS`). Anything else is recorded as `exhibit-inadmissible` with rule `schema` and not run. Prose with no choices fails the same way. See `counterexample.ts`. CR-T8 and CR-T9 list the contract gaps.

## Intended libraries (notes for later, not installed yet)

- Claude Agent SDK
- Graphile Worker
- @affidavit/contracts and @affidavit/judge (workspace deps)

Root CLAUDE.md rules apply here. Do not add dependencies without asking.
