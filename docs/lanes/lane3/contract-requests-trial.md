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
