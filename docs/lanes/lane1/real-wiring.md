# Real wiring runbook (L1-10b)

How to run `apps/worker` with real stages: real discovery for intake, map and arraign, the real
trial orchestrator on the real model port, and the real Judge on the gVisor witness jail. The
worker is the composition root; everything here is configuration. Every value below is a
placeholder. Never put a real secret in this file, a commit, a shell history file or an issue.

## What each switch turns on

| Switch                       | `real` means                                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AFFIDAVIT_INTAKE_IMPL=real` | intake, map and arraign run `discoverCase` (`packages/discovery/src/pipeline`) on the case's pinned repo and commit, and refuse to go on unless it reproduces the stored case file. |
| `AFFIDAVIT_TRIAL_IMPL=real`  | defense, prosecution, remedy and verify run `@affidavit/trial`'s `Orchestrator` and handlers on `createModelPortFromEnv`. The jury must be off (no jury handler yet, L3-11).        |
| `AFFIDAVIT_JUDGE_IMPL=real`  | the Judge is `Judge(JailExecutor, DEFAULT_POLICY)` from `@affidavit/judge`, with the evidence store and the signer socket checked at startup.                                       |

Each switch is independent. Unset or `fake` keeps the scripted fake for that part.

## Startup refuses, it never half starts

`loadConfig` lists every missing or malformed variable in one `ConfigError`. Then `prepareCores`
checks the host (`checkPrerequisites`) and lists every missing fact in one `PrerequisiteError`,
before any database connection is opened. Messages name variables and host facts, never values:
a database URL, a repository source or a key never appears in an error or in `describeConfig`.

## Environment variables

Required means required when the switch in the "For" column is `real`.

### Always

| Name                               | Purpose                                                   | Required | Example placeholder                                                |
| ---------------------------------- | --------------------------------------------------------- | -------- | ------------------------------------------------------------------ |
| `AFFIDAVIT_APP_DATABASE_URL`       | `affidavit_app` role URL                                  | yes      | `postgres://affidavit_app:<generated>@127.0.0.1:5432/affidavit`    |
| `AFFIDAVIT_WORKER_DATABASE_URL`    | `affidavit_worker` role URL                               | yes      | `postgres://affidavit_worker:<generated>@127.0.0.1:5432/affidavit` |
| `AFFIDAVIT_INTAKE_IMPL`            | `fake` or `real`                                          | no       | `real`                                                             |
| `AFFIDAVIT_TRIAL_IMPL`             | `fake` or `real`                                          | no       | `real`                                                             |
| `AFFIDAVIT_JUDGE_IMPL`             | `fake` or `real`                                          | no       | `real`                                                             |
| `AFFIDAVIT_JURY_ENABLED`           | `true` or `false`; must be `false` with trial `real`      | no       | `false`                                                            |
| `AFFIDAVIT_LEASE_SECONDS`          | stage lease (default 300)                                 | no       | `300`                                                              |
| `AFFIDAVIT_STALE_LOCK_SECONDS`     | when a dead attempt is retried (default lease + 60)       | no       | `360`                                                              |
| `AFFIDAVIT_RECONCILE_INTERVAL_MS`  | recovery pass interval (default 30000)                    | no       | `30000`                                                            |
| `AFFIDAVIT_POLL_INTERVAL_MS`       | queue poll interval (default 1000)                        | no       | `1000`                                                             |
| `AFFIDAVIT_CONCURRENCY`            | parallel stage jobs (default 4)                           | no       | `1`                                                                |
| `AFFIDAVIT_MAX_STAGE_ATTEMPTS`     | attempts per stage visit before a review flag (default 3) | no       | `3`                                                                |
| `AFFIDAVIT_CASE_MAX_INPUT_TOKENS`  | case budget for `open-case` (default 1000000)             | no       | `1000000`                                                          |
| `AFFIDAVIT_CASE_MAX_OUTPUT_TOKENS` | case budget for `open-case` (default 100000)              | no       | `100000`                                                           |
| `AFFIDAVIT_CASE_MAX_USD`           | case budget for `open-case` (default 10)                  | no       | `10`                                                               |

### For intake `real`

| Name                                  | Purpose                                                                                              | Required | Example placeholder                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------ |
| `AFFIDAVIT_INTAKE_WORK_ROOT`          | absolute, existing directory for per-run discovery workspaces (each run gets its own and removes it) | yes      | `/srv/affidavit/intake`                                      |
| `AFFIDAVIT_REPO_SOURCES`              | JSON object from repository id to clone URL or local path; ids are logged, sources never are         | yes      | `{"OWASP/NodeGoat":"https://github.com/OWASP/NodeGoat.git"}` |
| `AFFIDAVIT_INTAKE_ALLOW_LOCAL_SOURCE` | `true` lets a source be a local path (testing)                                                       | no       | `false`                                                      |
| `AFFIDAVIT_TOOLRUNNER`                | `gvisor` (Lane 2 `GvisorToolRunner`) or `docker` (plain local Docker, default)                       | no       | `gvisor`                                                     |
| `AFFIDAVIT_TOOL_TIMEOUT_MS`           | per scanner run (default 600000)                                                                     | no       | `600000`                                                     |
| `AFFIDAVIT_ESCALATION_FLOOR`          | F3 floor, read by discovery's `arraignConfigFrom`                                                    | no       | (discovery default)                                          |
| `AFFIDAVIT_DISMISS_BELOW`             | dismissal threshold, read by `arraignConfigFrom`                                                     | no       | (discovery default)                                          |

### For trial `real`

| Name                                                 | Purpose                                                                                                                                        | Required       | Example placeholder         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------------------------- |
| `ANTHROPIC_API_KEY`                                  | read by the model port on every call. Unset: every trial stage halts (`model-unconfigured`) with no charge, and startup logs the variable name | for a live run | `<from the secrets store>`  |
| `AFFIDAVIT_MODEL_MODE`                               | `live` (default), `record` or `replay` (`record` and `replay` need `AFFIDAVIT_ENV`)                                                            | no             | `live`                      |
| `AFFIDAVIT_ENV`                                      | `development` or `test` to allow record or replay                                                                                              | no             | `development`               |
| `AFFIDAVIT_RECORD_DIR`                               | where record mode writes                                                                                                                       | record         | `/srv/affidavit/recordings` |
| `AFFIDAVIT_MODEL_FIXTURES_DIR`                       | where replay reads                                                                                                                             | no             | `fixtures/models`           |
| `AFFIDAVIT_MODEL_TIMEOUT_MS`                         | per turn (default 300000)                                                                                                                      | no             | `300000`                    |
| `AFFIDAVIT_MODEL_CONFIG`, `ANTHROPIC_MODEL_<PROMPT>` | model table overrides (`docs/lanes/lane3/model-port.md`)                                                                                       | no             | (Lane 3 defaults)           |
| `AFFIDAVIT_KILL_SWITCH`                              | `on` halts every trial stage at its next check                                                                                                 | no             | `off`                       |
| `AFFIDAVIT_KILL_SWITCH_FILE`                         | absolute path; while the file exists, the kill switch is on                                                                                    | no             | `/run/affidavit/kill`       |
| `AFFIDAVIT_TURN_MAX_INPUT_TOKENS`                    | per agent turn (default 100000)                                                                                                                | no             | `100000`                    |
| `AFFIDAVIT_TURN_MAX_OUTPUT_TOKENS`                   | per agent turn (default 8000)                                                                                                                  | no             | `8000`                      |
| `AFFIDAVIT_TURN_MAX_USD`                             | per agent turn (default 1)                                                                                                                     | no             | `1`                         |
| `AFFIDAVIT_AGENT_MAX_TURNS`                          | turns per agent session (default 6)                                                                                                            | no             | `6`                         |
| `AFFIDAVIT_DEFENSE_ITERATIONS`                       | Defense witness attempts (default 2)                                                                                                           | no             | `2`                         |
| `AFFIDAVIT_PROSECUTION_COUNTEREXAMPLES`              | (default 2)                                                                                                                                    | no             | `2`                         |
| `AFFIDAVIT_REMEDY_ITERATIONS`                        | (default 2)                                                                                                                                    | no             | `2`                         |

The budget defaults are conservative starting caps, not measured numbers ([metric] until real runs).

### For Judge `real`

| Name                             | Purpose                                                                                      | Required | Example placeholder              |
| -------------------------------- | -------------------------------------------------------------------------------------------- | -------- | -------------------------------- |
| `AFFIDAVIT_JUDGE_WORK_ROOT`      | absolute, existing directory for witness attempt directories                                 | yes      | `/srv/affidavit/judge`           |
| `AFFIDAVIT_WITNESS_RUNNER_IMAGE` | local image ID (`sha256:<64 hex>`) from `pnpm --filter @affidavit/judge runner-image`        | yes      | `sha256:<64 hex>`                |
| `AFFIDAVIT_EVIDENCE_DIR`         | absolute, existing evidence store directory; must not contain or sit inside either work root | yes      | `/srv/affidavit/evidence`        |
| `AFFIDAVIT_SIGNER_SOCKET`        | the listening unix socket of `apps/signer`                                                   | yes      | `/run/affidavit/signer.sock`     |
| `AFFIDAVIT_NODEGOAT_BUNDLE`      | NodeGoat dependency bundle directory (PR #55); checked when set                              | no       | `/srv/affidavit/nodegoat-bundle` |

## Host prerequisites

Checked at startup; each line is one possible `PrerequisiteError` entry.

- Linux, when the Judge is real or `AFFIDAVIT_TOOLRUNNER=gvisor` (gVisor does not run on Windows or macOS).
- A reachable Docker daemon, when intake or the Judge is real.
- The `runsc` Docker runtime (`docker/sandbox/install-gvisor.sh`, as root), for gVisor.
- The `runsc-affidavit` audit runtime and its trace directory (`docker/sandbox/setup-runsc-audit.sh`, as root), for the Judge.
- The intake work root, the Judge work root and the evidence directory exist; the evidence directory is outside both work roots (the witness jail gets no path to the evidence store).
- The signer is running and its socket exists.
- The witness runner image is built locally.
- The NodeGoat bundle directory exists, when `AFFIDAVIT_NODEGOAT_BUNDLE` is set.

## To run a real case

The only secret input is `ANTHROPIC_API_KEY`. The database passwords are generated fresh for the run.

1. On a Linux host with Docker, run `docker/sandbox/install-gvisor.sh` and `docker/sandbox/setup-runsc-audit.sh` as root.
2. Set a monthly spend limit on the key in the Anthropic Console.
3. Generate one password per role for this run (for example `openssl rand -hex 24`, three times), start Postgres from `docker/compose.yaml`, and provision it with `@affidavit/db` (`bootstrapRoles`, `setRolePassword` for `affidavit_owner`, `affidavit_app` and `affidavit_worker`, `applyMigrations`, `provisionTenant`). Keep the passwords in the shell only.
4. Create the intake work root, Judge work root and evidence directory (separate trees).
5. Build the witness runner image (`pnpm --filter @affidavit/judge runner-image`) and set `AFFIDAVIT_WITNESS_RUNNER_IMAGE` to the printed ID.
6. Start `apps/signer` and set `AFFIDAVIT_SIGNER_SOCKET`.
7. Export the variables above, with `AFFIDAVIT_JURY_ENABLED=false`, and `export ANTHROPIC_API_KEY="<from the secrets store>"` in that shell only.
8. Start the worker (`node --import tsx apps/worker/src/main.ts`). It refuses with a list if anything is missing.
9. Open a case: `pnpm --filter @affidavit/worker open-case -- --tenant <tenant> --repo <repo id> --commit <40 hex>`. It runs the same discovery as intake and opens the case only for a case file; a dismissal, an F3 hold or an unsupported repository is printed and nothing is opened.
10. Follow the case with `affidavit` (apps/cli) or the `events` table.

## What happens when something is refused

- Intake `unsupported` or `incomplete` (a partial secret scan): no contract slot exists for it (CR-4) and `escalated` is not reachable from intake, so the attempt fails with `IntakeRefusedError` and its reason. Recovery retries up to `AFFIDAVIT_MAX_STAGE_ATTEMPTS` and then writes a `review_flags` row (`attempts-exhausted`). Never dismissed, never retried forever.
- Real discovery does not reproduce the stored case file (other code, other rules, a dismissal, a hold, a duplicate-reachability error from arraign): `CaseFileMismatchError` or `DiscoveryPipelineError`, same path. A case opened for trial is never dismissed by Lane 1.
- No API key, or a key the provider refused: the stage halts with `TrialHaltedError` (`model-unconfigured`) before any charge; recovery retries (zero-amount cost rows) and then flags the stage for review. Set the key and clear the flag to resume.
- Kill switch: same path, reason `kill-switch`.

## What still blocks a real verdict

These are outside this lane's packages or need the lead; each is tracked in `contract-requests.md`.

- The Judge has no booted targets. `BootedTargets` refuses a variant it has not booted, and a case file must name the booted image in `target.imageDigest`; discovery case files name none, and the case file is immutable once opened. Until a per-case boot step exists (CR-11), every witness fails closed as an infrastructure error, the Defense stage fails, and the case is flagged for review, never dismissed.
- `verifyPatch` needs a `PatchWorkbench` and a `RescanPort`; neither is wired (CR-11).
- No stage seals an evidence bundle, so the signer and the evidence store are checked but not used yet (CR-11).
- No single-stage entry in the trial package (CR-7). The worker runs `Orchestrator.run` per stage job and stops it after one transition. The trial workspace (admitted witness, patch) and the cost ledger are in process memory, so a worker restart mid-trial fails the next stage and flags it for review.
- No jury handler (L3-11), so the jury must be disabled.
- NodeGoat: ingestion returns `incomplete` until PR #54, and the target cannot build without the dependency bundle until PR #55.
