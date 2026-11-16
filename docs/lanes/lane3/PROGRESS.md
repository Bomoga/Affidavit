# Lane 3 progress

Owner: Adrian
Contracts version in use: v1.0 is on `main` (Phase 0 merged, PR 11). Lane 3 code still runs on interim local types; migration to `@affidavit/contracts` and `@affidavit/testing` is the next task.

## Tasks

| ID | Status (todo, doing, done, blocked) | Branch or PR | Notes |
| --- | --- | --- | --- |
| L3-01 | done | lane3/L3-01-orchestrator (PR 5) | On contracts v1.0 ports and `@affidavit/testing` fakes; interim types and local fakes deleted. Turn budget charged before each model call; exhaustion escalates with a contract `Escalation`; kill switch halts with reason `kill-switch`; every emitted event parses as `TrialEvent`. Graphile job wrapper deferred to apps/worker. Contract requests CR-T1 to CR-T4 in `contract-requests-trial.md` |
| L3-02 | done | lane3/L3-02-safety-envelope (stacked on PR 5) | Tool allowlists and schema admission. Validator is injected until contracts land |
| L3-03 | done | lane3/L3-03-prompts-package (PR 2) | Prompts, untrusted wrapper, append-only version history. `PromptId` and `Role` come from `@affidavit/contracts`; tests assert the id list matches and every `outputSchemaRef` is a `schemaRegistry` key. Prompts at 1.1.0 |
| L3-04 | done | lane3/L3-04-defense (stacked on PR 6) | Renderer injected; real L1-07 planted-instruction case file still to run |
| L3-05 | done | lane3/L3-05-remedy (stacked on PR 7) | Interim VerifyResult and TrialWorkspace; counterexamples empty until L3-08 |
| L3-06 | done | lane3/L3-06-verdict (stacked on PR 8) | Interim Verdict and exhibit id pattern; dismissed and escalated verdicts not wired yet |
| L3-07 | doing | lane3/L3-07a-design-tokens, lane3/L3-07b-case-view-model (partial) | Tokens and contrast done (PR 3). View model and fake SSE source done (PR 10). React, Vite, TanStack Router and Query, and Testing Library are installed in `apps/web` (P0-02); shell, router and case view are next |
| L3-08 | todo | | Phase 2 |
| L3-09 | todo | | Phase 2 |
| L3-10 | todo | | Phase 2 |
| L3-11 | todo | | Phase 3 |
| L3-12 | todo | | Phase 3 |
| L3-13 | todo | | Phase 3 |
| L3-14 | todo | | Phase 3 |

## Blocked

- None on Phase 0 any more. Open work: migrate the interim types in `packages/trial/src/interim` and `apps/web/src/model` to `@affidavit/contracts`, swap local fakes for `@affidavit/testing`, and move the placeholder fixtures to `fixtures/trials/`.

## Decisions made in this lane

- 2026-11-03: `packages/prompts` has a pure-TypeScript SHA-256 instead of `node:crypto`, because at the time no Node typings were installed. `@types/node` is now a root dev dependency (P0-02), so a later version may switch to `node:crypto`; the digests do not change either way.
- 2026-11-03: Prompt versioning uses an append-only history of (version, digest) per prompt. A prompt whose text changes under an unchanged version fails `versions.test.ts`.
- 2026-11-03: The second Defense attempt is its own prompt id (`defense-second-attempt`) so it differs in text from the first, as F3 requires. The model difference is the orchestrator's job (L3-04).

- 2026-11-03: Adrian approved interim local types for L3-01 so work is not idle while Phase 0 is pending. They live only in `packages/trial/src/interim` and `src/testing`, and are deleted when contracts v1.0 and `@affidavit/testing` land.
- 2026-11-03: Orchestrator charges a worst-case reservation before each model call and settles to actual cost after. The real `CaseStore` port needs `chargeBudget` (returns a receipt), `settleCost`, and `nextSeq`. Kill switch escalates with reason `budget-exhausted`; `escalated` must be reachable from any non-terminal stage. (Superseded 2026-11-15, below.)
- 2026-11-15: Migrated to contracts v1.0. v1.0 `CaseStore.chargeBudget` returns `BudgetState` and has no settle call, so the turn budget is charged up front and never refunded (CR-T1); `Verdict.cost` reports what calls actually cost.
- 2026-11-15: A tripped kill switch is a halt, not an escalation and not a budget exhaustion. `run` returns `{ status: 'halted', reason: 'kill-switch' }` and the case stays at its stage so it can resume (CR-T3).
- 2026-11-15: Intake, map, and arraign never call a model and never escalate; `STAGE_TRANSITIONS` has no route from them to `escalated`, so the orchestrator throws `EscalationNotAllowedError` and the case stays put (CR-T4).

## Metrics from real runs

- None yet. All metrics are [metric].
