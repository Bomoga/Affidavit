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

   | Variable                                | Meaning                                                                                                                                                   | Default              |
   | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
   | `AFFIDAVIT_MODEL_TIMEOUT_MS`            | Wall-clock cap per agent turn (1000 to 3600000)                                                                                                           | 300000 (placeholder) |
   | `AFFIDAVIT_RECORD_DIR`                  | Where record mode writes. Required for `record`; record refuses to start without it                                                                       | none                 |
   | `AFFIDAVIT_MODEL_FIXTURES_DIR`          | Where replay reads                                                                                                                                        | `fixtures/models/`   |
   | `AFFIDAVIT_ENV`                         | Deployment environment. `record` and `replay` start only when it is `development` or `test` (trimmed, any case). Unset or anything else means `live` only | none                 |
   | `AFFIDAVIT_RECORD_ALLOW_SECRETS`        | `1` records a submission verbatim even when it holds credential-shaped text (see Record and replay)                                                       | unset                |
   | `AFFIDAVIT_MODEL_CONFIG`                | JSON file `{ "models": { "<prompt id>": "<model id>" } }`                                                                                                 | none                 |
   | `ANTHROPIC_MODEL_DEFENSE`               | Model for prompt `defense`                                                                                                                                | `claude-opus-5-5`    |
   | `ANTHROPIC_MODEL_DEFENSE_SECOND`        | Model for `defense-second-attempt`                                                                                                                        | `claude-sonnet-5-5`  |
   | `ANTHROPIC_MODEL_PROSECUTION`           | Model for `prosecution`                                                                                                                                   | `claude-opus-5-5`    |
   | `ANTHROPIC_MODEL_REMEDY`                | Model for `remedy`                                                                                                                                        | `claude-opus-5-5`    |
   | `ANTHROPIC_MODEL_JUROR_SECURITY`        | Model for `juror-security`                                                                                                                                | `claude-opus-5-5`    |
   | `ANTHROPIC_MODEL_JUROR_MAINTAINABILITY` | Model for `juror-maintainability`                                                                                                                         | `claude-sonnet-5-5`  |
   | `ANTHROPIC_MODEL_JUROR_BLAST_RADIUS`    | Model for `juror-blast-radius`                                                                                                                            | `claude-haiku-5-5`   |

   Precedence is defaults, then the config file, then the per-prompt variables. The table is checked at startup: an id not in `KNOWN_MODEL_IDS` fails closed, both Defense attempts on one model fails (F3), and two jurors on one model fails (F4). The defaults are starting choices, not tuned ones.

**Wiring status.** `apps/worker` (Lane 1) still throws `NotWiredError` for `AFFIDAVIT_TRIAL_IMPL=real`. Wiring is one call in the composition root, `createModelPortFromEnv(process.env, { killSwitch })`, passed as the orchestrator's `model`, and each handler's `model` taken from `modelFor(resolveModelTable(process.env), promptId)`. That change is in Lane 1's paths, so it is not in this PR.

## What the agent gets

One turn is one Agent SDK session that can only call its role's submit tool.

- `allowedTools` is exactly the role's allowlist from `ROLE_TOOLS`, as `mcp__affidavit__submit_*`. Each advertised input field is its contract schema (`WitnessSubmission`, `PatchSubmission`, the ballot options, and `ParamSpace` for counterexamples until CR-T8) or any JSON value, and optional, so a runtime that validates input before hooks can never bounce a malformed call back for a retry. The orchestrator checks the contract schema afterwards.
- The submit server and each submit tool set `alwaysLoad: true`, so the tools are never deferred behind tool search. With `tools: []` there is no search tool, so a deferred submit tool could never be found.
- `tools: []` removes every built-in tool; `disallowedTools` names them again (every tool input type in the SDK 0.3.318 `sdk-tools.d.ts`, plus `PowerShell`, `ToolSearch`, `SendMessage`, `TaskOutput` and the other runtime tools). `permissionMode: 'dontAsk'`, so anything not pre-approved is denied and nothing prompts.
- The only tool server is the in-process submit server; `strictMcpConfig` ignores every other MCP configuration. No skills, plugins, or subagents.
- `settingSources: []`, and the cwd is a fresh empty temp directory (removed afterwards) that is also the agent's home, config, and temp directory, so no settings, memory, or CLAUDE.md from a repo or a user can load.
- **The worker image must contain no managed-settings file** (for example `/etc/claude-code/managed-settings.json` on Linux, `/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, `C:\Program Files\ClaudeCode\managed-settings.json` on Windows). `settingSources: []` does not stop the runtime reading managed (policy) settings, and such a file could add tools, hooks, MCP servers or permissions. The image build should check that the path is absent.
- The system prompt must equal the packaged prompt for that id and version, or the call is refused. Case content goes only in the user message, inside the untrusted wrapper.
- The first submit call is captured exactly as sent and ends the turn, on every path: the PreToolUse hook captures it and stops; if a runtime bounced it on validation before PreToolUse, the PostToolUseFailure hook captures the raw input and stops; if the handler ran, PostToolUse stops. A later call never replaces it. Malformed output reaches the orchestrator and is recorded as `exhibit-inadmissible` (rule `schema`), not retried.
- The submission is never rewritten. The Judge must run the witness the agent submitted, and the exhibit must match it byte for byte, so a witness containing `Authorization: Bearer ...` or `?token=...` passes through unchanged. Only the exact key value is checked: a submission containing it throws `ModelCallError` and is neither returned nor recorded.

## Key handling

The key is read from `ANTHROPIC_API_KEY` on every call and goes only into the agent process environment. Every error, log line, and recorded field other than the submission is scrubbed of the key by value, of anything shaped like an Anthropic key, and of the values of credential headers, assignments and URL parameters (`x-api-key`, `Authorization: Bearer`, `ANTHROPIC_API_KEY=`, `?key=`). Text is always redacted whole before it is shortened, so a key cut by a length limit cannot leave a fragment behind. A missing key throws `ModelUnconfiguredError` (code `model-unconfigured`) from the port's `preflight`, which the orchestrator calls before it charges the turn's budget, so the case halts with `{ status: 'halted', reason: 'model-unconfigured' }`, nothing charged, nothing escalated. A key the provider rejects also halts the case, but after the charge, since the call was made.

## Budgets and caps

The orchestrator still charges the whole turn budget before the call. The port also passes `maxTurns` and `maxBudgetUsd` to the SDK, aborts mid-turn when streamed token usage passes the token budget, enforces the wall-clock cap, and polls the kill switch (`abortAll()` aborts every turn in flight). Usage and cost come back from the SDK result. When a turn is cut off before a result arrives, the cost is reported as the whole turn budget, because the real figure is unknown.

Provider failures throw `ModelCallError`, never "no submission" or "turn cap", unless the agent had already submitted: a wall-clock timeout, an abort, a hung stream (the port stops waiting at the cap even if the stream ignores the abort), a transport error, a stream with no result, an execution error, or any assistant `error` code from the provider (`overloaded`, `rate_limit`, `server_error`, `billing_error`, `max_output_tokens` and the rest; `authentication_failed` is `model-unconfigured` instead), whatever the result's `is_error` says. Only an agent that used all its turns without submitting is `turn-cap`, and only a clean finish without a submission is `no-submission`. So an outage can never dismiss a candidate (F3).

## Record and replay

- `live`: real calls, nothing written. The only mode allowed unless `AFFIDAVIT_ENV` is `development` or `test`.
- `record`: real calls, and each result is written to `$AFFIDAVIT_RECORD_DIR/<prompt id>/<input sha256>.json`. Record refuses to start without an explicit `AFFIDAVIT_RECORD_DIR` (there is no default) or outside development and test. A witness can quote credentials from the target repo (a hardcoded JWT, a cloud key). The submission is never rewritten, so a submission holding credential-shaped text is not recorded. One pattern set in `redact.ts` serves logs, errors and this check: Anthropic and OpenAI keys, AWS access key ids and secret keys next to `aws`, GitHub tokens, Slack tokens (`xox*-`, `xapp-`) and webhook URLs, Stripe secret, restricted and live publishable keys, Google API keys and `GOCSPX-` secrets, npm tokens, JWTs, PEM private key blocks, `scheme://user:pass@` URLs, bearer and auth headers, credential query parameters, and `password`, `secret`, `token`, `api_key` or `authorization` assigned a literal (quoted, 8+ characters; or unquoted, 6+ characters with a digit or symbol). Values that are code or placeholders are not flagged: `password = req.body.password`, `$TOKEN`, `'Bearer ' + token`, `{{token}}`, `"${PASSWORD}"`. The scan is linear-time, since repo content can shape the text: every pattern starts at a literal prefix with bounded repetitions and no backtracking through a body. No bound fails open: bearer, key header and query values are consumed to the end of their run, a quoted value longer than 256 characters is still a credential, a PEM block without END is redacted line by line through the next blank line or the end of the text, and JWTs and `user:pass@` URLs of any length are matched as atomic runs (a JWT match starts only where a base64url run starts). A `$` inside a quoted value counts; only a leading `$` marks a placeholder. Strings over 256 KB are scanned in 64 KB windows overlapping by 8 KB, and a scan past its 2 s work budget refuses the recording with a generic message (a log line or error over 256 KB, or past the budget, becomes `[redacted: oversized]`). A submission with credential-shaped text: the turn throws `ModelCallError`, with a message that names no value. Set `AFFIDAVIT_RECORD_ALLOW_SECRETS=1` to record it verbatim, and only for recordings you will not commit, or after review. If you scrub such a recording by hand before committing, add `"redacted": true` at the top level: replay then throws `JudgeIneligibleRecordingError` (a `ModelCallError`) instead of handing an altered witness to the Judge. A recording holds only the prompt id, version, model, input hashes, and the result (outcome, submission exactly as sent, redacted cost). Never the key, never request headers, never the request text. To add recordings to the repo, set `AFFIDAVIT_RECORD_DIR=fixtures/models` deliberately.
- `replay`: no key, no network, only in development or test. Reads `AFFIDAVIT_MODEL_FIXTURES_DIR` (default `fixtures/models/`). A request is served only if a recording matches its prompt id and its input hash (prompt version, model, system text, user content, tools, schema, turn cap, budget). Anything else throws `NoModelRecordingError`.

Recorded files are not yet mapped in the `packages/testing` fixture check, so recording into `fixtures/models/` makes that suite fail until CR-T11 lands.

## Not verified

Every test uses a stubbed transport; no test reaches the network. Whether the runtime validates tool input before PreToolUse is not stated in the SDK 0.3.318 types, so the port is built to be terminal either way, and a test stub mimics a validating runtime. The live path (the SDK honouring the hook's stop, cost fields on a real result, the bundled runtime's behavior with an empty home) has not run against the API yet. The first real run should be one gate case in `record` mode with a small budget, then a `replay` of it. Cost per verdict stays [metric] until then.
