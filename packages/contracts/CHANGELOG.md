# Contracts changelog

## v1.0 (2026-11-05)

First frozen version for Phase 1. Every top-level boundary object carries `schemaVersion: 1`. Changes follow `docs/implementation-plan.md` section 3.4.

### Open items from implementation-plan section 3.2, resolved

- **Stage list:** as in the plan. The legal transition table is `STAGE_TRANSITIONS` in `src/common.ts`. Rules a table cannot express are enforced by every `CaseStore`: defense to dismissed only below the case's escalation floor (F3); verify to remedy at most `MAX_APPEALS` (2) times; verify to jury only when the jury is enabled; verify to verdict when the jury is disabled or appeals are exhausted (needed for a `not-proven` verdict).
- **Severity:** `low | medium | high | critical`.
- **TrialEventType:** `stage-entered, stage-exited, exhibit-submitted, exhibit-result, exhibit-inadmissible, objection, appeal, ballot-cast, cost-charged, budget-exhausted, escalated, dismissed, verdict-written`. `payload` is a per-type discriminated union.

### Changes from the plan's field lists (from the Lane 3 contracts draft, approved)

- `Verdict.promptVersions` and `modelIds` are keyed by `PromptId`, not `Role`. A role can run several prompts (Defense second attempt, three juror mandates).
- `Ballot` is a discriminated union on `question`, so a mechanical question has no representation. `citedExhibits` must have at least one entry.
- `Verdict.severity` is optional (absent for dismissed, escalated, not-proven).
- `Witness` gains `sha256`, the key scripted fakes use (draft issue B).
- `Budget` and `BudgetState` are contracts, because `CaseStore.chargeBudget` returns the remaining budget (draft issue E said config only; the port needs the type).

### Additions beyond the plan

- `Dismissal.reason` gains `no-admissible-witness-below-floor`, the recorded dismissal in the Defense stage below the escalation floor.
- `RescanPort` (Lane 1 provides, Lane 2 consumes inside `verifyPatch`), because L2-07 needs a discovery re-scan port.
- `Redaction` is location and kind only. It never carries the secret value.
- `ExhibitResult` refuses an inadmissible result with no `rejectedBy`, and an admissible result with one.
- `CaseStore.open`, `stage`, `nextSeq` and `getVerdict`, so the fakes and the Postgres store share one surface. `seq` is assigned by the store; `EventSink.emit` is idempotent on `(caseId, seq)`.

### Tooling

- Zod 4. JSON Schema export uses Zod's built-in `z.toJSONSchema`, so no separate exporter is installed. Run `pnpm --filter @affidavit/contracts export:schema`; output goes to `packages/contracts/json-schema/` (not committed).
- `src/samples.ts` holds one valid sample per registered schema. The round-trip tests and the fixtures generator use it. Witness code in samples and fixtures is a placeholder, never an attack.
