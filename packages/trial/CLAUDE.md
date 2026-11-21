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
```

**Set a monthly spend limit on the key in the Anthropic Console before the first run.** The per-case budget is a second guard, not the only one. Optional: `AFFIDAVIT_MODEL_TIMEOUT_MS`, `AFFIDAVIT_MODEL_FIXTURES_DIR`, `AFFIDAVIT_MODEL_CONFIG`, and one `ANTHROPIC_MODEL_<PROMPT>` per prompt id (see the guide).

Invariants, each covered by a test in `src/model/anthropic.test.ts` with a stubbed transport (no test touches the network):

- `allowedTools` is exactly the role's submit tools; `tools: []`, `permissionMode: 'dontAsk'`, no other MCP config, no setting sources, empty throwaway cwd and home.
- The key is read from `ANTHROPIC_API_KEY` on each call and never appears in an error, log, result, event, or recording.
- A missing key throws `ModelUnconfiguredError` from `preflight`, before the orchestrator charges; the run halts with reason `model-unconfigured`.
- Unknown model ids, a model that does not match the table, or a system prompt that is not the packaged one fail closed before any call.
- The first submission is captured raw and ends the turn; a malformed one becomes `exhibit-inadmissible`, never a silent retry.
- Provider failures throw `ModelCallError`, never "no submission", so an outage cannot dismiss a candidate.

## Intended libraries (notes for later, not installed yet)

- Graphile Worker
- @affidavit/contracts and @affidavit/judge (workspace deps)

Root CLAUDE.md rules apply here. Do not add dependencies without asking.
