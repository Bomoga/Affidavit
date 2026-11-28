# Demo runbook

Status as of 2026-11-27: **Tier A (recorded and fake-backed) runs today. Tier B (one live case) has never been run end to end.** Every stage in `pnpm demo` is a fake. The worker has real switches for intake, trial and Judge, but they have not been run together, and no stage seals an evidence bundle yet.

This runbook covers three things:

1. Tier A: `pnpm demo` and `pnpm e2e` (sections 3 to 6). Works on `main`, needs Docker and a browser.
2. Tier B: the live single-host demo (section 7). A procedure, not a result. Read its status table first.
3. What you may and may not say on stage (section 9).

The plan behind the tiers is `docs/deploy/mvp-demo-plan.md`. Host and key setup is in `docs/deploy/` and `docs/lanes/lane1/real-wiring.md`.

## 1. Pick the tier

| Tier | What the audience sees                                                                                                 | Needs                                                                                              | State                                   |
| ---- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------- |
| A    | The recorded NodeGoat case and an escalated case in the web UI, plus a fake-backed CLI scan on a real queue.           | Docker, a browser. No keys, no host.                                                               | Works on `main`. Hosted copy on Vercel. |
| B    | One real NodeGoat injection, live: discovery, a model-written witness, the Judge in the jail, a signed bundle, replay. | A Linux host with gVisor, an Anthropic key with a spend limit, a signing key, the NodeGoat bundle. | Pieces exist. Never run together.       |
| C    | Other people sign in and scan their own repository.                                                                    | Everything in B plus OAuth, a domain, hosted Postgres, storage.                                    | Stretch. Not started.                   |

Always have Tier A ready as the fallback. If Tier B fails on the day, say so and show Tier A as what it is.

## 2. What is real, what is fixture, what is fake

This table describes `pnpm demo` (Tier A). Section 7 says what changes for Tier B.

| Piece                                                               | State in `pnpm demo`                                                                       | Where                                                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Postgres, schema, RLS, roles, Graphile Worker queue                 | Real                                                                                       | `docker/compose.yaml`, `packages/db`                                                              |
| Stage orchestration (lease, attempts, recovery, append-only events) | Real                                                                                       | `packages/db`, wired by `apps/worker`                                                             |
| Worker process                                                      | Real process, fake stage work                                                              | `apps/worker`, `AFFIDAVIT_INTAKE_IMPL`, `AFFIDAVIT_TRIAL_IMPL`, `AFFIDAVIT_JUDGE_IMPL` all `fake` |
| Intake (discovery, map, arraign)                                    | Fake. The case file is the recorded NodeGoat fixture whatever target you pass              | `fixtures/casefiles/nodegoat-sqli-001.json`                                                       |
| Defense, Prosecution, Remedy, Jury                                  | Fake, scripted, labelled `[fake]`                                                          | `apps/worker/src/fakes/stages.ts`                                                                 |
| Judge, sandbox, witness runs, admissibility                         | Fake (`FakeJudge`). No witness code runs anywhere                                          | `apps/worker/src/fakes/stages.ts`                                                                 |
| Evidence bundle, signing, replay                                    | Not wired into the worker. `affidavit replay` reports not implemented                      | Lane 2                                                                                            |
| CLI `scan` and `status`                                             | Real command code, real database reads                                                     | `apps/cli`                                                                                        |
| Web UI                                                              | Real app, but `pnpm demo` serves it the recorded fixture streams through a fake SSE source | `apps/web`, `fixtures/trials/*.events.json`                                                       |
| API                                                                 | Exists (`apps/api` has a server entry and tests) but `pnpm demo` does not start it         | `apps/api`                                                                                        |

Two things to keep straight on stage:

- The CLI stream comes from the worker writing events into Postgres. The web UI does not show that case; it shows the two recorded fixtures (`nodegoat-sqli-001`, `escalated-001`). They are close but not identical (the fake worker adds a jury stage and has no cost or remedy exhibit events; see the note in `apps/cli/src/e2e.pg.test.ts`).
- The escalated case exists only as a recorded fixture in the web UI. The fake worker never escalates or dismisses.

## 3. Tier A prerequisites

- Node 24 and pnpm 11.21.0 (`packageManager` in `package.json`).
- Docker Desktop running, for the Postgres path. Without it the demo falls back to the in-memory replay (section 5).
- Port `127.0.0.1:5432` free (compose maps it). The web UI tries `127.0.0.1:5173` and, if anything else answers there, the next free port up to 5192; it prints the port it used.
- A browser.

No secret or account is needed. The demo generates random database passwords per run, keeps them in memory, passes them to child processes by environment, and never prints them.

## 4. Tier A steps

From the repo root:

```sh
pnpm install --frozen-lockfile
pnpm demo
```

What `pnpm demo` does, in order:

1. Checks that Docker answers. If not, falls back to the in-memory replay and says so.
2. Removes any leftover `affidavit-demo` compose project, then starts Postgres from `docker/compose.yaml` under the project name `affidavit-demo`.
3. Runs `scripts/demo-db-setup.ts`: `bootstrapRoles`, `applyMigrations` as `affidavit_owner`, `provisionTenant tenant-demo`, and login passwords for `affidavit_app` and `affidavit_worker`.
4. Starts the worker (`apps/worker/src/main.ts`) with every stage fake.
5. Runs `affidavit scan OWASP/NodeGoat` and prints the event stream, then `affidavit status <caseId>`.
6. Starts the web UI dev server on `http://127.0.0.1:5173` (or the next free port) and waits until it serves the Affidavit app, not just any server on that port.
7. Waits for Ctrl+C, then stops the web server and the worker and runs `docker compose -p affidavit-demo down -v` (removes only the demo container and its volume).

Then open the URLs it prints (port 5173 unless it says otherwise):

- `http://127.0.0.1:5173/` (case list)
- `http://127.0.0.1:5173/cases/nodegoat-sqli-001` (the gate case, recorded). It shows the VERIFIED stamp because the recorded stream contains a Judge `verify-result` event accepting the patch (contracts v1.1). Say plainly that this is a recorded fixture and not a live run: the stamp rests on the recorded Judge event, and the verdict's own claim alone would show UNVERIFIED.
- `http://127.0.0.1:5173/cases/escalated-001` (the escalated case, recorded). It shows HUMAN REVIEW: a strong candidate, two witnesses not admitted, no conclusion about safety.

Flags (`pnpm demo -- <flag>`): `--memory` skips Docker, `--no-web` skips the web UI and exits after the scan, `--once` tears everything down after startup, `--target <text>` changes the recorded target name (it does not change what is analysed: nothing is analysed).

Expected output, Docker path:

```
[demo] Fixture-driven demo. Every stage is a FAKE; no real port (discovery, Judge, trial) is wired.
[demo] starting Postgres from docker/compose.yaml (project affidavit-demo, 127.0.0.1:5432)
[setup] roles, migrations and tenant tenant-demo ready
[demo] starting the worker (intake, trial and judge all fake)
  [worker] starting {"intake":"fake","trial":"fake","judge":"fake",...}
[demo] affidavit scan OWASP/NodeGoat
FAKE INTAKE (v0): the case file is the recorded NodeGoat fixture, not an analysis of your target.
target OWASP/NodeGoat
case case-cli-<random> enqueued, waiting for a worker (timeout 60s)
```

Then one line per event, in seq order, from `#000 intake ... stage-entered` through defense, prosecution, remedy, verify and jury, ending with a `verdict-written` line. The worker interleaves its own `[fake]` log lines. `affidavit status` then prints `state finished (verdict-written)`. The scan exits 0. Then the web UI lines:

```
[demo] web UI ready (recorded fixtures through the fake SSE source):
[demo]   http://127.0.0.1:5173/
[demo]   http://127.0.0.1:5173/cases/nodegoat-sqli-001
[demo]   http://127.0.0.1:5173/cases/escalated-001
[demo] Press Ctrl+C to stop everything.
```

Durations and costs on screen are scripted or recorded values, not measurements. Any metric quoted about Affidavit is [metric] until a real run produces it.

## 5. Tier A fallbacks

Docker missing, not running, or port 5432 taken:

- The demo prints `FALLBACK to the in-memory replay: <reason>` and continues. The in-memory replay runs the real `affidavit scan` command code against an in-memory port that serves the recorded `nodegoat-sqli-001` stream. No database and no worker run. Say so on stage.
- To force it: `pnpm demo -- --memory`.
- To free 5432, stop the other Postgres. If a previous demo was killed hard, remove its leftovers with `POSTGRES_PASSWORD=unused docker compose -f docker/compose.yaml -p affidavit-demo down -v` (compose needs some value to read the file; it is not used). `pnpm demo` also does this itself at start.

Browser or web UI misbehaves:

- The CLI stream is the main artifact; it does not need the browser.
- If the web UI does not start, the demo prints the last Vite log lines and keeps the CLI output.
- If the demo was killed hard (not Ctrl+C), a Vite process can be left behind on the port; the next run skips that port. Close it from Task Manager (a `node.exe` running `vite.js`) if it bothers you.
- Run the web UI on its own: `pnpm --filter @affidavit/web dev`, and open the URL Vite prints.
- If the browser shows a blank page, hard reload. The UI is client-rendered; the page source alone is only the app shell.

The scan times out (exit 5): the worker did not pick the case up. Look for `[worker] fatal:` lines. Rerun `pnpm demo`; it starts from a clean container every time.

No machine at all: the hosted copy (section 8) shows the two recorded cases with no backend.

## 6. The fake-backed end-to-end check

```sh
pnpm e2e
```

It runs the same path with `--once` behaviour and checks: Postgres provisioned, `scan` exits 0, the stream is labelled fake, it passes through defense, prosecution, remedy and verify and ends in `verdict-written`, `status` reads the finished case back, and the web UI serves the app and compiles the fixture loader with both recorded cases. It prints, at the start and the end:

```
NOTICE: real ports are not wired. Every stage is a fake. This run does not test the walking-skeleton gate criteria.
```

Without Docker it fails. `AFFIDAVIT_E2E_ALLOW_MEMORY=1 pnpm e2e` accepts the in-memory replay and reports `mode memory`. `pnpm e2e` cannot show that the gate is met. Use `pnpm gate` (section 7.4) for that.

## 7. Tier B: one live case on a Linux host

**Not yet run end to end.** This section is the procedure, assembled from the repo's own docs. Nothing in it has produced a verdict. Where a step is blocked, the table says what blocks it.

### 7.1 Status of what Tier B needs

Sources: `docs/deploy/mvp-demo-plan.md` (the 14 numbered requirements), `docs/lanes/lane1/real-wiring.md`, `docs/lanes/lane2/real-judge-host.md`.

| Need                                                      | Status                                                                                                                                                                                                     |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux host with Docker and gVisor                         | The Lane 2 owner's workstation passed the sandbox-host suites. No shared host exists. A WSL2 dry run (trial halting at `model-unconfigured`) is recorded in `real-wiring.md`. Host and date are undecided. |
| Anthropic key with a monthly spend limit                  | No owner named. Without it every trial stage halts with `model-unconfigured` and no charge.                                                                                                                |
| Signing key custody                                       | No owner named. Proposal in `docs/lanes/lane2/key-custody.md`.                                                                                                                                             |
| NodeGoat trees and the pinned dependency bundle           | Built by hand per host (`real-judge-host.md` steps 4 to 6). The exclusion list review is the lead's.                                                                                                       |
| A stage that seals the evidence bundle before the verdict | **Open.** No stage seals a bundle (CR-11, second half). PR #87 is the candidate fix and its state is unknown. Until this lands there is no signed verdict to show.                                         |
| Jury                                                      | Must be off with real trial (`AFFIDAVIT_JURY_ENABLED=false`). The verdict is written without a jury vote and you must say so.                                                                              |
| Appeals                                                   | Not built (L3-09). The gate case needs none if the first patch verifies.                                                                                                                                   |
| Model recordings                                          | None committed. A replay-mode rehearsal needs one live recording run first (`AFFIDAVIT_MODEL_MODE=record`).                                                                                                |
| Live stream to web and CLI                                | `apps/api` has a server entry and tests. Not verified: that the web UI's live client has run against it with the worker.                                                                                   |
| Dependency scan                                           | Not run by real intake (CR-14). A real case file holds no dependency findings.                                                                                                                             |

### 7.2 Procedure

Follow `docs/lanes/lane1/real-wiring.md`, section "To run a real case", steps 1 to 10. In short: host setup (gVisor, audit runtime), a spend limit on the key, a throwaway Postgres with generated role passwords, separate work and evidence directories, the two Judge images, the signer, the variables with `AFFIDAVIT_INTAKE_IMPL=real`, `AFFIDAVIT_TRIAL_IMPL=real`, `AFFIDAVIT_JUDGE_IMPL=real` and `AFFIDAVIT_JURY_ENABLED=false`, then the worker, then `open-case` for NodeGoat (`--repo repo-nodegoat --commit c5cb68a7084e4ae7dcc60e6a98768720a81841e8`).

Rules for the run:

- Put `ANTHROPIC_API_KEY` in the shell that starts the worker and nowhere else: not in a file, a commit, shell history or a screen share. The worker seals it away from child processes.
- Start with a low spend cap and the default per-case budget (`AFFIDAVIT_CASE_MAX_USD`). The caps are starting values, not measured ones.
- Keep a kill switch ready: `AFFIDAVIT_KILL_SWITCH_FILE` pointing at a path you can create to halt every trial stage.
- The worker refuses to start with a list of everything missing. Fix the list; do not work around it.

### 7.3 What a refusal looks like

A refused or halted case is a result, not a failure to hide. `real-wiring.md` lists each path: intake refusals, F3 holds opened for a person, a missing key (`model-unconfigured`), the kill switch, and a model refusal on safety grounds (`review_flags` row, never dismissed). If the live run lands there, show the flag, say what it means, and fall back to Tier A for the rest.

### 7.4 Judging the run against the gate

`pnpm gate` reads a finished case's event stream and the facts you pass, and prints PASS, FAIL or NOT RUN for each criterion of the walking-skeleton gate (`docs/implementation-plan.md`, section 8). It runs nothing. A fact you leave out is NOT RUN, and the gate is met only when every check passes.

```sh
pnpm gate case-events.json --candidate-tool semgrep --impl intake=real,trial=real,judge=real --bundle-verified yes --replay-matched yes --replay-second-machine yes --containment yes
```

`case-events.json` is a JSON array of the case's events. Exit code 0 means met, 1 not met, 2 bad usage. Run against the recorded gate case with no facts it reports the bundle check as FAIL (the recorded verdict names no bundle) and the rest as NOT RUN, so the recorded fixture can never meet the gate.

Only claim "the gate is met" on stage if this prints `GATE MET` for a real run. The facts are yours to establish: which implementations ran, the offline bundle check, a replay on a second machine, the containment suite on the host.

## 8. Hosted fixture demo (Vercel)

The web UI alone (fixture streams, no backend) is deployed from `apps/web` as a static Vite build, with `apps/web/vercel.json` rewriting every route to `index.html` for client-side routing. It shows the two recorded cases only (`/cases/nodegoat-sqli-001` and `/cases/escalated-001`). It is a recorded fixture, not a live run: no scanner, model, Judge or sandbox is involved, and cost and time read `[metric]`. The real Judge needs a Linux gVisor host and cannot run on Vercel.

## 9. Talking points

What Tier A shows, and is true today:

- The case pipeline shape: one case moves intake, map, arraign, defense, prosecution, remedy, verify, jury, verdict, as durable rows in Postgres, driven by a queue worker that can be killed and resumed (covered by `apps/worker` `test:pg`).
- Tenant isolation is enforced in the database (row-level security, forced, on every tenant table), and the services log in as two narrow roles, never a superuser.
- Events are append-only and emitted once per stage visit, so a retried stage does not repeat its story.
- The CLI and the web UI treat every string from a case, repo, model or tool as untrusted and render it as plain text only.
- The product rules the design holds to: agents never get a shell, they submit witness code and the Judge runs it; the witness runner holds no credential and no writable path to the evidence store; proof is differential (a witness must pass on the vulnerable code and fail on a known-safe variant); a high-score candidate with no admissible witness is never silently dismissed, it escalates (the `escalated-001` fixture shows that outcome).
- The F3 rule is enforced in the database for every way into `dismissed` (migration 0012): a case at or above the escalation floor cannot be dismissed, from any stage.

What Tier A does not show, and must not be claimed:

- No vulnerability was found. Intake is fake; the case file is a hand-written fixture.
- No witness ran. The Judge is a fake; "admissible" in the stream is scripted. The differential rule, the sandbox jail and egress denial are not exercised.
- No patch was verified (the web UI says so for the gate case), no jury voted, and no model was called.
- No evidence bundle was produced, signed or replayed.
- The walking-skeleton gate is not met by this demo.
- No accuracy, cost, speed or false-positive figure exists yet. Use [metric] for every number.

If Tier B runs, claim only what `pnpm gate` printed as PASS and what you watched happen. The jury did not vote (it is off), and the dependency scan did not run.

## 10. Known check results on Windows

Last observed on a Windows 11 machine from a clean `pnpm install --frozen-lockfile` on `main`, before the recent merges and **not rerun for this revision**: `pnpm typecheck`, `pnpm lint`, `pnpm build` and `pnpm format:check` passed. `pnpm test` failed on two Lane 2 tests that create symlinks, which Windows refuses without Developer Mode or admin rights (`EPERM ... symlink`): `packages/sandbox` `src/gvisor/mounts.test.ts` and `packages/judge` `src/jail/jail.test.ts` ("never follows a symlink"). These are environment failures, not demo failures. Some discovery timing tests have flaked under a loaded parallel run and passed when rerun alone. CI on `main` is green and runs the Postgres suites in a service container.
