# Lane 3 contract requests from packages/trial

Proposals only. Nothing here changes `packages/contracts`; per implementation-plan section 3.4, each needs a `contracts: <change>` issue and Adrian's review. Until one merges, `packages/trial` works within contracts v1.0 as described under "Meanwhile".

## CR-T1: refund or settle an up-front budget charge (L3-01)

- **Need:** `CaseStore.chargeBudget` is called before the model call it pays for, so the amount must be the turn's whole budget. There is no way to give back what the call did not spend.
- **Proposal (additive):** `CaseStore.settleCharge(caseId, reservation: StageCost, actual: StageCost): Promise<BudgetState>`, or a `kind: 'reservation' | 'actual'` field on cost rows.
- **Meanwhile:** the orchestrator charges the turn budget up front (a cap, since `ModelPort` is held to the same budget), charges any overspend on top, and never refunds. Budgets run out sooner than actual spend would require. What calls actually cost is kept in memory per case and is what `Verdict.cost` reports.
- **Why it now matters (L3-16, first real run):** every Defense attempt failed with `invalid_request` before the provider produced a token, and each attempt still left a `cost_rows` row and a `cost-charged` event for the whole turn cap (`AFFIDAVIT_TURN_MAX_USD`). Three failed attempts read as three spent turn caps.
- **Lane 3 side, done in L3-16:** `ModelCallError.cost` carries what a failed call spent when the runtime reported it (a result arrived, or the provider refused the request with `invalid_request`, `rate_limit`, `billing_error` or `authentication_failed` before any token, which is not billed). It is undefined when the spend is unknown (any other class with no result, timeout, abort, broken stream, or a cost that is not a valid finite non-negative `StageCost`), and then the whole charge stands. The orchestrator puts the reported cost in its ledger and, when `OrchestratorDeps.settlement` is wired, calls `settlement.release(caseId, refund, reservationSeq)` with the unspent part. `refund` is a `StageCost` with non-negative fields for the failed call's stage and attempt; `reservationSeq` is the seq of the `cost-charged` event that recorded the charge. A failed release or overage charge never replaces the call error; it is attached as `settlementError` and the charge stays (over-counting, never under-counting). Success paths are unchanged.
- **Precise request to Lane 1 (`packages/db`, `apps/worker`), no contract change needed for the first step:**
  1. `packages/db`: a method on the Postgres case store, `releaseCharge(caseId, refund: StageCost, reservationSeq: number): Promise<BudgetState>`, that in one transaction adds `refund` back to `remaining_input_tokens`, `remaining_output_tokens` and `remaining_usd` (recomputing `exhausted`), and records the release so it applies at most once per `(tenant_id, case_id, reservationSeq)` (a unique key; a second call returns the current state and changes nothing). `cost_rows` cannot hold it today (`cost_rows_values_valid` requires `usd >= 0`), so either a `kind` column (`'charge' | 'release'`) with that check relaxed for releases, or a separate `cost_releases` table. Reports that sum `cost_rows` must subtract releases.
  2. `apps/worker/src/real/trial.ts`: pass `settlement: { release: (id, r, seq) => scope().store.releaseCharge(id, r, seq) }` to the `Orchestrator`.
- **Precise request to the lead (`packages/contracts`, additive, can follow):** `CaseStore.releaseCharge` as above, so fakes in `packages/testing` and every store implement it, and a `cost-released` `TrialEventType` with payload `{ cost: StageCost, remaining: BudgetState, reservationSeq: number }`, so the courtroom and CLI can show that a charge was given back. Until that event exists the orchestrator emits no event for a release, and the timeline still shows the up-front `cost-charged`.

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

## CR-T8: a counterexample that carries its own ParamSpace (L3-08)

- **Need:** a Prosecution counterexample is the family template run over a chosen ParamSpace (a subset of the Defense family's values, or new values of a declared parameter). The Judge runs a counterexample over the ParamSpace of the witness passed alongside it. `runCounterexample` can be given a carrier witness with the chosen space, but `verifyPatch(caseFile, patch, witness, counterexamples)` takes only `Exhibit[]` and one witness, so the chosen space has nowhere to travel.
- **Proposal (additive):** an optional `params: ParamSpace` on the counterexample exhibit, or `counterexamples: { exhibit, params }[]` in `verifyPatch`. Related: the `submit_counterexample` tool has no schema in `schemaRegistry` (the prompt's `outputSchemaRef` is `Exhibit`, but the agent submits parameter choices, not an Exhibit); a `CounterexampleChoices` schema would let the tool schema come from the contract.
- **Meanwhile:** the exhibit's first code line is a comment holding the canonical chosen ParamSpace, so the id and hash cover it, and `runCounterexample` gets a carrier witness (author `prosecution`) with that space. Until Lane 2's `verifyPatch` reads the header, it reruns counterexamples over the Defense family's space, so a new value is only exercised against the patch if the Judge honours the header.
- **Id mismatch:** the Judge mints a counterexample id from the params of the witness passed with it. In `verifyPatch` that is the Defense witness, so `VerifyResult.counterexamples[].exhibitId` may not equal the ids Prosecution computed from its carrier witness. Remedy accepts a patch only when the result names exactly the submitted ids, so a mismatch fails closed (patch not accepted). **CR-T8 is a prerequisite for L2-07.**

## CR-T9: judging a claim attack before a fix exists (L3-08)

- **Need:** the plan lets Prosecution attack the claim ("the witness tests the wrong thing", "the path is unreachable"). v1.0 gives `runCounterexample` one meaning (usable evidence: passes on vulnerable, fails on safe) and no result that says a counterexample undermines the witness, and `STAGE_TRANSITIONS` has no prosecution outcome that depends on it.
- **Proposal:** a documented `ExhibitResult` meaning, or a field, for "this counterexample weakens the witness", and a rule for what the case does then.
- **Meanwhile:** Prosecution always advances to remedy. Admissible counterexamples are carried to `verifyPatch`; a claim attack has no separate outcome.

## CR-T10: how an SSE client says where to resume (L3-10)

- **Need:** contracts v1.0 says only that `seq` is "monotonic per case" and that "SSE resumes from the last seq seen". It does not say how the client sends that position (the `Last-Event-ID` header, a query parameter such as `?after=`, or both), what the SSE `id:` field carries, or whether seqs are contiguous per case. The web client needs all three to resume and to tell a gap from a normal jump.
- **Proposal (documentation, or additive on `ApiRoutes.caseEvents`):** state that each message sets `id:` to the event `seq`, that the server honours `Last-Event-ID` (and optionally a named query parameter) by sending only seqs greater than it, and that seqs are contiguous per case starting at 0.
- **Meanwhile:** `apps/web` has no default wire format. `createSseTransport` takes an optional `applyResume(request, afterSeq)` hook. Without it every reconnect replays from the start and the client drops seqs it already applied, so the docket stays correct but each reconnect re-sends the whole stream. The client treats a seq that is not exactly last+1 (or a first event that is not 0) as a gap and reconnects from the last applied seq. If the server may legitimately skip seqs, that rule needs to change.

## CR-T11: a fixture schema for recorded model outputs (L3-15)

- **Need:** record mode writes `fixtures/models/<prompt id>/<input sha256>.json`. The fixture check in `packages/testing` (`fixtures.test.ts`) fails any fixture path it has no schema for, so the first recording committed under `fixtures/models/` turns that suite red.
- **Proposal (lead, additive):** a `ModelRecording` schema in contracts (`schemaVersion: 1`, `promptId: PromptId`, `promptVersion`, `model`, `inputSha256`, `userSha256`, `result: { outcome, submission?, cost: StageCost }`), mapped to `models/` in `schemaForFixture`.
- **Meanwhile:** the shape is defined and checked on read in `packages/trial/src/model/recordings.ts`. No recordings are committed in this PR.

## CR-T12: say why a case halted (L3-15, not blocking)

- **Need:** a case now halts for two reasons, `kill-switch` and `model-unconfigured` (no API key, checked before any charge). Neither leaves an event, so the live UI cannot tell an operator why a case stopped. `ModelPort` also has no way to refuse a call before the orchestrator charges for it.
- **Proposal (additive):** a `halted` `TrialEventType` with `{ reason: 'kill-switch' | 'model-unconfigured' }`, and an optional `preflight(req): Promise<void>` on `ModelPort`.
- **Meanwhile:** the halt reason is only in `RunOutcome` (`HaltReason` in `packages/trial`). The real port has `preflight` as a Lane 3 extension (`PreflightModelPort`); the orchestrator calls it when present, so fakes without it are unchanged.

## CR-T13: what a model safety refusal does to a case (L3-18, lead decision)

- **Need:** the real port reports a usage policy refusal (`stop_reason: "refusal"`) as `ModelCallError` with `provider.errorClass` `refusal` and an allowlisted `refusalCategory` (`cyber`, `bio`, `chem`, `csam`, `frontier_llm`, `reasoning_extraction`, or `other`). The orchestrator treats it like any other call error: the job fails, the queue retries the stage (charging the turn up front again each time), and after `AFFIDAVIT_MAX_STAGE_ATTEMPTS` the stage is flagged for review. Nothing in `packages/trial` retries or escalates a refusal on its own. The same input is likely refused again, so those retries mostly spend budget.
- **Decision for the lead:** should a refusal of the first Defense attempt go to the second Defense attempt (a different model and prompt, as F3 already allows), or straight to human review? Either way, a refusal must never dismiss a candidate, and never a high-arraignment-score candidate: it says nothing about whether the finding is real.
- **Proposal (once decided):** a Lane 3 change in `defense.ts` that recognises a `ModelCallError` of class `refusal` and routes it as decided (no contract change for the second-attempt option). For straight-to-review, an additive escalation reason such as `model-refused` in contracts, so the docket says why.
- **Meanwhile:** a refusal is a plain call error: retried, then flagged for review. It is never dismissed.
- **P7 findings (L3-18 probe on the lead's key):** the provider's safeguards refuse the real Defense request on `claude-opus-5-5` (the table's Defense model): `stop_reason: "refusal"`, category `cyber`. The input was `fixtures/casefiles/nodegoat-nosqli-where-001.json` through the real `defenseBlocks` and the packaged Defense prompt. Evidence summary:
  - The runtime reports the refusal as `invalid_request`, which is what the worker saw, and then falls back to `claude-opus-5` on its own. The port now classifies the first as `refusal` and fails the turn on the second (a fallback is never accepted as the table's model).
  - The candidate block alone (615 bytes, no code slices) is refused, and so are the code slices alone.
  - A trivial synthetic envelope with the same packaged prompt and the same worker budget passes, so the request shape, the budget mapping and record mode are not the cause. The content of this case, or the task the Defense prompt asks for on it, is what is declined.
- **What P8 will show (L3-19, `--model-matrix`, not yet run):** the same real Defense input on every distinct model id in the table (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`), the Defense second-attempt prompt on its table model (`claude-sonnet-5-5`) with that input, and `claude-fable-5-2` as a labelled extra that may fail as model not found. For each: refused or not, category, whether the runtime fell back to another model, and the submission outcome. Prosecution, Remedy and the jurors are not probed, since their real input needs an admitted Defense witness (and the jury has no stage yet); the report says so. P8 changes no behaviour.
- **Questions for the lead, once P8 has run:**
  1. Route a refusal of the first Defense attempt to the second Defense attempt on another model (no contract change; only sensible if P8 shows the second-attempt model answers this input)?
  2. Send it straight to human review, with an additive escalation reason such as `model-refused` in contracts so the docket says why?
  3. Keep today's behaviour (a plain call error, retried by the queue, then flagged for review), accepting that the retries spend budget on a request that is refused again?
  4. Apply for the provider's verification program for security research use, so the safeguards can be adjusted for this organization? This is a provider-side process the lead owns; it does not replace one of the routes above while it is pending.
     Whatever is chosen, a refusal never dismisses a candidate, least of all a high-arraignment-score one, and the port never retries it on the same model.
