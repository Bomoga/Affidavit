# CR-3 proposal: apply the F3 floor to every transition into `dismissed`

Status: **proposal for the lead**, not a change. You chose "every transition" on 2026-11-27. This note states the exact change so you can approve it. Nothing in `packages/contracts`, `packages/db` or `packages/testing` has been edited. The contract change is yours to land, and the store changes touch Lane 1 and Lead code.

## The rule today

`STAGE_TRANSITIONS` (`packages/contracts/src/common.ts`) allows `dismissed` from `arraign`, `defense` and `prosecution`. The F3 floor (a case whose candidate score is at or above the escalation floor may not be dismissed) is enforced only for `defense` to `dismissed`. `FakeCaseStore` and `PgCaseStore` mirror that. A case scored 0.9 against a floor of 0.7 can therefore go `intake`, `map`, `arraign`, `dismissed`, or `prosecution` to `dismissed`, and never meet Defense. That is a silent dismissal of a high-score candidate, which the project rules forbid.

## The change

1. **Contract comment** on `STAGE_TRANSITIONS` and the `CaseStore` docs: F3 applies to every transition into `dismissed`, from `arraign`, `defense` and `prosecution`. At or above the floor the store rejects it; the case goes on (`arraign` to `defense`, or to `escalated` where the table allows it, or to review).
2. **`FakeCaseStore`** (`packages/testing`): run the F3 check on all three source stages.
3. **`PgCaseStore` and the SQL guard** (`packages/db`): same rule in the TypeScript store and in the database function, so a direct SQL path cannot bypass it.
4. **Tests:** the shared table in `packages/db/src/transition-cases.ts` already has the cases to flip. Add `arraign` to `dismissed` and `prosecution` to `dismissed` at and above the floor (rejected) and below it (allowed), against both stores.
5. **Changelog:** `packages/contracts/CHANGELOG.md` entry, and a note in `docs/lanes/lane1/contract-requests.md` that CR-3 problem 1 is resolved.

## Effects to check before landing

- **Lane 1 dismissals.** Reasons such as `unreachable` recorded by Lane 1 at `arraign` are legitimate only when the score is below the floor. If any current path dismisses a high-score candidate at `arraign` on purpose, it must move to `escalated` or a review flag instead. I have not traced every caller. Search `dismissed` in `apps/worker` and `packages/discovery/src/arraign` first.
- **Lane 3.** Trial code that dismisses from `prosecution` must handle the new rejection as a halt to review, not as a crash. Lane 3 owns that check.
- **Lane 2.** No effect expected. Not verified.

## Not decided here

CR-3 problem 2 (`verify` to `verdict` with the jury enabled and appeals exhausted) is a separate question. It needs your answer on two points: may a case with appeals exhausted skip the jury, and does the jury setting belong on the case, so the database can enforce it? Until then the stores keep following the fake.

## Decision needed

Approve this change, and say who lands it. My recommendation is one PR across contracts, testing and db, reviewed by Lane 1 and Lane 3, because the three edits must agree.
