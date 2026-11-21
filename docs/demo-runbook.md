# Demo runbook

Status: fixture-driven demo on `main`. Every stage is a fake. No real port is wired.

This runbook covers `pnpm demo` (start the demo stack) and `pnpm e2e` (the fake-backed end-to-end check). Both are wiring only: they start existing packages with their fakes and print what those packages print.

## 1. What is real, what is fixture, what is fake

| Piece                                                               | State in this demo                                                                              | Where                                                                                             |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Postgres, schema, RLS, roles, Graphile Worker queue                 | Real                                                                                            | `docker/compose.yaml`, `packages/db`                                                              |
| Stage orchestration (lease, attempts, recovery, append-only events) | Real                                                                                            | `packages/db`, wired by `apps/worker`                                                             |
| Worker process                                                      | Real process, fake stage work                                                                   | `apps/worker`, `AFFIDAVIT_INTAKE_IMPL`, `AFFIDAVIT_TRIAL_IMPL`, `AFFIDAVIT_JUDGE_IMPL` all `fake` |
| Intake (discovery, map, arraign)                                    | Fake. The case file is the recorded NodeGoat fixture whatever target you pass                   | `fixtures/casefiles/nodegoat-sqli-001.json`                                                       |
| Defense, Prosecution, Remedy, Jury                                  | Fake, scripted, labelled `[fake]`                                                               | `apps/worker/src/fakes/stages.ts`                                                                 |
| Judge, sandbox, witness runs, admissibility                         | Fake (`FakeJudge`). No witness code runs anywhere                                               | `apps/worker/src/fakes/stages.ts`                                                                 |
| Evidence bundle, signing, replay                                    | Not wired. `affidavit replay` reports not implemented                                           | Lane 2                                                                                            |
| CLI `scan` and `status`                                             | Real command code, real database reads                                                          | `apps/cli`                                                                                        |
| Web UI                                                              | Real app, but it reads the recorded fixture streams through a fake SSE source, not the database | `apps/web`, `fixtures/trials/*.events.json`                                                       |
| API and live SSE                                                    | Do not exist yet                                                                                | `apps/api`                                                                                        |

Two things to keep straight on stage:

- The CLI stream comes from the worker writing events into Postgres. The web UI does not show that case; it shows the two recorded fixtures (`nodegoat-sqli-001`, `escalated-001`). They are close but not identical (the fake worker adds a jury stage and has no cost or remedy exhibit events; see the note in `apps/cli/src/e2e.pg.test.ts`).
- The escalated case exists only as a recorded fixture in the web UI. The fake worker never escalates or dismisses.

## 2. Prerequisites

- Node 22 or later and pnpm 11.21.0 (`packageManager` in `package.json`).
- Docker Desktop running, for the Postgres path. Without it the demo falls back to the in-memory replay (section 5).
- Port `127.0.0.1:5432` free (compose maps it). The web UI tries `127.0.0.1:5173` and, if anything else answers there, the next free port up to 5192; it prints the port it used.
- A browser.

No secret or account is needed. The demo generates random database passwords per run, keeps them in memory, passes them to child processes by environment, and never prints them.

## 3. Exact steps

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

## 4. Expected output

Banner and setup (Docker path):

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

Then one line per event, in seq order, from `#000 intake ... stage-entered` through defense, prosecution, remedy, verify and jury, ending with a `verdict-written` line. The worker interleaves its own `[fake]` log lines. `affidavit status` then prints `state finished (verdict-written)`. The scan exits 0.

Web UI:

```
[demo] starting the web UI dev server
[demo] web UI ready (recorded fixtures through the fake SSE source):
[demo]   http://127.0.0.1:5173/
[demo]   http://127.0.0.1:5173/cases/nodegoat-sqli-001
[demo]   http://127.0.0.1:5173/cases/escalated-001
[demo] Press Ctrl+C to stop everything.
```

Durations and costs on screen are scripted or recorded values, not measurements. Any metric quoted about Affidavit is [metric] until a real run produces it.

## 5. Fallbacks

Docker missing, not running, or port 5432 taken:

- The demo prints `FALLBACK to the in-memory replay: <reason>` and continues. The in-memory replay runs the real `affidavit scan` command code against an in-memory port that serves the recorded `nodegoat-sqli-001` stream. No database and no worker run. Say so on stage.
- To force it: `pnpm demo -- --memory`.
- To free 5432, stop the other Postgres. If a previous demo was killed hard, remove its leftovers with `POSTGRES_PASSWORD=unused docker compose -f docker/compose.yaml -p affidavit-demo down -v` (compose needs some value to read the file; it is not used). `pnpm demo` also does this itself at start.

Browser or web UI misbehaves:

- The CLI stream above is the main artifact; it does not need the browser.
- If the web UI does not start, the demo prints the last Vite log lines and keeps the CLI output.
- If the demo was killed hard (not Ctrl+C), a Vite process can be left behind on the port; the next run skips that port. Close it from Task Manager (a `node.exe` running `vite.js`) if it bothers you.
- As a second option, run the web UI on its own: `pnpm --filter @affidavit/web dev`, and open the URL Vite prints.
- If the browser shows a blank page, hard reload. The UI is client-rendered; the page source alone is only the app shell.

The scan times out (exit 5):

- The worker did not pick the case up. Look for `[worker] fatal:` lines. Rerun `pnpm demo`; it starts from a clean container every time.

## 6. The fake-backed end-to-end check

```sh
pnpm e2e
```

It runs the same path with `--once` behaviour and checks: Postgres provisioned, `scan` exits 0, the stream is labelled fake, it passes through defense, prosecution, remedy and verify and ends in `verdict-written`, `status` reads the finished case back, and the web UI serves the app and compiles the fixture loader with both recorded cases. It prints, at the start and the end:

```
NOTICE: real ports are not wired. Every stage is a fake. This run does not test the walking-skeleton gate criteria.
```

Without Docker it fails. `AFFIDAVIT_E2E_ALLOW_MEMORY=1 pnpm e2e` accepts the in-memory replay and reports `mode memory`. The section 8 target (real implementations of every port, gate criteria asserted) is still open.

## 7. Known check results on Windows

Observed on a Windows 11 machine from a clean `pnpm install --frozen-lockfile` on `main`: `pnpm typecheck`, `pnpm lint`, `pnpm build` and `pnpm format:check` pass. `pnpm test` fails on two Lane 2 tests that create symlinks, which Windows refuses without Developer Mode or admin rights (`EPERM ... symlink`): `packages/sandbox` `src/gvisor/mounts.test.ts` and `packages/judge` `src/jail/jail.test.ts` ("never follows a symlink"). These are environment failures, not demo failures; they are not skipped or changed here. One `packages/discovery` test ("never truncates coverage notifications") hit its 5 second timeout once under a full parallel run and passed when rerun alone.

## 8. Talking points

What this demo shows, and is true today:

- The case pipeline shape: one case moves intake, map, arraign, defense, prosecution, remedy, verify, jury, verdict, as durable rows in Postgres, driven by a queue worker that can be killed and resumed (covered by `apps/worker` `test:pg`).
- Tenant isolation is enforced in the database (row-level security, forced, on every tenant table), and the services log in as two narrow roles, never a superuser.
- Events are append-only and emitted once per stage visit, so a retried stage does not repeat its story.
- The CLI and the web UI treat every string from a case, repo, model or tool as untrusted and render it as plain text only.
- The product rules the design holds to: agents never get a shell, they submit witness code and the Judge runs it; the witness runner holds no credential and no writable path to the evidence store; proof is differential (a witness must pass on the vulnerable code and fail on a known-safe variant); a high-score candidate with no admissible witness is never silently dismissed, it escalates (the `escalated-001` fixture shows that outcome).

What this demo does not show, and must not be claimed:

- No vulnerability was found. Intake is fake; the case file is a hand-written fixture.
- No witness ran. The Judge is a fake; "admissible" in the stream is scripted. The differential rule, the sandbox jail and egress denial are not exercised here.
- No patch was verified (the web UI says so for the gate case), no jury voted, and no model was called.
- No evidence bundle was produced, signed or replayed.
- The walking-skeleton gate (Semgrep candidate to signed verdict, differential admission, family flip, replay on a second machine, containment suite) is not met by this demo.
- No accuracy, cost, speed or false-positive figure exists yet. Use [metric] for every number.

## Hosted fixture demo (Vercel)

The web UI alone (fixture streams, no backend) is deployed from `apps/web` as a static Vite build, with `apps/web/vercel.json` rewriting every route to `index.html` for client-side routing. It shows the two recorded cases only (`/cases/nodegoat-sqli-001` and `/cases/escalated-001`). It is a recorded fixture, not a live run: no scanner, model, Judge or sandbox is involved, and cost and time read `[metric]`. The real Judge needs a Linux gVisor host and cannot run on Vercel.
