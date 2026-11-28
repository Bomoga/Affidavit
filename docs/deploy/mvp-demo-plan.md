# MVP demo: what it takes

Status: **proposal for the lead**. Nothing here is built, run or provisioned. Each line says where its fact comes from: a repo doc, a PR, or "not verified". Costs, durations and rates are [metric] until a real run produces them.

## What "the MVP demo" can mean

| Tier | What the audience sees                                                                                                                                                                         | Needs                                                                                                  | State today                                            |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| A    | Recorded NodeGoat case and an escalated case in the web UI, plus a fake-backed CLI scan on a real queue. Every stage is labelled fake.                                                         | Docker, a browser. No keys, no host.                                                                   | Works on `main` (`pnpm demo`, hosted copy on Vercel).  |
| B    | One real NodeGoat injection, live: discovery finds it, a model writes a witness, the Judge runs it in the jail, a signed bundle is produced and replayed. CLI and web UI show the real stream. | One Linux host with gVisor, an Anthropic key with a spend limit, a signing key, the NodeGoat bundle.   | Every part exists in pieces. **Never run end to end.** |
| C    | Others can use it: sign in with GitHub, scan their own repo, a check run on a pull request.                                                                                                    | Everything in B, plus OAuth and GitHub App credentials, a domain and TLS, hosted Postgres, S3 storage. | Stretch per `docs/plan.md`. Not started.               |

My recommendation: **show Tier A as the safety net and build toward Tier B as the demo.** Tier C is outside the MVP cut (`docs/plan.md`, GitHub App is stretch if the demo lands before 14 Dec).

## Tier B: the gap, in the order it has to close

Status words: **done** (a repo doc says it passed), **open** (a doc or PR says it is not finished), **not verified** (I found no evidence either way).

| #   | Requirement                                                                                                       | Status                                                                                                                                                                                                                                                                | Owner                   |
| --- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1   | Demo date                                                                                                         | Open since 5 Nov (`docs/decisions.md`). Decides how much of Phase 3 gets cut.                                                                                                                                                                                         | Adrian                  |
| 2   | A Linux host with Docker and gVisor that runs the Judge, sandbox, worker and signer                               | The Lane 2 owner's Fedora workstation passed the sandbox-host suites on 2026-11-16 and 11-21 (Lane 2 PROGRESS). No shared host or CI runner exists (P0-10). See `sandbox-host-checklist.md`.                                                                          | Adrian and Lane 2 owner |
| 3   | Anthropic key with a monthly spend limit                                                                          | Open, unassigned (`docs/decisions.md`). No real model call is possible without it. See `secrets-and-keys.md`.                                                                                                                                                         | Adrian                  |
| 4   | Signing key custody for the demo                                                                                  | Open, unassigned. Proposal in `docs/lanes/lane2/key-custody.md`: encrypted key on the host, revoked after the demo, nothing shown outside as proof.                                                                                                                   | Adrian                  |
| 5   | NodeGoat trees, dependency bundle in the bundle store, runner and patch-apply images                              | Bundle pinned 2026-11-21 (Lane 2 PROGRESS). Each host still needs the files built (`real-judge-host.md` steps 4 to 6). The exclusion-list review is Adrian's.                                                                                                         | Lane 2 owner, Adrian    |
| 6   | A stage that seals the evidence bundle before the verdict (CR-11, second half)                                    | **Open.** `createRealJudge` returns the store and signer client but no stage seals a bundle. PR #87 ("seal a verdict before it is written") is open and untouched since 2026-11-22; its merge state is unknown.                                                       | Lane 2, wiring Lane 1   |
| 7   | Real worker run on the host with all three switches `real`                                                        | **Never run.** Lane 2's host notes say the worker "waits on Lane 1 wiring". Lane 1 wiring (L1-10b, L1-10c, L1-17) is merged but its docker re-scan test has not been run (Lane 1 PROGRESS).                                                                           | Lane 1                  |
| 8   | Jury off for the real trial                                                                                       | By design today: `AFFIDAVIT_TRIAL_IMPL=real` needs the jury off (L3-11 not built). The demo shows a verdict without a jury vote, and must say so.                                                                                                                     | Lane 3                  |
| 9   | Appeals                                                                                                           | L3-09 is `todo` (Lane 3 PROGRESS). The gate case needs no appeal if the first patch verifies. A weak-fix case would need it.                                                                                                                                          | Lane 3                  |
| 10  | One-stage-per-job trial driver (CR-7)                                                                             | Interim workaround merged (`stageScopedPorts`); a proper `runStage` is still a Lane 3 request. Risk: not verified under a real model.                                                                                                                                 | Lane 3                  |
| 11  | Live stream to the web UI and CLI: API process, SSE, web pointed at it                                            | `apps/api` has a runnable `main.ts` and tests (Lane 1 PROGRESS: done). Not verified: that the web UI's live client has run against it (L3-10 note says the real-stack check "waits on L1-12"). Starting the API next to the worker is listed as a not-done follow-up. | Lane 1, Lane 3          |
| 12  | The first real model call records recordings                                                                      | No recordings are committed (contracts changelog, CR-T11). A replay-mode dress rehearsal needs one live recording run first. Defense after a model refusal defaults to review (CR-T13): P8 found three of four models refused the probe input.                        | Lane 3, Adrian          |
| 13  | A rehearsal that proves the whole path before anyone watches                                                      | **Does not exist.** `pnpm e2e` is fake-backed and prints a notice that it does not test the gate criteria (`docs/demo-runbook.md`).                                                                                                                                   | Lead                    |
| 14  | Gate criteria: signed verdict, differential admission, family flip, replay on a second machine, containment suite | Pieces pass separately on the Lane 2 workstation (signer e2e 4 of 4, judge host suite 130 of 130, sandbox host suite 546 of 546). The combined run with real discovery and a real model has not happened.                                                             | All three lanes         |

## What I would do, in order

1. **Decide tier and date** (row 1 and the tier choice). Everything else is sized by it.
2. **Name owners** for the key (3) and signing custody (4), and confirm the host (2). These are yours; the work waits on them.
3. **Close row 6** by reviewing and merging or reworking PR #87 with the Lane 2 owner. Without a sealed bundle there is no signed verdict to show.
4. **Write the rehearsal (13)** as a single script that runs the gate case with the three switches `real` on the host and fails by name at the first missing prerequisite. It reports any step it cannot run as not run. Lead-owned, small, and it turns rows 7, 10, 11 and 14 into one yes or no.
5. **Run it once with live calls** at a low spend cap, record the model output (12), then rehearse from the recordings so the demo does not depend on a live provider on the day.
6. **Fix what the first run breaks.** I expect several things; I have no basis to say how many.
7. **Rewrite `docs/demo-runbook.md`** to say what is real, with Tier A as the fallback.

## `docs/demo-runbook.md` is stale

It was written before some work landed. Corrections needed, none made here:

- It says the API and live SSE "do not exist yet". `apps/api` now has a server entry and tests.
- "Real ports are not wired" no longer holds: the worker has real switches for intake, trial and Judge. They have not been run together.
- Its Windows note lists two Lane 2 symlink failures and a discovery timing flake. I have not rerun the Windows suite to see whether that note is still accurate. Two discovery timing tests did flake under a loaded parallel run this week and passed alone.

## Fallbacks for the day

- Tier A runs without Docker (`pnpm demo -- --memory`) and on Vercel with no backend.
- If the live path fails, say so and show the recorded stream: never present the fixtures as a live run.
- Every number shown stays `[metric]` unless a real run produced it.

## Decisions needed from Adrian

1. Which tier is the demo, and the date.
2. Who owns the Anthropic key and spend limit, and who holds the signing key.
3. Which host runs the demo, and whether the Lane 2 owner's workstation is acceptable for it.
4. Whether to go ahead with PR #87 so a bundle is sealed before the verdict.
