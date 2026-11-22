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

## Real model port (L3-15)

`src/model/` holds `AnthropicModelPort`, the real `ModelPort` on `@anthropic-ai/claude-agent-sdk` 0.3.318. Full guide: `docs/lanes/lane3/model-port.md`.

To turn it on (the composition root in apps/worker still has to call `createModelPortFromEnv`; that wiring is Lane 1's):

```sh
# >>> API KEY GOES HERE, from the shared secrets store. Never commit it or write it to a file in the repo. <<<
export ANTHROPIC_API_KEY="<from the secrets store>"
export AFFIDAVIT_TRIAL_IMPL=real
export AFFIDAVIT_MODEL_MODE=live   # or record, or replay (no key needed)
# record also needs an explicit output dir; there is no default:
# export AFFIDAVIT_RECORD_DIR=fixtures/models
```

Record and replay start only when `AFFIDAVIT_ENV` is `development` or `test` (trimmed, any case); unset or anything else means live only. Record refuses a submission holding credential-shaped text unless `AFFIDAVIT_RECORD_ALLOW_SECRETS=1`; a recording marked `redacted: true` is never replayed to the Judge. The worker image must contain no Claude Code managed-settings file: `settingSources: []` still reads it.

**Set a monthly spend limit on the key in the Anthropic Console before the first run.** The per-case budget is a second guard, not the only one. Optional: `AFFIDAVIT_MODEL_TIMEOUT_MS`, `AFFIDAVIT_MODEL_FIXTURES_DIR`, `AFFIDAVIT_MODEL_CONFIG`, and one `ANTHROPIC_MODEL_<PROMPT>` per prompt id (see the guide).

Invariants, each covered by a test in `src/model/anthropic.test.ts` with a stubbed transport (no test touches the network):

- `allowedTools` is exactly the role's submit tools; `tools: []`, `permissionMode: 'dontAsk'`, no other MCP config, no setting sources, empty throwaway cwd and home.
- The key is read from `ANTHROPIC_API_KEY` on each call and never appears in an error, log, result, event, or recording.
- A missing key throws `ModelUnconfiguredError` from `preflight`, before the orchestrator charges; the run halts with reason `model-unconfigured`.
- Unknown model ids, a model that does not match the table, or a system prompt that is not the packaged one fail closed before any call.
- Submit tools are `alwaysLoad`, and their advertised schemas accept any JSON per field, so a validating runtime cannot bounce a call.
- The first submission is captured raw and ends the turn (PreToolUse, PostToolUseFailure or PostToolUse, whichever the runtime reaches); a malformed one becomes `exhibit-inadmissible`, never a silent retry.
- Submissions are never rewritten or pattern-redacted. One containing the exact key value throws `ModelCallError` and is not recorded.
- Provider failures (timeout, abort, hung or broken stream, no result, any assistant `error` code other than `authentication_failed`) throw `ModelCallError` unless the agent already submitted; only an agent that used its turns is `turn-cap`. An outage cannot dismiss a candidate.
- A provider error always carries its class and HTTP status. Provider text is shown only as fragments rebuilt from the allowlisted `TEMPLATES` in `anthropic.ts` (after JSON decoding and redaction), capped at 300 characters; anything else is `provider message withheld (does not match a known-safe shape)` (`provider-errors.test.ts`). A key that is not printable ASCII without spaces fails `preflight` before any charge.
- `ModelCallError.cost` is the reported spend of a failed call, or undefined when unknown. Zero without a result only for classes decided before any work (`REFUSED_BEFORE_WORK`). The orchestrator trusts it only when it is a valid finite non-negative `StageCost`. Unknown spend keeps the whole charge.

## Cost settlement and halts (L3-21, contracts v1.2)

Tests: `src/orchestrator-settlement.test.ts` and the settlement block of `src/model/provider-errors.test.ts`, on `FakeCaseStore({ events })` so a release against the wrong seq is refused.

- Each model call is charged its whole turn budget up front (unchanged; the budget bounds spend). After the call the reservation is settled per field against the reported spend: overspent fields are charged on top, the unspent rest is released with a `cost-released` event (reason `reservation-unspent` on success, `model-call-failed` on a failed call with known spend). Release goes through `settlement`, else `store.releaseCharge`, else nowhere (charge stands).
- A release that throws emits nothing; on a failed call it is `settlementError` and never replaces the call error; on a success it does not fail the call. Each reservation seq is released once.
- `Verdict.cost` and `ctx.costs()`: one row per call, its charges minus its releases, so the verdict equals a replay of the stream.
- `halted` (actor stenographer, current stage, no stage move) for `kill-switch`, `model-unconfigured`, `model-refusal` (unrouted refusal, allowlisted `refusalCategory`, never dismissed) and `budget-exhausted` (before, never instead of, the `budget-exhausted` escalation). Detail is fixed text only. The same halt at the same stage is recorded once per case per instance, not on every rerun.
- `config.killSwitch` is only the real kill switch. `config.stopAfterTransition` (optional) ends a run quietly after a stage's `stage-entered` (after the terminal check), returning `{ status: 'stopped' }` with no event; it is read only after a transition this run made. The worker should use it for "one stage per job".
- The reservation seq is what the sink's `emit` returns (seq or stored event). Once a sink has reported a seq for a case, a missing one means the event was dropped (not noted), and a `stage-entered` at or below the last seq is the dropped duplicate. The parsed seq is used only for a sink that never reports one, and a `stage-entered` that is an instance's first event for a case is not noted (a restarted worker's dropped duplicate carries the store's placeholder). Any other seq that is not strictly increasing means nothing more is released for the case.
- An invalid `result.cost` on success is unknown spend (no release). Refunds are capped at the reservation here. The port never reports an unknown USD or token figure as zero (`tokenField` in `anthropic.ts`; a field missing from the result and from a partial stream gets the turn cap).
- Per-case state (`released`, `haltedAt`, `seqs`, ledgers, run infos, dismissals, seen exhibits) is dropped when the case reaches a terminal stage.

## Model probe (L3-17)

`scripts/probe-model.ts` (logic in `src/model/probe.ts`) is a human-run diagnostic: tiny live calls with synthetic input only, raw provider text shown after key redaction. Nothing in the trial imports it. It reuses `buildAgentOptions` from `anthropic.ts`, so keep the port's options built there. See the guide, "Probing a provider error". L3-18 adds opt-in P7 (`--fixture-case`, only a file directly in `fixtures/casefiles/`): the worker's Defense turn replayed through `defenseBlocks` from `defense.ts`, so keep the Defense user message built there.

A model safety refusal (`stop_reason: "refusal"`, which the runtime reports as `invalid_request`) is class `refusal` (`REFUSAL_CLASS`) with an allowlisted category (else `other`), never zero spend, and never returns a submission. A runtime fallback to another model, or any assistant message from a model other than the requested one (`model_mismatch`), fails the turn (`provider-errors.test.ts`). What a refusal does to a case is decided (CR-T13, L3-20): see "Defense after a refusal" below. `--fixture-case` also requires a checked-in, unmodified file (git).

L3-19 adds opt-in P8 (`--model-matrix`, needs `--fixture-case`): the P7a input on every distinct table model, the second-attempt prompt on its model, and `claude-fable-5-2` as a labelled extra, each through the real port with a probe-only model table. Measurement only; Prosecution, Remedy and jurors are reported as SKIP because their input needs earlier-stage artifacts.

## Defense after a refusal (L3-20, CR-T13)

Lead decision 2026-11-21 (route to the second attempt), superseded by the P8 evidence (opus, sonnet, fable refused, haiku passed): `review` is the default, `second-attempt` opt-in. Tests in `src/defense.test.ts` ("Defense after a provider refusal" and `refusalRouteFromEnv`).

- A `ModelCallError` of class `refusal` (`isModelRefusal` in `src/model/errors.ts`) ends the Defense attempt it hit. The refused model is never asked again in that stage run. A refusal never dismisses.
- `DefenseConfig.refusalRoute`, from `AFFIDAVIT_REFUSAL_ROUTE` via `refusalRouteFromEnv` (unset or blank is `review`; any other value than `review` or `second-attempt` throws). The worker does not pass it yet, so it gets `review`; the Lane 1 wiring note is in CR-T13.
- `review` (default): a refused first attempt makes no further model call and goes to review. `second-attempt` (opt-in): it goes once, at any score, to `config.second` with no first-attempt feedback (Judge feedback from the refused attempt is dropped). P8 found the default second-attempt model refused the same input, so `second-attempt` only helps with another table.
- A refused second attempt never starts a third and goes to review. Review at or above the floor: escalate `no-admissible-witness-above-floor`, refusals named in the detail. Below the floor: Defense throws `DefenseRefusedError` (class `refusal`) and the orchestrator halts the case (L3-21): `halted` with reason `model-refusal` and the last refusal's category, case left at `defense`, `run` returns `halted`. Known gap, not closed yet: the worker turns a halt that did not move the case into the retryable `TrialHaltedError` (worded as the kill switch), and recovery retries it up to `AFFIDAVIT_MAX_STAGE_ATTEMPTS`, rerunning Defense each time. It closes when the worker flags a `model-refusal` halt for review at once (Lane 1 note in CR-T13).
- No event type was added; the refusal is told in the escalation or dismissal detail, or in the thrown message (model id and a contract `RefusalCategory`, else `other`).
- Only refusals are caught. Kill switch, budget exhausted, unconfigured, config and other call errors pass through. The refused call's cost is settled by the orchestrator as the port reported it.

## Intended libraries (notes for later, not installed yet)

- Graphile Worker
- @affidavit/contracts and @affidavit/judge (workspace deps)

Root CLAUDE.md rules apply here. Do not add dependencies without asking.
