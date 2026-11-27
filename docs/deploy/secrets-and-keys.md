# Secrets and keys inventory

Status: **draft for the lead**. This lists the variable names the code reads and who supplies each. It never holds a value. Nothing here creates, rotates or stores a secret. Sources: `.env.example`, `apps/api/src/config.ts`, `apps/worker/src/config.ts`, `docs/lanes/lane2/real-judge-host.md`, `docs/lanes/lane2/key-custody.md`. Names were collected by searching the repo for `AFFIDAVIT_*` and `ANTHROPIC_*`; I have not read each consumer, so a name below may be test-only. Verify before relying on it.

## Secrets (never in the repo, `.env`, chat or CI logs)

| Variable                                                              | Read by                    | Who supplies it                  | Notes                                                                                                                      |
| --------------------------------------------------------------------- | -------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                                                   | worker (trial, real model) | Adrian                           | A Console dev key with a spend limit. Unassigned in `docs/decisions.md`. No key means the case halts `model-unconfigured`. |
| `AFFIDAVIT_APP_DATABASE_URL`                                          | API                        | Adrian (deploy)                  | Role `affidavit_app`. Contains a password.                                                                                 |
| `AFFIDAVIT_WORKER_DATABASE_URL`                                       | worker                     | Adrian (deploy)                  | Role `affidavit_worker`. Contains a password.                                                                              |
| `AFFIDAVIT_SESSION_SECRET`                                            | API                        | Adrian (deploy)                  | Random, long. Rotating it signs everyone out.                                                                              |
| `AFFIDAVIT_GITHUB_WEBHOOK_SECRET`                                     | API                        | Adrian, with the GitHub App      | Needed only when L1-15 (App credentials) is unblocked.                                                                     |
| `AFFIDAVIT_API_TOKEN`                                                 | MCP and machine clients    | Adrian (deploy)                  | Bearer token for `apps/mcp`. Provider is a deferred follow-up in Lane 1 PROGRESS.                                          |
| `AFFIDAVIT_SIGNER_KEY`, `AFFIDAVIT_SIGNER_PASSWORD_FILE`              | signer only                | The key's owner, named by Adrian | Key file mode 0400 under `affidavit-signer`. Custody is open: see `docs/lanes/lane2/key-custody.md`.                       |
| `AFFIDAVIT_S3_ACCESS_KEY`, `AFFIDAVIT_S3_SECRET_KEY`                  | evidence store (if S3)     | Adrian                           | Only if the evidence store is not the local filesystem. Not verified which path production uses.                           |
| GitHub OAuth client id and secret (names in `apps/api/src/config.ts`) | API                        | Adrian, with the OAuth app       | The API refuses to start without them when OAuth is on. I did not read the exact names.                                    |

## Non-secret configuration worth deciding for production

| Variable                                                                                        | Meaning                                                                 |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `AFFIDAVIT_WITNESS_RUNNER_IMAGE`                                                                | Image id from `pnpm --filter @affidavit/judge runner-image`. Required.  |
| `AFFIDAVIT_PATCH_APPLY_IMAGE`                                                                   | Image id for the patch-apply image.                                     |
| `AFFIDAVIT_INTAKE_IMPL`, `AFFIDAVIT_TRIAL_IMPL`, `AFFIDAVIT_JUDGE_IMPL`                         | `fake` or `real`. Production must be `real` for all three.              |
| `AFFIDAVIT_MODEL_MODE`, `AFFIDAVIT_MODEL_CONFIG`                                                | How the trial reaches the model.                                        |
| `AFFIDAVIT_TURN_MAX_USD`, `AFFIDAVIT_TURN_MAX_INPUT_TOKENS`, `AFFIDAVIT_TURN_MAX_OUTPUT_TOKENS` | Per-turn spend and size caps. Values are Adrian's call.                 |
| `AFFIDAVIT_ESCALATION_FLOOR`, `AFFIDAVIT_DISMISS_BELOW`                                         | F3 floor and dismissal threshold. Changing them changes verdict policy. |
| `AFFIDAVIT_JURY_ENABLED`                                                                        | Jury on or off. Tied to CR-3 problem 2.                                 |
| `AFFIDAVIT_KILL_SWITCH`                                                                         | Operator stop. Confirm its behaviour before relying on it.              |
| `AFFIDAVIT_SANDBOX_HOST`, `AFFIDAVIT_DEPENDENCY_BUNDLE_ROOT`, `AFFIDAVIT_NODEGOAT_*`            | Sandbox host test inputs. Not for the API or web.                       |
| `AFFIDAVIT_API_STORE`, `AFFIDAVIT_AUTH`, `AFFIDAVIT_ENV`, `AFFIDAVIT_WEB_ORIGINS`               | API mode. Dev auth is loopback only; production needs OAuth.            |

## Rules

- Never write a value into any file in the repo. `.env.example` keeps placeholders only.
- The witness runner, the jail and the Judge's children hold no credential (CR-12 covers the minimal child environment).
- The signing key stays where the API process cannot read it.
- Open decisions (owner unassigned in `docs/decisions.md`): the Anthropic key and spend limit, signing key custody and rotation.

## Decision needed

Name the owner for the Anthropic key and spend limit, and for signing key custody. Until then no real verdict can be signed or run against the real model.
