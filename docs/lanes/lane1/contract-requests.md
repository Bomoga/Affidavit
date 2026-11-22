# Lane 1 contract requests

Requests for changes to `packages/contracts`. Lane 1 does not edit contracts; the Lead decides.

## CR-1: identify patched variants (raised by L1-08)

**Problem.** `TargetRef` is `{ repo, commit, variant, imageDigest? }`. A corpus safe variant is the pinned commit plus a patch, so no real commit exists for it. The safe variant and the pinned vulnerable tree share the same `commit` and differ only by `variant: 'safe'`. The patch digests that really identify the tree live only in `@affidavit/corpus` data.

**Risks.**

- The Judge's differential check (F2) cannot tell from the `TargetRef` alone which patch produced the safe tree, so two different patches on one commit are indistinguishable.
- A negative control (a flagged but unexploitable pattern) is also pinned commit plus patches. It must never be mistaken for the differential known-safe tree. The corpus therefore does not give it a `TargetRef` with `variant: 'safe'`; it carries `role: 'negative-control'` and a `base` ref with `variant: 'vulnerable'`. Contracts have no representation for it.

**Request.** Add an optional field to `TargetRef`, for example `patchSetSha256: Sha256` (digest over the ordered patch digests), required when `variant` is `safe` or `patched` and no distinct commit exists. Optionally add a `negative-control` value to `TargetVariant`, or state that controls are never carried in `TargetRef`.

**Interim.** `@affidavit/corpus` identifies a variant by app id, variant id and ordered patch sha256 values, and tags controls separately.

## CR-2: fixture `nodegoat-sqli-001` mislabels the gate issue (informational)

The gate issue in NodeGoat at the pinned commit is MongoDB `$where` (NoSQL) injection at `app/data/allocations-dao.js` lines 77-79, not SQL, and the fixture's range 70-74 and rule id `sql-concat` do not match the pinned source. The corpus label records the truth. `fixtures/casefiles/` is not edited by Lane 1 in this task; the Lead or L1-04 should decide whether to rename the rule and regenerate the fixture.

## CR-3: the F3 floor rule covers one transition only; verify to verdict is ambiguous (raised by L1-09)

**Problem 1, F3 coverage.** `STAGE_TRANSITIONS` allows `dismissed` from `arraign`, `defense` and `prosecution`. The contracts comment and `FakeCaseStore` enforce the escalation floor (F3) only for `defense` to `dismissed`. `PgCaseStore` mirrors the fake, so a case with candidate score 0.9 and floor 0.7 can go `intake`, `map`, `arraign`, `dismissed` (or `prosecution` to `dismissed`) without ever reaching Defense. A reviewer reproduced this through `PgCaseStore`. That is a silent dismissal of a high-arraignment-score candidate, which the root rules forbid.

**Request.** State the intended rule in `common.ts` and the `CaseStore` docs. Either F3 applies to every transition into `dismissed` (so `arraign` and `prosecution` to `dismissed` are also rejected at or above the floor), or `arraign` to `dismissed` is reserved for Lane 1's own recorded dismissals (`Dismissal` reasons such as `unreachable`) and the table says so. Update `FakeCaseStore` and `PgCaseStore` together; the shared table in `packages/db/src/transition-cases.ts` already has the cases to flip.

**Interim.** Both stores keep the current behaviour (parity with the fake). The SQL guard in the database mirrors it too.

**Problem 2, `verify` to `verdict`.** The contracts changelog says verify goes to verdict "when the jury is disabled or appeals are exhausted". The fake allows it when the jury is disabled, or when the jury is enabled and appeals are exhausted (`appeals >= MAX_APPEALS`). Whether a case with appeals exhausted must still pass through the jury, or may go straight to a `not-proven` verdict, is not stated precisely. The stores follow the fake.

**Request.** Say which of the two paths is intended, and whether the jury-enabled setting belongs on the case (so a database can enforce it) or stays store configuration.

## CR-4: carry ingestion coverage with the case (raised by L1-01)

**Problem.** `ingestRepo` returns three facts that the contracts have no place for: whether the gitleaks run was `partial` (files it may have skipped or cut), the files kept out of the workspace and why (`.env` files, archives or binaries holding a secret, files too large to rewrite), and the `unsupported` outcome for a repo that is not Express, Koa, Fastify or Next API routes. `CaseFile.redactions` carries redaction locations only, which is all it should carry.

**Risk.** A partial secret scan is a signal that the redaction map may be incomplete. If it lives only in the worker's memory, a later stage or a reviewer cannot see that a case was ingested with gaps. Likewise `unsupported` has no `CaseStage` or `Dismissal` reason, so the worker (L1-10) has nowhere to record it except an ad hoc event.

**Request.** Either add an optional `ingest: { partial: boolean, excludedFiles: { path, reason }[] }` object to `CaseFile` (or `BundleManifest`), or state that these are worker-internal events. Add a way to record an unsupported repo: a `Dismissal` reason such as `unsupported-repo`, or an explicit stage outcome.

**Interim.** `@affidavit/discovery` exports typed `IngestOk.scan`, `IngestOk.excluded`, `IngestUnsupported` and `IngestIncomplete`; L1-10 decides how to persist them. `IngestIncomplete` (status `incomplete`, reason `partial-secret-scan`, with the coverage notifications) is what ingestion returns when the secret scan did not cover everything: it fails closed, keeps no workspace and never returns `ok`. The contracts have no stage outcome or `Dismissal` reason for it either, so the same request covers it: it needs a home (for example an escalation to human review, since a repo with an uncovered file cannot be ingested safely). Since L1-01c, `excludedFiles` can also carry `font-file`, an ok result's `scan` lists `binaryFontFiles` (each with a `binary-font` notification, kept out of the workspace) and `windowProvenFiles` (lockfiles and SVG files whose chunk-split risk the windows pass proved away); a CaseFile `ingest` object as requested above should be able to carry both. The redaction map with values (`SecretRedactor`) is memory only and is never persisted; the workspace on disk is already redacted, so later stages that slice it never see a secret.

## CR-5: dependency findings have no class or location in `Candidate` (raised by L1-03)

**Problem.** `Candidate.cls` is `injection | idor`, and `range` is a line range. An OSV-Scanner finding is a vulnerable package in a lockfile: it has no line, and most advisories are neither injection nor IDOR. The normalizer therefore (a) places an OSV candidate at line 1 of its lockfile, and (b) emits it only when the advisory's `database_specific.cwe_ids` maps to a MVP class. Every other advisory is returned in `skipped` with reason `unmapped-class`, so L1-06 can record it but cannot give it an `osv-no-path` dismissal (a `Dismissal` needs a `candidateId`).

**Request.** Either add a class such as `dependency` to `VulnClass` (and optional `package`/`version` fields to `Candidate`, or a `Candidate.location` union with a lockfile variant), or state that unmapped OSV findings are never candidates and need a different record.

**Interim.** The normalizer follows the first reading's constraints: no new fields, the `skipped` list carries tool, rule id, file and CWE numbers.

## CR-6: how a Semgrep rule declares its class (raised by L1-03)

Semgrep SARIF carries only a rule's `metadata.cwe` (as tags) in `properties.tags`; other metadata keys such as a custom `affidavit-class` are not emitted (checked on the pinned 1.184.0 image). The normalizer therefore derives `cls` from CWE numbers (injection: 74, 77, 78, 89, 90, 91, 94, 95, 564, 643, 917, 943; idor: 284, 285, 566, 639, 862, 863). Rules written for L1-04 must set `metadata.cwe` to one of these, or their findings are `skipped`. No contract change needed; recorded here so Lane 3 and L1-04 know the convention.

**Open questions for the lead (L1-03 review), not decided here.**

- Whether a `MalformedReportError` escalates the case or fails it.
- Whether OSV injection or IDOR advisories become trial candidates before CR-5 is answered.
- Where the merged rule ids live: the normalizer returns them in a Lane 1 side record (`NormalizeResult.merged`, with the OSV package per member) because `Candidate` has one rule id and one range.
- The CWE set: injection is 74, 77, 78, 89, 90, 91, 94, 95, 564, 643, 917, 943 and idor is 284, 285, 566, 639, 862, 863. Whether 284 and 285 belong in idor, and whether 1336 belongs in injection.
- An unsafe path on one finding is now a `skipped` entry (reason `unsafe-path`), not a report failure; say if that should escalate.
- Whether different CWEs in one class on the same range should stay separate candidates (today they merge into one).
- Whether one bad result (for example a bad line number) should reject a whole report, as now, or be skipped and recorded.

## CR-7: Lane 3 needs a single-stage entry point for the worker (raised by L1-10)

**Problem.** The queue runs one job per case stage, so a killed worker resumes at stage granularity. `Orchestrator.run(caseId)` in `@affidavit/trial` loops from the current stage to a terminal stage, builds its stage context privately, and emits `stage-entered` for the next stage before it checks the kill switch. The worker cannot drive one stage at a time through it without duplicating `stage-entered` events (a halted run emits one, and the next run emits it again). The trial handlers (`createDefenseHandler` and the others) take a context only the orchestrator can build, and there is no jury handler yet.

**Request.** An entry such as `Orchestrator.runStage(caseId)` that runs exactly the case's current stage, applies the resulting transition, emits `stage-exited` and the next `stage-entered` once, and returns. It must be safe to call again for the same stage after a crash (no second `stage-entered`, no second terminal verdict). This is a Lane 3 API rather than a contract change, but the shape belongs with the Lead.

**Interim.** `apps/worker` wires scripted fake trial stages by default. With `AFFIDAVIT_TRIAL_IMPL=real` (L1-10b) each stage job runs `Orchestrator.run` through `stageScopedPorts` (`@affidavit/db`): the kill switch it sees is also on once the job has moved the case, so one job moves it one stage, and the repeated `stage-entered` of a stage the visit already entered is dropped. One Orchestrator per process, so the workspace and cost ledger do not survive a restart (see `docs/lanes/lane1/real-wiring.md`). `runStage` would remove all of this.

## CR-8: how a case that needs a person is escalated (raised by L1-10)

**Problem.** When recovery cannot retry a stage (attempts used up, or the case budget is exhausted) the case must not be dropped and must not be dismissed. `STAGE_TRANSITIONS` allows `escalated` only from `defense` onward, an `Escalation.reason` has no value for "attempts exhausted", and a terminal `escalated` case needs a Verdict that only Lane 3 can build.

**Interim.** `@affidavit/db` writes an insert-only `review_flags` row (tenant, case, stage, attempt, reason `attempts-exhausted` or `budget-exhausted`, detail). The case stays at its stage and is excluded from the recovery sweep until a person acts. Nothing reads the flags yet (API, CLI and the courtroom do not show them).

**Request.** Decide the shape: an `Escalation.reason` member for attempts exhausted, whether `escalated` should be reachable from `intake`, `map` and `arraign` (with a Lane 1 written Verdict), and how a person clears a flag. Then `review_flags` can be replaced by the real escalation.

## CR-9: no push or subscribe API for case events, so the CLI polls (raised by L1-11)

**Problem.** `affidavit scan` has to stream a case's events to the terminal. The only read path is `PgEventSink.events(caseId, afterSeq)` (a Lane 1 method beyond the `EventSink` port, which has `emit` only). There is no subscribe, `LISTEN/NOTIFY` or push API, so the CLI polls it every 500 ms by default (`--poll-ms`) until a terminal event (`verdict-written`, `escalated`, `budget-exhausted`) or a timeout (`--timeout`, default 120 s).

**Request.** None blocking. When L1-12 adds the SSE endpoint, decide whether the CLI should read that stream instead, and whether the `events` read belongs on a port in `packages/contracts` (for example an `EventLog` port with `events(caseId, afterSeq)` and an optional subscribe). Until then the CLI depends on `@affidavit/db` directly, an approved Lane 1 dependency (L1-11 brief).

## CR-10: the map's answer is richer than `Candidate.reachability` and `RouteInfo` (raised by L1-05)

**Problem.** The map returns, per candidate, a three-valued reachability that fits `Candidate.reachability`, and a route that fits `RouteInfo` (`CaseFile.route`). Four facts it also produces have no home in contracts:

- The reason for `unknown` (`route-not-mounted`, `external-entry`, `referenced-unresolved`, `repo-incomplete`, `file-incomplete`, `file-not-analyzed`, `no-enclosing-function`, `dynamic-require`). An `unknown` on a high-score candidate must go to trial or review (F3); the reviewer, and the audit trail, need to see why it is not a clean `reachable` or `unreachable`.
- The function path from the route entry to the sink (up to 5 paths, shortest first). Slice assembly (L1-07) and Defense could use it to show the call chain.
- Map coverage: files skipped or only partly parsed, limits hit (steps, time, files), and leaks (dynamic require, dynamic dispatch, `eval`, routes on receivers it could not tie to Express). A partial map is the same kind of signal as CR-4's partial secret scan.
- Two meanings of `RouteInfo.middleware` and `RouteInfo.path` the contract does not state. The map's `middleware` is the chain in front of the handler without application-wide `app.use(fn)` middleware (listed separately as `appMiddleware`); a path part it cannot reduce to a string is written `${name}`; a reachability entry that is a `use` registration (an error handler) has method `USE`.

**Request.** Either add optional fields (for example `Candidate.reachabilityReason: string`, `CaseFile.callPath`, and a coverage object next to CR-4's `ingest`), or state that these stay Lane 1 internal and are recorded as events. State the `RouteInfo.middleware` convention above, and whether `method: 'USE'` and `${...}` path parts are allowed in `CaseFile.route`.

**Interim.** `@affidavit/discovery` exports `CandidateReachability` (value, reason, detail, function, paths), `MapCoverage` and `MapRoute` (with `appMiddleware`, `chain`, `mounted`, `pathDynamic`). `routeInfoOf(path)` returns a contract-valid `RouteInfo` and L1-07 should prefer a `reachable` path whose method is not `USE`. L1-06 treats `unknown` as "not dismissed".

`RouteInfo.authRequired` is a heuristic from the middleware chain only: it cannot see an ownership or login check written inside a handler, and `true` means "a guard was proven by name (package) or by body (repo code)", never more. `'unknown'` is used whenever the guard is optional, conditional, scoped to a path the map cannot pin down, or the chain has an item it could not resolve.

## CR-11: the real Judge has no per-case target, and nothing seals a bundle (raised by L1-10b)

**Problem.** `AFFIDAVIT_JUDGE_IMPL=real` builds `Judge(JailExecutor({ targets: new BootedTargets() }), DEFAULT_POLICY)`. `BootedTargets` serves a variant only after it was booted (`bootVariant` from source with the case's boot hints) and only when `CaseFile.target.imageDigest` equals the booted image ID. A discovery case file has no `imageDigest`, and the stored case file cannot change after `CaseStore.open`. So nothing can boot the vulnerable and safe variants for a case and tie the case file to them, and every witness fails closed. `verifyPatch` also needs a `PatchWorkbench` and a `RescanPort`, and no stage seals an evidence bundle with the signer.

**Request.** Decide where the boot happens: (a) before `open` (`open-case` builds and boots both variants, writes `imageDigest`, and the worker keeps the targets running for the case), or (b) a contract change so the Judge (Lane 2) boots per case and the digest is recorded as an event or a Judge-owned field rather than in the immutable case file. Also: which stage seals the bundle (after verify, before the verdict), and the ports for the workbench and rescan in the worker.

**Status.** Answered for the boot by #61 (option b): `createRealJudge` boots each case's variants (`CaseTargets`) and binds the digests on a copy of the case file; the worker uses it for `AFFIDAVIT_JUDGE_IMPL=real` (L1-10b). The `RescanPort` is provided by L1-17 (`DiscoveryRescan`, wired when intake is also real; no contract change was needed). Still open: the bundle sealing stage, and whether a "targets booted" event carries the digests (contracts). Intake refusals (`unsupported`, `incomplete`) remain failed attempts plus a review flag (CR-4, CR-8).

## CR-12: child processes of other lanes' components inherit the worker environment (raised by L1-10c)

**Problem.** `GvisorToolRunner` (`packages/sandbox/src/gvisor/runner.ts`, `spawn('docker', args)`), `LocalDockerToolRunner` (`packages/testing/src/infra.ts`, `execFile('docker', ...)`) and the target build (`packages/sandbox/src/boot/build.ts`, `{ ...process.env, DOCKER_BUILDKIT }`) start `docker` with the parent's whole environment. In the worker that environment held `ANTHROPIC_API_KEY`, both database URLs and the repository sources.

**Interim (L1-10c).** The worker entry points (`main.ts`, `open-case`) call `sealSecrets` after `loadConfig`: those variables are moved out of `process.env` into a private snapshot the wiring reads (the model port gets the key through its `env` override). The worker's own `docker info` probe passes an explicit minimal environment (`childEnv` in `apps/worker/src/real/child-env.ts`). Tested with a canary variable and a stub child.

**Request.** Lane 2 and the lead (`packages/testing`): an `env` option on each runner and on the target build, defaulting to a minimal allowlist (what the Docker CLI needs) instead of `process.env`, so a component is safe on its own and not only behind the worker's seal.

## CR-13: an F3 hold found by `open-case` has no contract slot (raised by L1-10c)

**Problem.** A discovery scan can hold candidates for review (F3: a dismissal rule matched at or above the escalation floor). `open-case` must record each one durably, but no contract event or stage fits a hold found before trial: `escalated` is reachable from defense onward only, and `Escalation.reason` has no pre-trial value.

**Interim (L1-10c).** Each hold is opened as a case of its own at intake with its assembled case file and flagged for a person: `review_flags` reason `f3-hold` (migration 0007), detail with arraignment's `wouldDismiss`, `route` and detail, no stage job (`openHeldCase` in `@affidavit/db`). The recovery sweep leaves a flagged visit alone, so it is never queued or dismissed.

**Request.** Decide how a `person-or-trial` hold reaches a second Defense attempt (an operator action that clears the flag and enqueues intake, or a contract path), and whether a hold is an event (for example `held-for-review` with the route) so the courtroom can show it. Related: CR-8.

## CR-14: a case file cannot say which scanners did not run (raised by L1-18)

**Problem.** Real intake runs Semgrep only. OSV-Scanner (dependency findings) is left out because it needs a writable temp directory under `/tmp`, which the gVisor tool runner reserves read-only (it runs only on plain Docker, in tests). A real case file therefore holds no dependency findings, and no contract field records that the dependency scan was not run, so a reader of the case file or the courtroom cannot tell "no vulnerable dependency" from "not checked".

**Interim (L1-18).** Whenever intake is real, the worker and `open-case` log `intake: dependency scan not run` at startup (`DEPENDENCY_SCAN_WARNING` in `apps/worker/src/config.ts`), and `docs/lanes/lane1/real-wiring.md` lists it under what still blocks a real verdict.

**Request.** Lead: a scanner-coverage note in the case file (for example the scanners run, with their pinned references, and the ones not run with a reason enum such as `not-supported-in-jail`), so the gap travels with the case. Lane 2: a way for the tool runner to give a tool a private writable temp directory that OSV-Scanner can use (it reads its offline database from `$TMPDIR/osv-scalibr`); Lane 1 then adds OSV to real intake.

**Status (2026-11-21).** The contracts part landed in v1.2: optional `CaseFile.scanners: ScannerCoverage[]` (see `packages/contracts/CHANGELOG.md`). The Lane 2 temp-directory part is still open.

## Contracts v1.2 follow-ups for Lane 1 (from the lead)

Contracts v1.2 (`packages/contracts/CHANGELOG.md`) is additive: nothing in Lane 1 has to change to keep compiling, and nothing was implemented in Lane 1 packages beyond the line noted at the end. What Lane 1 should do with it:

1. **`packages/db`: `PgCaseStore.releaseCharge(caseId, refund, reservationSeq)` (CR-T1).** One transaction that:
   - returns the current budget and changes nothing when a release for `(tenant_id, case_id, reservationSeq)` already exists (a unique key; idempotent);
   - throws `ReleaseRejectedError` (from contracts) when the event at `reservationSeq` is not a `cost-charged` event for this case, when the refund names another stage or attempt, or when any refund field exceeds that event's `cost`;
   - throws `ReleaseRejectedError` when the case's total releases would exceed its total charges for input tokens, output tokens or usd (the ledger never goes negative);
   - otherwise adds `refund` back to `remaining_input_tokens`, `remaining_output_tokens` and `remaining_usd`, recomputes `exhausted` with the same rule as `chargeBudget`, and records the release (a `cost_releases` table, or a `kind` column on `cost_rows` with the `usd >= 0` check kept for charges). Reports that sum `cost_rows` subtract releases.
   - The method is optional on `CaseStore` in v1.2 so every store keeps compiling; the lead plans to make it required at the next major bump. `FakeCaseStore` in `packages/testing` is the reference behaviour (`new FakeCaseStore({ events })`).
2. **`packages/db`: forward `releaseCharge`** through `GuardedCaseStore` (`orchestration.ts`) and `stageScopedPorts` (`stage-scope.ts`), with the same tenant and kill-switch guards as `chargeBudget`.
3. **`apps/worker/src/real/trial.ts`: wire the settlement** (CR-T1 step 2): pass `settlement: { release: (id, r, seq) => store.releaseCharge(id, r, seq) }` to the `Orchestrator` once the store has it.
4. **Intake writes `CaseFile.scanners` (CR-14).** For real intake: `semgrep` and `gitleaks` with `ran: true` and `ref` set to the pinned image digest; `osv` with `ran: false, reason: 'not-supported-in-jail'` until the tool runner gives it a temp directory. Fake intake may leave the field absent (absent means "not recorded", never "all ran"). Keep `DEPENDENCY_SCAN_WARNING` until OSV runs.
5. **`apps/cli`: `halted` is not terminal.** `watchCase` keeps polling after a `halted` event, since the case resumes at the same stage. Consider printing it and exiting with a code of its own instead of waiting for the timeout; that is a Lane 1 choice.
6. **`apps/api` and SSE:** no change needed; the two new event types pass through as `TrialEvent`.

Done in the v1.2 PR inside Lane 1, only so the build stays green: `apps/cli/src/render.ts` gained `cost-released` and `halted` cases in its total switch (one detail line each, through `sanitize`), with a render test in `cli.test.ts`.

## Lane 3 L3-21 follow-ups (from Lane 3, PR #84)

Written by Lane 3 at the coordinator's request; nothing in Lane 1 packages was edited. `@affidavit/trial` now settles every model call's reservation, emits `cost-released` and `halted`, and has a separate stop hook. What `apps/worker` and `packages/db` need:

1. **`apps/worker/src/real/trial.ts`, stop after one transition without a false halt.** Today `config.killSwitch` is `async () => (await w.killSwitch()) || scope().advanced()`, so after every normal advance the orchestrator records `halted { reason: 'kill-switch' }`. Change the `Orchestrator` config to:

   ```ts
   config: {
     killSwitch: w.killSwitch,
     stopAfterTransition: () => scope().advanced(),
     maxStageAttempts: w.maxStageAttempts,
   },
   ```

   `run` then returns `{ status: 'stopped', stage }` after the move, with no event. The `outcome.status === 'halted' && !ports.advanced()` check in `core` is unchanged; a `stopped` outcome is a normal end of the job.

2. **`apps/worker/src/real/trial.ts`, a refusal halt is review, not a retry.** For `outcome.status === 'halted'` with `reason: 'model-refusal'` (it carries `refusalCategory`), flag the stage for review at once instead of throwing the retryable `TrialHaltedError`: each recovery retry (up to `AFFIDAVIT_MAX_STAGE_ATTEMPTS`) reruns Defense and asks the refused model again. Also word `TrialHaltedError` by reason; today every reason other than `model-unconfigured` reads as the kill switch.
3. **`packages/db` `stageScopedPorts`, return the assigned seq.** The scoped store's `nextSeq` returns a placeholder 0 and the scoped sink assigns the real seq, so the orchestrator cannot tell which seq a `cost-charged` event got. Have the scoped sink's `emit` return the seq it assigned (or the stored event), for example `const seq = await inner.nextSeq(event.caseId); await env.sink.emit(TrialEvent.parse({ ...event, seq })); return seq;`, and return nothing for a dropped `stage-entered`. A `Promise<number>` emit does not type-check as a contract `EventSink` (checked with tsc), so type `StageScopedPorts.sink` (and the worker's `Scope.sink`) structurally as `{ emit(event: TrialEvent): Promise<number | void> }`. `OrchestratorDeps.sink` accepts that shape (`ReportingEventSink` in `@affidavit/trial`) as well as any `EventSink`. Until this lands the orchestrator sees repeated seqs and releases nothing (it fails closed), so a Postgres case keeps today's over-count.
4. **`packages/db` `stageScopedPorts`, forward `releaseCharge`** (item 2 of the v1.2 follow-ups above), or pass `settlement` from the worker (item 3): the scoped store has no `releaseCharge` today, so without one of the two nothing is released.
