# Lane 3 progress

Owner: Adrian
Contracts version in use: none yet (Phase 0 contracts, ports, fakes, and fixtures have not landed on `main`)

## Tasks

| ID | Status (todo, doing, done, blocked) | Branch or PR | Notes |
| --- | --- | --- | --- |
| L3-01 | todo | | Needs P0-03, P0-04 |
| L3-02 | todo | | Needs L3-01. Write the per-role tool allowlist enumeration test first |
| L3-03 | done | lane3/L3-03-prompts-package (PR pending review) | Prompts, untrusted wrapper, append-only version history. Role and schema names are string refs until contracts land |
| L3-04 | todo | | Needs L3-02, L3-03 |
| L3-05 | todo | | Needs L3-04 |
| L3-06 | todo | | Needs L3-05 |
| L3-07 | todo | | Needs P0-05 for fixtures; React, Vite, TanStack are not installed until P0-02 |
| L3-08 | todo | | Phase 2 |
| L3-09 | todo | | Phase 2 |
| L3-10 | todo | | Phase 2 |
| L3-11 | todo | | Phase 3 |
| L3-12 | todo | | Phase 3 |
| L3-13 | todo | | Phase 3 |
| L3-14 | todo | | Phase 3 |

## Blocked

- L3-01, L3-02, L3-04 to L3-06: blocked on Phase 0 (contracts v1.0, ports, `packages/testing` fakes). Nothing to try; waiting on P0-03 and P0-04 to merge to `main`.
- L3-07: blocked on P0-02 (UI dependencies) and P0-05 (`fixtures/trials`). Lane 3 may not add dependencies itself.

## Decisions made in this lane

- 2026-11-03: `packages/prompts` has a pure-TypeScript SHA-256 instead of `node:crypto`, because no Node typings are installed and adding `@types/node` is outside the approved dependency list.
- 2026-11-03: Prompt versioning uses an append-only history of (version, digest) per prompt. A prompt whose text changes under an unchanged version fails `versions.test.ts`.
- 2026-11-03: The second Defense attempt is its own prompt id (`defense-second-attempt`) so it differs in text from the first, as F3 requires. The model difference is the orchestrator's job (L3-04).

## Metrics from real runs

- None yet. All metrics are [metric].
