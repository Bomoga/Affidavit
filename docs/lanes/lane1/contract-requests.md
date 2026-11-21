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

**Interim.** `apps/worker` wires scripted fake trial stages (`apps/worker/src/fakes/stages.ts`). `AFFIDAVIT_TRIAL_IMPL=real` fails at startup with a not-wired error.

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
