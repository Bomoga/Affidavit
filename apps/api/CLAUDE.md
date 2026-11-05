Read docs/plan.md, then docs/implementation-plan.md section 5 (Lane 1) before working in this package.

# @affidavit/api

**Owner:** Lane 1 (Intake and Platform)

**Mission:** Fastify API: auth, cases, webhooks, and the SSE stream of trial events.

## Commands

Run from this directory, or add `--filter @affidavit/api` from the repo root.

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Intended libraries (notes for later, not installed yet)

- Fastify
- Graphile Worker (job enqueue)
- @affidavit/contracts and @affidavit/db (workspace deps)

Root CLAUDE.md rules apply here. Do not add dependencies without asking.
