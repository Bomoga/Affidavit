# Contracts changelog

## Unreleased (2026-11-27)

Behaviour rule, no schema change: no type, field or `STAGE_TRANSITIONS` entry changes, so no fixture or schema export changes and `schemaVersion` stays `1`. Approved by the lead on 2026-11-27.

- **CR-3 (problem 1), F3 on every transition into `dismissed`:** a case whose candidate score is at or above its escalation floor cannot be dismissed from `arraign`, `defense` or `prosecution`. Before this the rule covered `defense` to `dismissed` only, so `arraign` to `dismissed` and `prosecution` to `dismissed` could silently dismiss a high-score candidate. The `STAGE_TRANSITIONS` comment now says so; `FakeCaseStore` (packages/testing), `rejectTransition` and `PgCaseStore` (packages/db) and the SQL guard (migration `0012_f3_every_dismissal`) enforce it together. A caller that dismissed a high-score case from `arraign` or `prosecution` now gets `IllegalTransitionError` and must escalate or hold for review instead.
- **CR-3 (problem 2), `verify` to `verdict` needs the jury disabled:** with the jury enabled a case must pass through it (`verify` to `jury`, then `verdict`) even when appeals are exhausted, so a case cannot skip the jury and end `not-proven`. Before this the stores let `verify` go straight to `verdict` once `appeals >= MAX_APPEALS`. This matches the existing `STAGE_TRANSITIONS` comment. `verify` to `jury` stays legal with appeals exhausted. Whether the jury-enabled setting belongs on the case, so the database can enforce it, is still open: it stays store configuration and the SQL guard does not check it.

## v1.2 (2026-11-21)

Additive minor bump under `docs/implementation-plan.md` section 3.4, approved by the lead (`docs/decisions.md`, 2026-11-21). No v1.0 or v1.1 member is renamed, removed or reordered; every stored case file, event stream, verdict and exhibit result still parses unchanged, and `schemaVersion` stays `1`. No fixture changes, so the generator output is unchanged.

- **CR-T1, releasing an up-front charge** (`docs/lanes/lane3/contract-requests-trial.md`):
  - `CaseStore.releaseCharge?(caseId, refund: StageCost, reservationSeq: number): Promise<BudgetState>`. Optional in v1.2 so every existing store still compiles; a store without it releases nothing and the charge stands. Rules: idempotent on `(caseId, reservationSeq)` (a second call changes nothing and returns the current budget); a refund names the same stage and attempt as the `cost-charged` event at `reservationSeq` and no field exceeds it; what a case has had released never exceeds what it was charged, so the ledger never goes negative. A refused release throws the new `ReleaseRejectedError` and changes nothing.
  - `'cost-released'` appended to `TrialEventType`, payload `CostRelease`: `{ cost: StageCost, remaining: BudgetState, reservationSeq: int >= 0, reason: CostReleaseReason }`, with `CostReleaseReason = 'model-call-failed' | 'reservation-unspent'`. Emitted by the stage's actor after the release succeeds. A stage's net cost is its `cost-charged` events minus its `cost-released` events, which is what `Verdict.cost` reports, so the timeline and the verdict agree.
  - `FakeCaseStore` (packages/testing) implements it. Given `{ events: FakeEventSink }` it checks each refund against the `cost-charged` event at its seq; without a sink it enforces the case-wide rule only. New helper `releases(caseId)`.
- **CR-T12, CR-T13, why a case halted:** `'halted'` appended to `TrialEventType`, payload `Halt`: `{ reason: HaltReason, refusalCategory?: RefusalCategory, detail?: string }`, with `HaltReason = 'kill-switch' | 'model-unconfigured' | 'model-refusal' | 'budget-exhausted'` and `RefusalCategory` the allowlist from CR-T13 (`cyber, bio, chem, csam, frontier_llm, reasoning_extraction, other`), allowed only with `model-refusal`. A halt is not a stage and moves no stage, so it is legal from every stage and `STAGE_TRANSITIONS` is unchanged; running the case again resumes where it stopped. A `budget-exhausted` halt never replaces the existing `budget-exhausted` event and its Escalation. A refusal is never a dismissal.
- **CR-14, scanner coverage on the case file** (`docs/lanes/lane1/contract-requests.md`): optional `CaseFile.scanners: ScannerCoverage[]`, at most one entry per tool. `ScannerCoverage = { tool: ScannerTool, ran: boolean, ref?: string, reason?: ScannerSkipReason, detail?: string }`; a scanner that did not run must name a reason and one that ran cannot. `ScannerTool = 'semgrep' | 'codeql' | 'osv' | 'treesitter' | 'gitleaks'` (wider than `Candidate.tool`, which is unchanged). `ScannerSkipReason = 'not-supported-in-jail' | 'not-configured' | 'tool-failed'`. An absent field means coverage was not recorded (a case file from before v1.2), never that every scanner ran.
- **CR-T11, recorded model outputs:** `ModelRecording = { schemaVersion: 1, promptId: PromptId, promptVersion, model, inputSha256: Sha256, userSha256: Sha256, result: { outcome, submission?: unknown, cost: StageCost }, redacted?: boolean }`, the shape `packages/trial/src/model/recordings.ts` writes. The fixture check in packages/testing maps `models/<promptId>/<inputSha256>.json` to it and checks that the path matches the recording's own prompt id and hash. No recordings are committed.
- Registry: `ScannerCoverage` and `ModelRecording` registered with samples; `trialEventSamples` gains `cost-released` and `halted`. Tests: parse and rejection tests for every new type, a back-compat test that parses every stored case file and event stream unchanged, and type tests that a store without `releaseCharge` still satisfies `CaseStore`.
- Consumers with a total switch over `TrialEvent` gained the two new cases so they still compile: `apps/web` `caseView.ts` (Lane 3, a docket label each) and `apps/cli` `render.ts` (Lane 1, a detail line each). Nothing else in those apps changes. Follow-ups for each lane: `docs/lanes/lane1/contract-requests.md` and `docs/lanes/lane3/contract-requests-trial.md`, "Contracts v1.2 follow-ups".

## v1.1 (2026-11-20)

Additive minor bump under `docs/implementation-plan.md` section 3.4, approved by the lead. No v1.0 member is renamed, removed or reordered, and every v1.0 event still parses.

- **CR-1, `verify-result` trial event** (`docs/lanes/lane3/contract-requests.md`): `'verify-result'` is appended at the end of `TrialEventType`, and `TrialEvent` gains `event('verify-result', z.object({ result: VerifyResult }))`. It is emitted by actor `judge` in stage `verify`, once per `JudgePort.verifyPatch` call, so appeals produce one per round. A client that reads only the stream can now see the Judge's patch check instead of trusting the verdict's claim.
- `src/samples.ts` gains `trialEventSamples` (exported), one valid sample per event type added after v1.0, since the registry holds one sample per schema. The round-trip tests parse it and reject a payload with no result, a non-`VerifyResult` result, a result missing a required field, and the payload under another event type.
- JSON Schema export is registry-based, so the `TrialEvent` schema picks up the new member with no exporter change.
- Fixtures: `fixtures/trials/nodegoat-sqli-001.events.json` gains a passing `verify-result` for `exhibit-patch-001` between the `verify` stage-entered and stage-exited events (seq 17); the two events after it are renumbered to 18 and 19. Its `counterexamples` list is empty because that trial admits no counterexample.

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
