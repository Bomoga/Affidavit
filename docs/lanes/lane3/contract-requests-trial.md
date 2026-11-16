# Lane 3 contract requests from packages/trial

Proposals only. Nothing here changes `packages/contracts`; per implementation-plan section 3.4, each needs a `contracts: <change>` issue and Adrian's review. Until one merges, `packages/trial` works within contracts v1.0 as described under "Meanwhile".

## CR-T1: refund or settle an up-front budget charge (L3-01)

- **Need:** `CaseStore.chargeBudget` is called before the model call it pays for, so the amount must be the turn's whole budget. There is no way to give back what the call did not spend.
- **Proposal (additive):** `CaseStore.settleCharge(caseId, reservation: StageCost, actual: StageCost): Promise<BudgetState>`, or a `kind: 'reservation' | 'actual'` field on cost rows.
- **Meanwhile:** the orchestrator charges the turn budget up front (a cap, since `ModelPort` is held to the same budget), charges any overspend on top, and never refunds. Budgets run out sooner than actual spend would require. What calls actually cost is kept in memory per case and is what `Verdict.cost` reports.

## CR-T2: read back the cost rows for a case (L3-01, L3-06)

- **Need:** the verdict records `cost: StageCost[]`, but `CaseStore` has no read for cost rows.
- **Proposal (additive):** `CaseStore.costs(caseId): Promise<readonly StageCost[]>`.
- **Meanwhile:** `StageContext.costs()` returns the actual costs the orchestrator saw in this process. A case resumed in another process loses the earlier rows.

## CR-T3: report a kill-switch halt in the event stream (L3-01)

- **Need:** a tripped kill switch is neither a budget exhaustion nor a reason for human review of the finding, so it must not be recorded as `budget-exhausted` or as an `Escalation`. v1.0 has no event type or reason for it.
- **Proposal (additive):** a `halted` `TrialEventType` with payload `{ reason: 'kill-switch' }`.
- **Meanwhile:** `Orchestrator.run` returns `{ status: 'halted', stage, reason: 'kill-switch' }`, emits nothing for the halt, and leaves the case at its current stage so running it again resumes it.

## CR-T4: escalation from intake, map, and arraign (L3-01)

- **Need:** `STAGE_TRANSITIONS` allows `escalated` only from defense onward.
- **Proposal:** none for now. These stages are deterministic and never call a model, so they have no budget to exhaust and no witness to fail. Recorded so the decision is explicit.
- **Meanwhile:** a handler in those stages that returns an escalation gets `EscalationNotAllowedError`; the case stays at its stage and the job fails loudly. `runAgent` refuses to call a model from those stages.

## CR-T5: name a schema-rejected agent output (L3-02)

- **Need:** `exhibit-inadmissible` requires an `exhibitId`, but agent output that fails schema never became an exhibit, so nothing has assigned it an id.
- **Proposal (additive):** document a minting rule for rejected submissions in the contracts changelog, or make `exhibitId` optional when `rejectedBy` is `schema`.
- **Meanwhile:** the orchestrator names it `exhibit-<kind>-rejected-<first 24 hex of sha256(canonical JSON of {caseId, stage, attempt, submission})>`, so the id is stable for the same output and never collides with a Judge-minted id. A Remedy diff that cannot be read as a patch is named the same way.

## CR-T6: a rule for a patch that does not flip the family or leaves the rescan dirty (L3-05)

- **Need:** `AdmissibilityRule` has `literal-only-patch`, `diff-too-large`, `suite-fails` and `counterexample-survives`, but nothing for a `VerifyResult` with `familyFlipped: false` or `rescanClean: false` and no `rejectedBy`.
- **Proposal (additive):** `family-not-flipped` and `rescan-not-clean` appended to `AdmissibilityRule`, or a documented guarantee that `verifyPatch` always sets `rejectedBy` when it does not accept.
- **Meanwhile:** Remedy records `exhibit-inadmissible` only when a rule applies (the Judge's own, or `suite-fails` or `counterexample-survives` derived from the flags). Otherwise it records no rule, keeps the full `VerifyResult` in the workspace, and the patch is not accepted. The Judge's acceptance itself is not in the event stream until CR-1 in `contract-requests.md` (a `verify-result` event) lands.

## CR-T7: an escalation reason for missing evidence at verify (L3-06)

- **Need:** the verify stage must not write a `proven-*` verdict without an admitted witness exhibit. When that happens it is a pipeline fault, not a weak finding, and `Escalation.reason` has no member for it.
- **Proposal (additive):** `missing-admitted-witness` appended to `Escalation.reason`.
- **Meanwhile:** verify escalates with `no-admissible-witness-above-floor`, the closest v1.0 reason, and says what happened in `detail`.

## Verify to verdict wiring (L3-06, no change requested)

`STAGE_TRANSITIONS` allows verify to verdict only when the jury is disabled or appeals are exhausted. Until the jury (L3-11) exists, `createVerifyHandler` takes `jury: 'disabled'` and must run against a `CaseStore` wired with the jury disabled (`new FakeCaseStore({ juryEnabled: false })` in tests; the same setting on the Postgres store in apps/worker). A store with the jury enabled refuses the transition, and a test covers that. `verdict-written` is emitted in the `verify` stage by the stenographer, after `CaseStore.appendVerdict` succeeds.
