# Real model port (L3-15)

`AnthropicModelPort` in `packages/trial/src/model/` is the real `ModelPort`. It runs each agent turn on the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` 0.3.318, already pinned in the lockfile by P0-02; nothing new was installed). With it wired, the only thing a real trial still needs is an API key.

## Turning it on

1. The lead creates a dev key in the Anthropic Console organization for the product runtime (plan.md, Human prerequisites), **with a monthly spend limit set on that key in the Console before first use**. The per-case budget in the orchestrator is a second line of defense, not a replacement for the Console limit.
2. Put the key in the shared secrets store and export it in the worker's environment only:

   ```sh
   # >>> API KEY GOES HERE, from the secrets store. Never commit it, never paste it into a file in the repo. <<<
   export ANTHROPIC_API_KEY="<from the secrets store>"
   ```

3. Select the real trial implementation and the model mode:

   ```sh
   export AFFIDAVIT_TRIAL_IMPL=real
   export AFFIDAVIT_MODEL_MODE=live        # live | record | replay; default live
   ```

4. Optional settings:

   | Variable | Meaning | Default |
   | --- | --- | --- |
   | `AFFIDAVIT_MODEL_TIMEOUT_MS` | Wall-clock cap per agent turn (1000 to 3600000) | 300000 (placeholder) |
   | `AFFIDAVIT_MODEL_FIXTURES_DIR` | Where record writes and replay reads | `fixtures/models/` |
   | `AFFIDAVIT_MODEL_CONFIG` | JSON file `{ "models": { "<prompt id>": "<model id>" } }` | none |
   | `ANTHROPIC_MODEL_DEFENSE` | Model for prompt `defense` | `claude-opus-5-5` |
   | `ANTHROPIC_MODEL_DEFENSE_SECOND` | Model for `defense-second-attempt` | `claude-sonnet-5-5` |
   | `ANTHROPIC_MODEL_PROSECUTION` | Model for `prosecution` | `claude-opus-5-5` |
   | `ANTHROPIC_MODEL_REMEDY` | Model for `remedy` | `claude-opus-5-5` |
   | `ANTHROPIC_MODEL_JUROR_SECURITY` | Model for `juror-security` | `claude-opus-5-5` |
   | `ANTHROPIC_MODEL_JUROR_MAINTAINABILITY` | Model for `juror-maintainability` | `claude-sonnet-5-5` |
   | `ANTHROPIC_MODEL_JUROR_BLAST_RADIUS` | Model for `juror-blast-radius` | `claude-haiku-5-5` |

   Precedence is defaults, then the config file, then the per-prompt variables. The table is checked at startup: an id not in `KNOWN_MODEL_IDS` fails closed, both Defense attempts on one model fails (F3), and two jurors on one model fails (F4). The defaults are starting choices, not tuned ones.

**Wiring status.** `apps/worker` (Lane 1) still throws `NotWiredError` for `AFFIDAVIT_TRIAL_IMPL=real`. Wiring is one call in the composition root, `createModelPortFromEnv(process.env, { killSwitch })`, passed as the orchestrator's `model`, and each handler's `model` taken from `modelFor(resolveModelTable(process.env), promptId)`. That change is in Lane 1's paths, so it is not in this PR.

## What the agent gets

One turn is one Agent SDK session that can only call its role's submit tool.

- `allowedTools` is exactly the role's allowlist from `ROLE_TOOLS`, as `mcp__affidavit__submit_*`. The tool input schemas come from the contract shapes (`WitnessSubmission`, `PatchSubmission`, the ballot options, and `ParamSpace` for counterexamples until CR-T8).
- `tools: []` removes every built-in tool; `disallowedTools` names them again. `permissionMode: 'dontAsk'`, so anything not pre-approved is denied and nothing prompts.
- The only tool server is the in-process submit server; `strictMcpConfig` ignores every other MCP configuration. No skills, plugins, or subagents.
- `settingSources: []`, and the cwd is a fresh empty temp directory (removed afterwards) that is also the agent's home, config, and temp directory, so no settings, memory, or CLAUDE.md from a repo or a user can load.
- The system prompt must equal the packaged prompt for that id and version, or the call is refused. Case content goes only in the user message, inside the untrusted wrapper.
- The first submit call is captured exactly as sent, before validation, and ends the turn. A later call never replaces it. Malformed output reaches the orchestrator and is recorded as `exhibit-inadmissible` (rule `schema`), not retried.

## Key handling

The key is read from `ANTHROPIC_API_KEY` on every call and goes only into the agent process environment. Every error, log line, returned submission, and recording is scrubbed of the key by value and of anything shaped like an Anthropic key. A missing key throws `ModelUnconfiguredError` (code `model-unconfigured`) from the port's `preflight`, which the orchestrator calls before it charges the turn's budget, so the case halts with `{ status: 'halted', reason: 'model-unconfigured' }`, nothing charged, nothing escalated. A key the provider rejects also halts the case, but after the charge, since the call was made.

## Budgets and caps

The orchestrator still charges the whole turn budget before the call. The port also passes `maxTurns` and `maxBudgetUsd` to the SDK, aborts mid-turn when streamed token usage passes the token budget, enforces the wall-clock cap, and polls the kill switch (`abortAll()` aborts every turn in flight). Usage and cost come back from the SDK result. When a turn is cut off before a result arrives, the cost is reported as the whole turn budget, because the real figure is unknown.

Provider errors and crashed agent processes throw `ModelCallError`, never "no submission", so an outage cannot dismiss a candidate (F3).

## Record and replay

- `live`: real calls, nothing written.
- `record`: real calls, and each result is written to `fixtures/models/<prompt id>/<input sha256>.json`. A recording holds only the prompt id, version, model, input hashes, and the redacted result (outcome, submission, cost). Never the key, never request headers, never the request text.
- `replay`: no key, no network. A request is served only if a recording matches its prompt id and its input hash (prompt version, model, system text, user content, tools, schema, turn cap, budget). Anything else throws `NoModelRecordingError`.

Recorded files are not yet mapped in the `packages/testing` fixture check, so recording into `fixtures/models/` makes that suite fail until CR-T11 lands.

## Not verified

Every test uses a stubbed transport; no test reaches the network. The live path (the SDK honouring the hook's stop, cost fields on a real result, the bundled runtime's behavior with an empty home) has not run against the API yet. The first real run should be one gate case in `record` mode with a small budget, then a `replay` of it. Cost per verdict stays [metric] until then.
