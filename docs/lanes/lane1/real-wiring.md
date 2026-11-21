# Real wiring runbook (L1-10b, L1-10c, L1-17)

How to run `apps/worker` with real stages: real discovery for intake, map and arraign, the real
trial orchestrator on the real model port, and the real Judge on the gVisor witness jail. The
worker is the composition root; everything here is configuration. Every value below is a
placeholder. Never put a real secret in this file, a commit, a shell history file or an issue.

## What each switch turns on

| Switch                       | `real` means                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AFFIDAVIT_INTAKE_IMPL=real` | intake, map and arraign run `discoverCase` (`packages/discovery/src/pipeline`) on the case's pinned repo and commit, and refuse to go on unless it reproduces the stored case file.                                                                                                                     |
| `AFFIDAVIT_TRIAL_IMPL=real`  | defense, prosecution, remedy and verify run `@affidavit/trial`'s `Orchestrator` and handlers on `createModelPortFromEnv`. The jury must be off (no jury handler yet, L3-11).                                                                                                                            |
| `AFFIDAVIT_JUDGE_IMPL=real`  | the Judge is Lane 2's `createRealJudge` (`packages/judge/src/jail/real.ts`): `Judge` on the gVisor `JailExecutor`, `CaseTargets` booting each case's vulnerable and safe variants, the jailed patch workbench, `FsEvidenceStore` and `SignerClient`; with intake also `real`, discovery's re-scan (`DiscoveryRescan`) as its `RescanPort`. Host steps: `docs/lanes/lane2/real-judge-host.md`. |

Each switch is independent. Unset or `fake` keeps the scripted fake for that part.

## Startup refuses, it never half starts

`loadConfig` lists every missing or malformed variable in one `ConfigError`. Then `prepareCores`
checks the host (`checkPrerequisites`) and builds every environment-derived component
(discovery's arraignment settings and tool runner, the model port, the model table), and lists
every problem from all of them in one `PrerequisiteError`, before any database connection is
opened. Only then is the real Judge built, last, because it takes a worker lease and may sweep;
if anything after it fails, the Judge is closed (lease released, timers stopped) before the error
goes up. Messages name variables and host facts, never values: a database URL, a repository
source or a key never appears in an error or in `describeConfig`.

## Child processes never see a secret

`main.ts` and `open-case` call `sealSecrets` right after `loadConfig`: `ANTHROPIC_API_KEY`, both
database URLs and `AFFIDAVIT_REPO_SOURCES` are moved out of `process.env` into a private snapshot.
The model port reads the key from that snapshot on every call. So no child process can inherit
one, including those that other lanes' components spawn with the inherited environment (the tool
runners, the Judge's jail and its probes). The worker's own `docker info` probe gets an explicit
minimal environment (`childEnv`: `PATH`, `HOME`, `DOCKER_HOST`, `DOCKER_CONFIG`, `DOCKER_CONTEXT`,
`DOCKER_CERT_PATH`, `DOCKER_TLS_VERIFY`, `XDG_RUNTIME_DIR`, plus `SYSTEMROOT`, `TEMP`, `TMP` and
`PATHEXT` on Windows). An explicit environment option on the other lanes' runners is requested in
`contract-requests.md` (CR-12).

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

| Name                                  | Purpose                                                                                                                                                                                                                     | Required | Example placeholder                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------ |
| `AFFIDAVIT_INTAKE_WORK_ROOT`          | absolute, existing directory for per-run discovery workspaces (each run gets its own and removes it)                                                                                                                        | yes      | `/srv/affidavit/intake`                                      |
| `AFFIDAVIT_REPO_SOURCES`              | JSON object from repository id to clone URL or local path; ids are logged, sources never are                                                                                                                                | yes      | `{"OWASP/NodeGoat":"https://github.com/OWASP/NodeGoat.git"}` |
| `AFFIDAVIT_INTAKE_ALLOW_LOCAL_SOURCE` | `true` lets a source be a local path (testing)                                                                                                                                                                              | no       | `false`                                                      |
| `AFFIDAVIT_TOOLRUNNER`                | `gvisor` (Lane 2 `GvisorToolRunner`, the default when unset) or `docker` (plain local Docker: only when set by name, and startup logs a warning that scanners run on untrusted repository content without gVisor isolation) | no       | `gvisor`                                                     |
| `AFFIDAVIT_TOOL_TIMEOUT_MS`           | per scanner run (default 600000)                                                                                                                                                                                            | no       | `600000`                                                     |
| `AFFIDAVIT_ESCALATION_FLOOR`          | F3 floor, read by discovery's `arraignConfigFrom`                                                                                                                                                                           | no       | (discovery default)                                          |
| `AFFIDAVIT_DISMISS_BELOW`             | dismissal threshold, read by `arraignConfigFrom`                                                                                                                                                                            | no       | (discovery default)                                          |

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

Mapped onto `RealJudgeConfig` (field in brackets); Lane 2's check names the field and the variable.

| Name                               | Purpose                                                                                                                                                                                                                          | Required        | Example placeholder          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------- |
| `AFFIDAVIT_JUDGE_WORK_ROOT`        | quota'd, existing directory for witness attempts, builds and patch workspaces (`workRoot`)                                                                                                                                       | yes             | `/srv/affidavit/judge`       |
| `AFFIDAVIT_WITNESS_RUNNER_IMAGE`   | witness runner image ID from `pnpm --filter @affidavit/judge runner-image` (`runnerImage`)                                                                                                                                       | yes             | `sha256:<64 hex>`            |
| `AFFIDAVIT_PATCH_APPLY_IMAGE`      | patch-apply image ID from `pnpm --filter @affidavit/judge patch-apply-image` (`applyImage`)                                                                                                                                      | yes             | `sha256:<64 hex>`            |
| `AFFIDAVIT_EVIDENCE_DIR`           | existing evidence store directory (`evidenceRoot`, `FsEvidenceStore`); neither inside nor containing a work root, after symlinks are resolved                                                                                    | yes             | `/srv/affidavit/evidence`    |
| `AFFIDAVIT_SIGNER_SOCKET`          | the listening unix socket of `apps/signer` (`signerSocket`, `SignerClient`); not under a work root, the evidence store or a bundle store                                                                                         | yes             | `/run/affidavit/signer.sock` |
| `AFFIDAVIT_NODEGOAT_DIR`           | verified NodeGoat checkout (`fetch-pinned.mjs nodegoat`), the vulnerable tree for `sources`                                                                                                                                      | for NodeGoat    | `/srv/corpus/nodegoat`       |
| `AFFIDAVIT_NODEGOAT_SAFE_DIR`      | verified safe tree (`fetch-pinned.mjs nodegoat safe`)                                                                                                                                                                            | for NodeGoat    | `/srv/corpus/nodegoat-safe`  |
| `AFFIDAVIT_NODEGOAT_BUNDLE`        | the NodeGoat dependency bundle tar (`dependencyBundles[].path`). Startup checks it is a regular file, not a directory or a symlink; the Judge checks its sha256 against `pins.json` and fails closed on a null pin or a mismatch | for NodeGoat    | `/srv/bundles/<sha256>.tar`  |
| `AFFIDAVIT_DEPENDENCY_BUNDLE_ROOT` | the bundle store the tar must resolve inside (`dependencyBundles[].storeRoot`); required with the bundle                                                                                                                         | with the bundle | `/srv/bundles`               |
| `AFFIDAVIT_SWEEP_ORPHANS`          | startup sweep of case networks left by workers proven dead (`sweepOrphans`): unset or `0` off (default), `1` on, `force` also removes runs no lease claims (operator only)                                                       | no              | `0`                          |
| `AFFIDAVIT_JUDGE_LEASE_DIR`        | worker lease directory shared by every worker on the host (`leaseDir`, default `<workRoot>/leases`)                                                                                                                              | no              | `/srv/affidavit/leases`      |

## Host prerequisites

Checked at startup; each line is one possible `PrerequisiteError` entry.

- Linux, when the Judge is real or intake runs on gVisor (`AFFIDAVIT_TOOLRUNNER` unset or `gvisor`; gVisor does not run on Windows or macOS). With `AFFIDAVIT_TOOLRUNNER` unset on a host without gVisor, startup refuses and says to set `AFFIDAVIT_TOOLRUNNER=docker` explicitly to scan under plain Docker.
- A reachable Docker daemon, when intake or the Judge is real.
- The `runsc` Docker runtime (`docker/sandbox/install-gvisor.sh`, as root), for gVisor.
- The `runsc-affidavit` audit runtime and its trace directory (`docker/sandbox/setup-runsc-audit.sh`, as root), for the Judge.
- The intake work root, the Judge work root and the evidence directory exist; the evidence directory is outside both work roots (the witness jail gets no path to the evidence store).
- The signer is running and its socket exists.
- The witness runner and patch-apply images are built locally.
- The NodeGoat trees exist, when set. The Judge part of the list is Lane 2's `checkRealJudgePrerequisites`, run on the same config `createRealJudge` gets, so one error lists everything.
- The NodeGoat bundle tar is a regular file (not a directory, not a symlink), when `AFFIDAVIT_NODEGOAT_BUNDLE` is set. Its sha256 is checked by the Judge, not at startup.

## To run a real case

The only secret input is `ANTHROPIC_API_KEY`. The database passwords are generated fresh for the run.

1. On a Linux host with Docker, run `docker/sandbox/install-gvisor.sh` and `docker/sandbox/setup-runsc-audit.sh` as root.
2. Set a monthly spend limit on the key in the Anthropic Console.
3. Generate one password per role for this run (for example `openssl rand -hex 24`, three times), start Postgres from `docker/compose.yaml`, and provision it with `@affidavit/db` (`bootstrapRoles`, `setRolePassword` for `affidavit_owner`, `affidavit_app` and `affidavit_worker`, `applyMigrations`, `provisionTenant`). Keep the passwords in the shell only.
4. Create the intake work root, Judge work root and evidence directory (separate trees).
5. Build the witness runner and patch-apply images (`pnpm --filter @affidavit/judge runner-image` and `patch-apply-image`) and set `AFFIDAVIT_WITNESS_RUNNER_IMAGE` and `AFFIDAVIT_PATCH_APPLY_IMAGE` to the printed IDs. For NodeGoat, follow `docs/lanes/lane2/real-judge-host.md` steps 4 and 5 (trees, and the human-built, pinned dependency bundle).
6. Start `apps/signer` and set `AFFIDAVIT_SIGNER_SOCKET`.
7. Export the variables above, with `AFFIDAVIT_JURY_ENABLED=false`, and `export ANTHROPIC_API_KEY="<from the secrets store>"` in that shell only.
8. Start the worker (`node --import tsx apps/worker/src/main.ts`). It refuses with a list if anything is missing.
9. Open a case: `pnpm --filter @affidavit/worker open-case -- --tenant <tenant> --repo <repo id> --commit <40 hex>`. It runs the same discovery as intake. The trial candidate (the one named with `--candidate`, or the highest-ranked) is opened and queued. Every F3 hold of the scan (a dismissal rule matched at or above the escalation floor) is opened as a case of its own, `<case id>-hold-<digest>`, and flagged for a person: a `review_flags` row with reason `f3-hold` and arraignment's route (`person`, or `person-or-trial`: a person or a second Defense attempt) in its detail, no stage job, never dismissed. A dismissal or an unsupported repository opens no trial case and is printed. Find the holds with `select case_id, detail from review_flags where reason = 'f3-hold'`.
10. Follow the case with `affidavit` (apps/cli) or the `events` table.

## What happens when something is refused

- Intake `unsupported` or `incomplete` (a partial secret scan): no contract slot exists for it (CR-4) and `escalated` is not reachable from intake, so the attempt fails with `IntakeRefusedError` and its reason. Recovery retries up to `AFFIDAVIT_MAX_STAGE_ATTEMPTS` and then writes a `review_flags` row (`attempts-exhausted`). Never dismissed, never retried forever.
- Real discovery no longer sends the case's candidate to trial (it would be dismissed, it is held for review under F3, or the scan does not find it): `DiscoveryOutcomeError`, naming the outcome and discovery's reason codes, at the first of intake, map or arraign. Real discovery produces a case file that differs from the stored one: `CaseFileMismatchError`, naming the fields. A duplicate-reachability error from arraign: `DiscoveryPipelineError`. All take the same path as above. A case opened for trial is never dismissed by Lane 1.
- No API key, or a key the provider refused: the stage halts with `TrialHaltedError` (`model-unconfigured`) before any charge; recovery retries (zero-amount cost rows) and then flags the stage for review. Set the key and clear the flag to resume.
- Kill switch: same path, reason `kill-switch`.

## What still blocks a real verdict

These are outside this lane's packages or need the lead; each is tracked in `contract-requests.md`.

- Targets now boot per case (`CaseTargets`, #61); a boot failure is a failed Defense attempt and then a review flag, never a dismissal. Booted targets are released when a trial stage lands the case in a terminal stage and on shutdown; a case flagged for review keeps its targets until the worker stops (no hook from the review flag yet). Targets live in process memory, so a restart boots them again.
- `verifyPatch` gets Lane 1's re-scan (`DiscoveryRescan`, L1-17) only when intake is real as well: it reuses the intake tool runner (`AFFIDAVIT_TOOLRUNNER`), timeout and work root. With `AFFIDAVIT_INTAKE_IMPL` unset or `fake` there is no re-scan, `verifyPatch` fails closed, Remedy cannot be verified and the case is flagged for review; startup logs this as a `real Judge:` note. The re-scan is clean only when the case's Semgrep rule no longer fires anywhere in the case's file of the patched tree and the scan reported no coverage loss (`packages/discovery/CLAUDE.md`, "Re-scan").
- No stage seals an evidence bundle; `createRealJudge` holds the evidence store and signer client for it (CR-11, second half).
- No single-stage entry in the trial package (CR-7). The worker runs `Orchestrator.run` per stage job and stops it after one transition. The trial workspace (admitted witness, patch) and the cost ledger are in process memory, so a worker restart mid-trial fails the next stage and flags it for review.
- No jury handler (L3-11), so the jury must be disabled.
- NodeGoat: ingestion returns `incomplete` until PR #54. `pins.json` has `bundleSha256: null` for NodeGoat, so until a human builds, reviews and pins the bundle, a configured bundle is refused at startup, and without one every NodeGoat case is `unsupported` at build.
- CR-1: a case file's safe variant does not say which corpus safe variant it means, so a differential run cannot name the exact safe code it compared against.
