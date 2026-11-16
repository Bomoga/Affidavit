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
