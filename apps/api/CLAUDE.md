Read docs/plan.md, then docs/implementation-plan.md section 5 (Lane 1) before working in this package.

# @affidavit/api

**Owner:** Lane 1 (Intake and Platform)

**Mission:** Fastify API: auth, cases, webhooks, and the SSE stream of trial events (L1-12).

## Commands

Run from this directory, or add `--filter @affidavit/api` from the repo root.

- `pnpm typecheck`, `pnpm lint`, `pnpm test` (Fastify `inject` on the in-memory backend; no database)
- `pnpm test:pg` runs `src/*.pg.test.ts` against real Postgres through the `affidavit_app` role. Same pattern as `packages/db`: `AFFIDAVIT_TEST_DATABASE_URL` is the superuser URL of a THROWAWAY server; the suite creates and drops its own database and skips with a message without the variable.
- `pnpm dev`: loopback dev auth on `127.0.0.1:3000`, in-memory store seeded with the two `fixtures/trials` cases (`case-nodegoat-sqli-001`, `case-escalated-001`), fake intake, and a new case gets the nodegoat fixture replayed into it (`AFFIDAVIT_DEV_REPLAY_MS`, default 300). CORS allows `http://localhost:5173` and `http://127.0.0.1:5173`. Any variable already set wins.
- `pnpm start`: the same entry point with no defaults (production config from the environment).

## Routes (exactly `ApiRoutes` in `@affidavit/contracts`, plus auth and health)

| Route                                                                                    | Auth                                | Notes                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /cases`                                                                            | yes, CSRF when cookie-authenticated | JSON only, body cap 16 KiB, `repoUrl` must be https with no credentials. Fake intake only (`AFFIDAVIT_INTAKE_IMPL=fake`, as the CLI); otherwise 501 `intake-not-implemented`. 201 `CreateCaseResponse`. 20 per minute.                    |
| `GET /cases/:id`                                                                         | yes                                 | `GetCaseResponse` with `caseFile` and `verdict` when written.                                                                                                                                                                             |
| `GET /cases/:id/events`                                                                  | yes                                 | SSE of `TrialEvent`, see below. 16 open streams per tenant.                                                                                                                                                                               |
| `GET /cases/:id/verdict`                                                                 | yes                                 | `Verdict`; own case without a verdict is 404 `verdict-not-written`.                                                                                                                                                                       |
| `GET /bundles/:sha256`                                                                   | yes                                 | STUB: validates the digest and answers 501 `not-implemented` until Lane 2 signing (L2-08, L2-09) exists. Must be tenant-scoped when implemented.                                                                                          |
| `POST /webhooks/github`                                                                  | HMAC                                | `X-Hub-Signature-256` over the raw body, checked in constant time BEFORE parsing; bad or missing signature 401. 503 without `AFFIDAVIT_GITHUB_WEBHOOK_SECRET`. Body cap 1 MiB. Handler is a no-op (`onWebhook`) until L1-15; answers 202. |
| `GET /auth/github/login`, `/auth/github/callback`, `GET /auth/csrf`, `POST /auth/logout` | github mode only                    | OAuth web flow and CSRF token.                                                                                                                                                                                                            |
| `GET /healthz`                                                                           | no                                  | `{ "status": "ok" }`.                                                                                                                                                                                                                     |

## SSE wire format (CR-T10, resolved here)

- Every message is `id: <seq>` then `data: <one TrialEvent as single-line JSON>` then a blank line. No `event:` field (default `message`). The stream opens with a comment and `retry: 2000`; idle streams get a `: keepalive` comment every 15 s.
- Resume: the client sends the last seq it has, either as the `Last-Event-ID` header (what EventSource sends) or as `?after=<seq>`. The server sends only seqs greater than it. Both present: the larger wins. Absent: from the start. Malformed (not a non-negative integer without leading zeros): 400 `invalid-resume-position`.
- Seqs are sent in order and contiguously from 0. A stored hole (a seq allocated by a writer that died before emitting) is held back for `holeWaitMs` (5 s) and then skipped.
- The server closes the stream cleanly when the case has sat at a terminal stage for `terminalGraceMs` (2 s) with nothing new, after `maxStreamMs` (30 min), or when the client goes away. Polls the store every second (no push yet).
- A case the caller cannot see is a 404 before any stream starts, so a client stops instead of retrying.

## Auth

- `AFFIDAVIT_AUTH` is required: `dev` or `github`. Anything else refuses to start (exit 3). Messages name variables, never values.
- `dev`: one fixed tenant (`AFFIDAVIT_DEV_TENANT_ID`, default `tenant-dev`), no credential. Refuses unless `AFFIDAVIT_API_HOST` is loopback, checks the bound address again after listen, and refuses any request whose Host header is not loopback (DNS rebinding). The memory store is allowed only here.
- `github`: needs `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `AFFIDAVIT_GITHUB_OAUTH_REDIRECT_URL` and an `AFFIDAVIT_SESSION_SECRET` of 32+ characters, or refuses to start. Optional `AFFIDAVIT_GITHUB_POST_LOGIN_URL`. State is a signed cookie compared in constant time; the access token is used once to read the user id and dropped; the session cookie is signed, httpOnly, Secure, SameSite=Lax and holds only a random session id, the tenant and the user id. Sessions are server-side (`SessionStore`, src/session-store.ts): every request checks the record, 8 hours absolute and 1 hour idle, and logout deletes it, so a copied cookie stops working. Capacity: at most 5 live sessions per user (a new sign-in replaces that user's own oldest) and 10,000 in all; when full, a new sign-in gets 503 `sessions-full` with `Retry-After: 60` and no other session is evicted. Expired sessions are removed on use, at the cap, and by a 5 minute sweep. The OAuth callback (which creates sessions) is limited to 10 per minute per IP. The default `MemorySessionStore` is per process (lost on restart, not shared between instances); a Postgres `sessions` table with forced RLS is the follow-up for more than one instance. Tenant is `github-<user id>` and must be provisioned by the owner (`provisionTenant`) or POST /cases answers 403 `tenant-not-provisioned`.
- Cookie-authenticated mutating routes need `x-csrf-token` (from `GET /auth/csrf`, header only). Every POST except the webhook is refused when its `Origin` is not in `AFFIDAVIT_WEB_ORIGINS`.

## Invariants

- Tenant scoping: every route resolves the principal first and goes through `CaseBackend.forTenant(tenant)`. Postgres: `PgCaseBackend` uses an `openPool(..., 'affidavit_app')` pool, so RLS applies. A missing case and another tenant's case return the identical body `{"error":"not-found"}`.
- Ids are validated before any lookup: case id `^[A-Za-z0-9_-]{1,128}$` (same rule as the web client and MCP server), bundle digest `^[0-9a-f]{64}$`.
- Error bodies are `{ "error": <fixed code> }` from `src/errors.ts`. Nothing from the request is echoed; 500s carry no detail and log only a scrubbed message.
- Logs record method, path (no query string) and status. No header, cookie, body or secret is logged; a test asserts this.
- Strict CSP (`default-src 'none'`, `frame-ancestors 'none'`), HSTS, nosniff, `no-referrer`, CORP same-origin, `Cache-Control: no-store`. CORS allows only exact `AFFIDAVIT_WEB_ORIGINS`, credentials only in github mode.
- Rate limits: global `AFFIDAVIT_RATE_LIMIT_MAX` per minute per IP (default 300), plus per-route limits. `trustProxy` is off: behind a proxy every client shares one bucket (follow-up).
- Configuration: `AFFIDAVIT_API_HOST`, `AFFIDAVIT_API_PORT`, `AFFIDAVIT_API_STORE` (`memory` or `postgres`), `AFFIDAVIT_APP_DATABASE_URL` (secret), `AFFIDAVIT_INTAKE_IMPL`, `AFFIDAVIT_WEB_ORIGINS`, `AFFIDAVIT_GITHUB_WEBHOOK_SECRET` (secret), `AFFIDAVIT_API_LOG_LEVEL`.

Root CLAUDE.md rules apply here. Do not add dependencies without asking. `@affidavit/testing` and `pg` are dev dependencies for tests only.
