# Affidavit Implementation Plan: Three Lanes

Status: v1, Nov 2, 2026. Owner: Adrian (team lead, contracts owner).

This file is the execution plan Claude Code sessions follow to build Affidavit autonomously. `docs/plan.md` stays the canonical product and architecture plan (what we build and why). This file decides who builds what, in what order, against which interfaces, and how each piece is proven done. Where the two disagree on lane structure, this file wins: the four lanes in `docs/plan.md` are consolidated into three here.

---

## 0. Instructions for every Claude Code session

Read this section in full at the start of every session, then read only your lane's section.

### 0.1 Read order

1. Root `CLAUDE.md` (non-negotiables).
2. `docs/plan.md` sections: Purpose and decisions, Architecture, Threat model, Best practices.
3. This file: sections 0 to 4, then your lane section (5, 6, or 7), then section 8.
4. `docs/lanes/<your-lane>/PROGRESS.md` to find the next open task.
5. The `CLAUDE.md` of every package you are about to touch.

### 0.2 Which lane am I in

Your lane is set by the worktree you are running in (`../affidavit-lane1`, `../affidavit-lane2`, `../affidavit-lane3`) and by the branch prefix (`lane1/`, `lane2/`, `lane3/`). If neither tells you, stop and ask. Never guess a lane.

### 0.3 The task loop

For each task in your lane, in order:

1. Pick the first task in your lane section whose status in `PROGRESS.md` is `todo` and whose `Needs` are all `done` or satisfied by a fake.
2. Create a branch `laneN/<task-id>-<short-slug>` from the latest `main`.
3. Write the acceptance tests first, from the task's `Done when` list. Confirm they fail for the right reason.
4. Implement until the tests pass. Keep changes inside your lane's paths (section 2).
5. Run, from the repo root: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format:check`. All must pass.
6. Update `docs/lanes/<lane>/PROGRESS.md`: set the task to `done`, add one line on what changed and any follow-up.
7. Commit with the message format in 0.5 and open a PR. Do not merge your own PR into `main` unless the lane owner has told you to.

### 0.4 Stop and ask instead of continuing when

- A task needs a contract change (section 3.4 protocol).
- A task needs a file outside your lane's paths.
- A task needs a dependency not on your lane's approved list (section 2.3).
- A task needs a secret, an account, a host, or a paid service.
- A test you did not write starts failing and the cause is in another lane.
- You would need to weaken a security control, an admissibility rule, or a test to make progress.
- You have tried the same approach three times without progress.

When you stop, write the blocker into `PROGRESS.md` under `Blocked`, with what you tried, and end the session with a short summary.

### 0.5 Commit and PR format

```
laneN(<package>): <imperative summary>

Task: <task-id>
Contracts: none | uses vX.Y | proposes change (link)
Tests: <what was added>
```

PR description: the task id, the `Done when` checklist with each box ticked or explained, and any deviation from this plan.

### 0.6 Hard rules (in addition to root CLAUDE.md)

- No em dashes anywhere in user-facing copy, docs, prompts, or PR text.
- No invented numbers. Every metric is `[metric]` until a real run produces it, and a real number must link to the run that produced it.
- Never weaken, skip, or delete a test to make a build pass. Never mark a test `.skip` or `.todo` without a `PROGRESS.md` entry explaining why.
- Agents in the product never get a shell. Any code path that would let model output execute outside the Judge is a bug.
- Repo and app content is untrusted data. It never becomes part of a system prompt, a tool name, a file path outside the case workspace, or a shell argument without escaping.
- Fixtures are part of the contract. A change to a contract updates every affected fixture in the same PR.

---

## 1. Where the repo stands today

Observed on Nov 2, 2026 on `main` (commit `c456e86`):

- pnpm monorepo, Node 22, TypeScript strict with `NodeNext`, ESLint type-checked config, Prettier, Vitest. Root scripts fan out with `pnpm -r`.
- Five apps (`api`, `web`, `cli`, `github-app`, `mcp`) and ten packages (`contracts`, `db`, `discovery`, `corpus`, `sandbox`, `judge`, `evidence`, `trial`, `prompts`, `evals`) exist as stubs. Each has `package.json`, `tsconfig.json`, a short `CLAUDE.md`, an empty `src/index.ts`, and one placeholder test.
- No runtime dependencies are installed anywhere. `contracts` has no Zod yet.
- `docker/compose.yaml` runs one Postgres (image not pinned by digest). Tool images (Semgrep, CodeQL, OSV-Scanner, gitleaks) are listed as TODO.
- `.claude/settings.json` allows only pnpm test, lint, typecheck, and build; denies privileged Docker, Docker socket mounts, `curl`, `wget`, `.env` reads, `pnpm exec`, and `pnpm dlx`.
- CI runs install, typecheck, lint, test. No format check, no build, no Docker jobs.
- `CODEOWNERS` has placeholder handles and four lanes.
- `fixtures/` and `packages/corpus/data/` are empty.

What this means for scheduling: the Nov 15 walking-skeleton gate in `docs/plan.md` is 13 days away and nothing below the contracts layer exists. That gate is only reachable if Phase 0 finishes by Wed Nov 4 and every lane builds against fakes from day one. Section 8 is written around that.

---

## 2. The three lanes

### 2.1 Why three, and how the four collapse

The old Lane 4 (Platform, UI, Integrations) is split along the direction data flows: everything that brings a repo in and stores state joins Discovery; everything that shows or delivers a trial joins the Trial Engine. The Judge lane is not enlarged, because it is the most security-critical and the one the gate rests on.

| Lane | Name | Mission | Suggested owner |
| --- | --- | --- | --- |
| 1 | Intake and Platform | Repo in, case files out, all persistent state, the queue, and the entry points that start a case | Open; a strong backend generalist |
| 2 | Judge and Evidence | Run untrusted code safely, decide every mechanical question, produce replayable signed evidence | Open; the strongest systems engineer |
| 3 | Trial and Courtroom | Run the agents, the jury, and the verdict, and show and deliver them | Adrian (also contracts owner) |

### 2.2 Path ownership

A path belongs to exactly one lane. Anything not listed belongs to the lead and needs Adrian's review.

| Lane | Owns |
| --- | --- |
| 1 | `packages/discovery`, `packages/corpus`, `packages/db`, `apps/api`, `apps/cli`, `apps/github-app`, `apps/worker` (new), `docker/tools/` (new), `fixtures/casefiles/`, `fixtures/corpus/` |
| 2 | `packages/sandbox`, `packages/judge`, `packages/evidence`, `apps/signer` (new), `docker/sandbox/` (new), `fixtures/exhibit-results/`, `fixtures/bundles/` |
| 3 | `packages/trial`, `packages/prompts`, `packages/evals`, `apps/web`, `apps/mcp`, `fixtures/trials/` |
| Lead | `packages/contracts`, `packages/testing` (new), root config, `.claude/`, `.github/`, `docs/`, `CLAUDE.md`, `CODEOWNERS`, `docker/compose.yaml` |

Lanes may add files under `docs/lanes/<their-lane>/` freely.

Cross-lane import rules:

- Every lane may import `@affidavit/contracts` and `@affidavit/testing`.
- Lane 1 may import `@affidavit/evidence` only for `replay` in the CLI.
- `apps/worker` (Lane 1) is the composition root: it is the only place that imports concrete implementations from all three lanes and wires them to the ports. It contains no business logic.
- No other cross-lane imports. If you need something from another lane, you need a port in contracts (section 3.3).

### 2.3 Approved dependencies

Phase 0 installs these in one batch so lanes never fight over `pnpm-lock.yaml`. Adding anything else is a stop-and-ask. Pin exact versions in Phase 0; the names below are the intent.

| Lane | Packages |
| --- | --- |
| Lead | `zod`, a Zod to JSON Schema exporter, `@opentelemetry/api` |
| 1 | `web-tree-sitter` plus JavaScript and TypeScript grammars (or native `tree-sitter`; decide in L1-01), a SARIF types package, `drizzle-orm`, `drizzle-kit`, `pg`, `graphile-worker`, `fastify` and its official cors, helmet, rate-limit, cookie, and csrf plugins, `@octokit/app`, `@octokit/webhooks`, a CLI parser (`commander` or `citty`), `simple-git` or plain `git` via `execFile` |
| 2 | A Docker Engine API client (`dockerode`), an S3 client (`@aws-sdk/client-s3`), in-toto statement types or hand-rolled types, `tar-stream` |
| 3 | `@anthropic-ai/claude-agent-sdk`, `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `@tanstack/react-router`, `@tanstack/react-query`, `@modelcontextprotocol/sdk`, Testing Library for React |

System tools (not npm): Semgrep, CodeQL, OSV-Scanner, gitleaks as pinned images (Lane 1); gVisor `runsc` and cosign on the sandbox host (Lane 2).

---

## 3. Independence model

Lanes stay independent through four mechanisms: frozen contracts, ports with fakes, recorded fixtures, and a single composition root. If you follow these, no lane ever waits on another lane's code to make progress.

### 3.1 Contracts first

`packages/contracts` holds every object that crosses a lane boundary as a Zod schema, exported as a TypeScript type and as JSON Schema. Contracts v1.0 is written in Phase 0 by the lead and frozen for Phase 1. Every schema has a `schemaVersion` literal.

### 3.2 Contracts v1.0 objects

Field lists below are the starting point; Phase 0 turns them into Zod. Types in angle brackets are other contract objects.

```ts
// Identity and targets
TenantId, RepoId, CaseId, ExhibitId, WitnessId: branded strings
TargetRef      { repo: RepoId, commit: string(40 hex), variant: 'vulnerable' | 'safe' | 'patched', imageDigest?: string }
BootHints      { kind: 'dockerfile' | 'compose', path, service?, ports: number[], healthRoute, healthTimeoutMs,
                 seed?: { kind: 'sql' | 'script', path }, stubs: ExternalStub[], env: Record<string, 'synthetic'> }
ExternalStub   { name, kind: 'http' | 'smtp' | 's3', hostAlias }

// Discovery (Lane 1 produces)
Candidate      { id, tool: 'semgrep' | 'codeql' | 'osv' | 'treesitter', ruleId, cls: 'injection' | 'idor',
                 file, range: { startLine, endLine }, reachability: 'reachable' | 'unreachable' | 'unknown',
                 score: number(0..1), scoreInputs: Record<string, number>, toolAgreement: number }
Slice          { file, range, code, strippedComments: boolean, untrusted: true }
RouteInfo      { method, path, handlerFile, middleware: string[], authRequired: boolean | 'unknown' }
CaseFile       { id, tenantId, target: TargetRef, candidate: Candidate, slices: Slice[], route?: RouteInfo,
                 bootHints: BootHints, redactions: Redaction[], escalationFloor: number,
                 safeVariant?: TargetRef }
Dismissal      { candidateId, reason: 'unreachable' | 'negative-control' | 'below-threshold' | 'osv-no-path', detail }

// Evidence (Lane 3 submits, Lane 2 decides)
Witness        { id, caseId, cls, template: string, params: ParamSpace, author: Role }   // a family, not one input
ParamSpace     { name, values: unknown[] }[]                                             // finite, enumerable
Exhibit        { id, caseId, kind: 'witness' | 'counterexample' | 'patch', author: Role, code: string, sha256 }
PatchExhibit   extends Exhibit { kind: 'patch', diff: string, filesTouched: string[], linesChanged: number }
RunRecord      { variant, attempt: 1 | 2 | 3, exitCode, passed: boolean, durationMs, stdoutSha256, stderrSha256 }
ExhibitResult  { exhibitId, admissible: boolean, rejectedBy?: AdmissibilityRule, runs: RunRecord[],
                 vulnPass: boolean, safeVariantFail?: boolean, egressAttempts: number,
                 familyResults?: { paramIndex: number, passed: boolean }[], passed: boolean, durationMs }
AdmissibilityRule = 'schema' | 'completes' | 'stable-3of3' | 'no-egress' | 'time-budget' | 'differential'
                  | 'literal-only-patch' | 'diff-too-large' | 'suite-fails' | 'counterexample-survives'
VerifyResult   { patchExhibitId, familyFlipped: boolean, suitePassed: boolean, rescanClean: boolean,
                 counterexamples: { exhibitId, survived: boolean }[], rejectedBy?: AdmissibilityRule }

// Trial (Lane 3 produces)
Role           = 'defense' | 'prosecution' | 'remedy' | 'juror' | 'judge' | 'stenographer'
CaseStage      = 'intake' | 'map' | 'arraign' | 'defense' | 'prosecution' | 'remedy' | 'verify'
               | 'jury' | 'verdict' | 'dismissed' | 'escalated'
Ballot         { jurorId, model, mandate: 'security' | 'maintainability' | 'blast-radius', inputVariant,
                 question: 'severity' | 'fix-minimality' | 'merge-risk' | 'evidence-sufficiency',
                 vote, confidence: number(0..1), citedExhibits: ExhibitId[] }
Verdict        { caseId, outcome: 'proven-fixed' | 'proven-unfixed' | 'not-proven' | 'dismissed' | 'escalated',
                 severity, exhibits: ExhibitId[], ballots: Ballot[], jurorCorrelation?: number,
                 summary: string, bundleSha256?: string, promptVersions: Record<Role, string>,
                 modelIds: Record<Role, string>, cost: StageCost[] }
StageCost      { stage: CaseStage, inputTokens, outputTokens, usd, wallMs, attempt }
TrialEvent     { caseId, seq: number, stage: CaseStage, at: ISODate, actor: Role, type: TrialEventType, payload }
Escalation     { caseId, reason: 'no-admissible-witness-above-floor' | 'split-jury' | 'budget-exhausted', detail }

// Evidence bundle (Lane 2 produces)
BundleManifest { caseId, createdAt, targetDigests: Record<variant, string>, exhibits: { id, sha256, path }[],
                 results: ExhibitId[], verdictSha256, toolVersions: Record<string, string> }
Attestation    { statement: InTotoStatement, signature: string, keyId: string }

// Platform (Lane 1 owns the API, Lane 3 consumes it)
ApiRoutes: request and response schemas for POST /cases, GET /cases/:id, GET /cases/:id/events (SSE of TrialEvent),
           GET /cases/:id/verdict, GET /bundles/:sha256 (signed URL), POST /webhooks/github
```

Open items the lead resolves while writing v1.0 and records in `packages/contracts/CHANGELOG.md`: the exact stage list against the trial state machine diagram in the source Claude Doc, the severity scale, and the `TrialEventType` list.

### 3.3 Ports

A port is a TypeScript interface in `packages/contracts/src/ports/` with a fake in `packages/testing`. Each lane codes against ports and tests against fakes. The real implementation lives in the providing lane and is wired only in `apps/worker`.

| Port | Provided by | Consumed by | Fake behavior |
| --- | --- | --- | --- |
| `JudgePort.runWitness(caseFile, witness, variants)` returns `ExhibitResult` | Lane 2 | Lane 3 | Scripted by fixture: maps `witness.sha256` to a recorded result |
| `JudgePort.verifyPatch(caseFile, patch, witness, counterexamples)` returns `VerifyResult` | Lane 2 | Lane 3 | Scripted by fixture |
| `JudgePort.runCounterexample(...)` returns `ExhibitResult` | Lane 2 | Lane 3 | Scripted by fixture |
| `ToolRunnerPort.run(image, args, mounts)` returns `{ exitCode, outputPath }` | Lane 2 (hardened) | Lane 1 | Plain local Docker, read-only mounts, no network; good enough for Phase 1 |
| `CaseFileSource.next(tenantId)` and `.get(caseId)` | Lane 1 | Lane 3 | Reads `fixtures/casefiles/*.json` |
| `EventSink.emit(TrialEvent)` | Lane 1 | Lane 3 | In-memory array with assertions |
| `CaseStore` (stage transitions, cost rows, verdict append) | Lane 1 | Lane 3 | In-memory map that enforces legal transitions |
| `EvidenceStore.put(bytes)` returns sha256; `.get(sha256)` | Lane 2 | Lane 2, Lane 1 (read only) | Temp directory |
| `SignerPort.sign(manifest)` returns `Attestation` | Lane 2 | Lane 2 | Signs with a throwaway test key |
| `ModelPort` (agent turn with tool allowlist, budget, schema) | Lane 3 | Lane 3 | Replays recorded agent outputs |

### 3.4 Contract change protocol

1. Open an issue titled `contracts: <change>` with the motivating task id, the diff to the schema, and which fixtures change.
2. Additive changes (new optional field, new enum member at the end) can merge after Adrian's review in the same day; bump the minor version.
3. Breaking changes (rename, removal, required field) wait for the next integration day, bump the major version, and the PR must update every fixture and every fake.
4. Until a change merges, keep working against the current version. Never fork a contract locally.

### 3.5 Fixtures

Fixtures are JSON files validated against contracts in a test in `packages/testing`. CI fails if any fixture does not parse. Minimum fixture set at end of Phase 0:

- `fixtures/casefiles/nodegoat-sqli-001.json`, one hand-written case file for the gate case.
- `fixtures/exhibit-results/`: one admissible result, one rejected for each `AdmissibilityRule`, one passing `VerifyResult`, one failing `VerifyResult`.
- `fixtures/trials/nodegoat-sqli-001.events.json`: a full ordered `TrialEvent` stream ending in a `Verdict`, used by the web UI and the API SSE tests.
- `fixtures/trials/escalated-001.events.json`: a stream ending in `escalated`.

Fixtures describe outcomes, not attacks: witness `code` fields in fixtures are placeholders like `/* witness body recorded from run [id] */` until a real Judge run records them.

### 3.6 Worktrees, branches, and integration

- One git worktree per lane: `git worktree add ../affidavit-lane1 main` and so on. One Claude Code session per worktree.
- Branches `laneN/<task-id>-<slug>`; PRs into `main`; CODEOWNERS enforces lane review; contracts and root config need Adrian.
- Rebase on `main` at least daily. Lockfile conflicts resolve by `pnpm install` on the rebased branch, never by hand edits.
- Integration days (section 8): every lane merges what is green, then the lead runs the end-to-end suite. Whatever breaks is fixed before new tasks start.

---

## 4. Phase 0: lead setup (Mon Nov 2 to Wed Nov 4)

Owner: Adrian, possibly with one Claude Code session in a `lead/` worktree. All three lanes can start L*-01 tasks that need only fakes on Nov 3, but nothing merges to `main` until P0-03 is done.

| ID | Task | Done when |
| --- | --- | --- |
| P0-01 | Update root `CLAUDE.md`, package `CLAUDE.md` files, and `CODEOWNERS` from four lanes to three, using section 2.2; replace placeholder handles with real ones | Every package `CLAUDE.md` names its new lane; no file says "Lane 4"; CODEOWNERS has real handles |
| P0-02 | Install the approved dependency batch from 2.3 with exact versions; add `apps/worker`, `apps/signer`, `packages/testing` stubs in the same shape as existing packages | `pnpm install --frozen-lockfile` succeeds in CI; new packages typecheck, lint, test green |
| P0-03 | Write contracts v1.0 (3.2) and ports (3.3) as Zod plus interfaces; JSON Schema export script; `CHANGELOG.md` | Round-trip tests: every schema parses a valid sample and rejects at least one invalid sample per required field |
| P0-04 | Write fakes in `packages/testing` for every port in 3.3 | Each fake has a test showing it satisfies its port type and behaves as described |
| P0-05 | Write the minimum fixture set (3.5) and a fixture validation test | CI fails when any fixture is invalid |
| P0-06 | Extend `.claude/settings.json` per lane (allow: `docker build`, `docker run` without privileged flags for Lane 2 sandbox tests, `pnpm --filter <own packages>`, `drizzle-kit generate` for Lane 1, `vite` for Lane 3; keep every existing deny) and add a `Stop` hook running typecheck, lint, and the touched package's tests | A session in each worktree can run its lane's commands without prompts; denied commands stay denied |
| P0-07 | CI: add `format:check` and `build`; add a fixtures job; add OSV-Scanner on our own lockfile (dogfooding, from plan.md threat model) | CI shows all four checks on a PR |
| P0-08 | Create `docs/lanes/lane{1,2,3}/PROGRESS.md` from section 9's template, prefilled with each lane's task ids as `todo` | Files exist on `main` |
| P0-09 | Pin the Postgres image by digest in `docker/compose.yaml` | Compose file uses `postgres@sha256:...` |
| P0-10 | Human prerequisites from plan.md that block lanes: Linux sandbox host for Lane 2, Anthropic Console dev key with spend limit for Lane 3, Repro code-reuse confirmation, licensing owner and deadline | Each item is either done or has a named owner and date in `docs/decisions.md` |

---

## 5. Lane 1: Intake and Platform

**Mission:** turn a connected repository into ranked, sanitized case files without any agent inventing a finding, and own all persistent state and every way a case starts.

**Works against fakes for:** `ToolRunnerPort` (local Docker until Lane 2 hardens it), `JudgePort` is never called by this lane, trial events come from `fixtures/trials/`.

**Gate contribution (Nov 15):** the NodeGoat SQL injection case file is produced by real discovery, stored in Postgres, and handed to the worker.

### Phase 1 tasks (Nov 3 to Nov 15)

**L1-01 Ingestion.** Needs: P0-03.
Clone a repo at a pinned commit into a per-case workspace; run gitleaks through `ToolRunnerPort`; build a redaction map; detect language and framework (Express, Koa, Fastify, Next API routes). Real `.env` files are never copied into any workspace that leaves this step.
Done when: a test repo with a planted fake key produces a redaction entry and the key appears in no output; non-Node repos return a typed `unsupported` result; commit pinning is verified by hash.

**L1-02 Tool images.** Needs: none.
Add `docker/tools/` with Dockerfiles or pinned upstream digests for Semgrep, OSV-Scanner, gitleaks, and CodeQL (CodeQL only behind a flag until the licensing decision in P0-10 lands). Record versions so `BundleManifest.toolVersions` can be filled.
Done when: each image runs offline against a fixture repo and emits SARIF or JSON to a mounted output path; all references are digests.

**L1-03 SARIF normalizer.** Needs: L1-02.
Parse SARIF from Semgrep and CodeQL and JSON from OSV-Scanner into `Candidate` objects. Deduplicate overlapping findings by file and range and compute `toolAgreement`.
Done when: golden tests over recorded tool outputs in `fixtures/corpus/` produce stable `Candidate` arrays; malformed SARIF is rejected with a typed error, never a crash.

**L1-04 Our own Semgrep rules.** Needs: L1-02, L1-08 (labels).
Rules for the two MVP classes (SQL and NoSQL injection, IDOR on route params reaching data access without an ownership check). No registry rules, to avoid the rules-license question.
Done when: corpus regression test reports, per rule, which labeled issues it catches and which negative controls it flags; every rule change runs that test; numbers are recorded in `docs/lanes/lane1/rules-report.md` from real runs only.

**L1-05 The map.** Needs: L1-01.
Tree-sitter extraction of routes, handlers, middleware chains, data-access calls, and an approximate call graph from entry points to sinks. Output `RouteInfo` and reachability per candidate.
Done when: on NodeGoat, every route in a hand-written expected list is extracted with its middleware; reachability for each labeled issue matches the label.

**L1-06 Arraignment.** Needs: L1-03, L1-05.
Deterministic score from reachability, sink type, auth middleware on path, and tool agreement. Record `scoreInputs`. Unreachable candidates become `Dismissal` with a reason. Set `escalationFloor` on each case file from config. OSV candidates with no reachable call path are recorded as `osv-no-path` and never sent to trial.
Done when: scoring is a pure function with table tests; the same inputs always give the same score; every filtered candidate has a dismissal reason.

**L1-07 Slice hygiene and case file assembly.** Needs: L1-06.
Build `Slice` objects with comments and free-text prose stripped where a witness does not need them, mark every slice `untrusted: true`, apply redactions, attach `BootHints` and `safeVariant` when the corpus has one. Validate the final `CaseFile` against contracts.
Done when: a test repo with instruction-like text in comments, string literals, and README produces slices where that text is absent or fenced; output validates; `fixtures/casefiles/nodegoat-sqli-001.json` is regenerated from a real run and still passes Lane 3's fake-Judge tests.

**L1-08 Corpus, first pair.** Needs: none.
Add NodeGoat at a pinned commit to `packages/corpus/data/` (as a submodule or fetch script plus checksum, not a vendored copy, after confirming its license). Write ground-truth labels for its injection and IDOR issues. Build the first known-safe variant (the minimal patch for the gate SQL injection) and one negative control (a pattern our rules flag that is not actually exploitable). Write boot hints for each.
Done when: `corpus` exports a typed index of apps, labels, safe variants, and negative controls; each entry has a license note; boot hints validate.

**L1-09 Database and queue.** Needs: P0-03.
Drizzle schema and migrations for tenants, repos, cases, stages, exhibits, ballots, verdicts, cost rows, and escalations. Tenant id on every row with row-level security. Verdicts append-only (no update or delete grant). Graphile Worker setup with one job per case stage, idempotent on `caseId + stage + attempt`. Implement the real `CaseStore` and `EventSink` ports.
Done when: migrations apply to a fresh compose Postgres; a test using two tenants proves tenant A cannot read tenant B's case through any query path; an attempt to update a verdict row fails; illegal stage transitions are rejected by the store.

**L1-10 Worker composition root.** Needs: L1-09, P0-04.
`apps/worker` registers stage handlers: Lane 1's intake, map, and arraign handlers; Lane 3's trial handlers; Lane 2's Judge as the `JudgePort` implementation. Start with fakes for Lane 2 and Lane 3 and swap by config.
Done when: with all fakes, a case moves from `intake` to `verdict` through real Postgres and Graphile Worker; killing the worker mid-stage and restarting resumes without duplicating a stage.

**L1-11 CLI v0.** Needs: L1-10.
`affidavit scan <path|repo>` enqueues a case and streams events to the terminal; `affidavit status <caseId>`; `affidavit replay <bundle>` calls Lane 2's replay.
Done when: `scan` against the NodeGoat fixture prints the fixture event stream end to end with fakes; `replay` is wired but may return "not implemented" until L2-08.

### Phase 2 tasks (Nov 16 to Nov 25)

**L1-12 API.** Fastify with GitHub OAuth, CSRF protection, strict CSP, rate limits, routes from `ApiRoutes`, SSE endpoint for `TrialEvent` with resume by `seq`.
Done when: contract tests validate every response against `ApiRoutes`; SSE test replays the fixture stream and resumes correctly after disconnect; cross-tenant access test passes at the HTTP layer.

**L1-13 Second vulnerability class in discovery.** IDOR rules, map support for ownership checks, second safe variant and negative control in the corpus.
Done when: NodeGoat IDOR labels are covered by case files and negative controls produce no case file that survives arraignment.

**L1-14 Corpus expansion.** Add Juice Shop and DVNA with labels, boot hints, and at least one safe variant per class across the corpus.
Done when: corpus index lists all three apps with license notes; boot hints validated by Lane 2's boot recipes on integration day.

### Phase 3 tasks (Nov 30 to Dec 11)

**L1-15 GitHub App.** Least-privilege permissions (contents read, pull requests write, checks write), short-lived installation tokens, HMAC-verified webhooks, check runs with the verdict summary and bundle link, fix PRs opened from the Remedy diff, never direct pushes.
Done when: a webhook with a bad signature is rejected; an end-to-end test against a dev App installation opens a check run and a PR on a test repo.

**L1-16 Pilot packaging.** One-command self-hosted run (`docker compose` profile) and a written data-handling page in `docs/`.
Done when: a fresh machine with Docker and the documented env values runs a corpus case end to end.

---

## 6. Lane 2: Judge and Evidence

**Mission:** run untrusted code safely, decide every mechanical question, and produce evidence anyone can replay and verify. Nothing in this lane may be relaxed to hit a date; cut scope elsewhere.

**Works against fakes for:** case files come from `fixtures/casefiles/` and the corpus index; witnesses for Phase 1 are hand-written by the lane owner, not agent-written.

**Gate contribution (Nov 15):** the hand-written gate witness family is admitted on the differential rule, a patch flips the whole family, and the bundle replays on a second machine.

**Before any implementation task:** write the containment test suite first (L2-01). Every later task in this lane runs it.

### Phase 1 tasks (Nov 3 to Nov 15)

**L2-01 Containment test suite.** Needs: none.
A suite of deliberately misbehaving witness programs, each asserting one invariant from the plan.md threat model: no network egress, no access to any credential or evidence-store path, bounded processes, bounded memory, bounded wall clock, no writes outside the witness's own scratch directory, no reach to the orchestrator. Each test asserts both that the behavior is contained and that the attempt is recorded (for example as `egressAttempts`). Keep these tests behavioral and minimal: they check that a boundary holds, not how to break one.
Done when: the suite runs against a plain-Docker runner and reports which invariants fail (they are expected to fail at this point); results are recorded in `docs/lanes/lane2/containment.md`.

**L2-02 Sandbox runner.** Needs: L2-01, P0-10 (Linux host).
gVisor (`runsc`) runtime, rootless, never privileged, never mounting the Docker socket, read-only root filesystem, cgroup limits on CPU, memory, and process count, hard wall-clock timeout, internal-only network per case, fresh environment per case, teardown that verifies nothing persists. If starting from Repro's sandbox code, record which files were copied and under what agreement, then harden to this lane's threat model.
Done when: every L2-01 test passes on the sandbox host; teardown test shows no leftover containers, networks, or volumes; implements `ToolRunnerPort` for Lane 1.

**L2-03 Witness-runner jail.** Needs: L2-02.
The fixed runner image executes a witness inside the same jail as the target. It holds no credential, has no handle to the evidence store, and has no route to the orchestrator. The Judge, outside the jail, starts it and reads results only from a serialized artifact on a mount the runner cannot write back through after completion. The Judge parses that artifact defensively (size limits, schema validation, no evaluation).
Done when: L2-01 tests pass when the misbehaving code is run as a witness; a malformed or oversized result artifact is rejected as inadmissible, never crashes the Judge.

**L2-04 Boot recipes.** Needs: L2-02, L1-08 boot hints (fixture until then).
Build from Dockerfile or compose, wait on health route, seed from fixtures, start local stubs for `ExternalStub` entries inside the sandbox network, record the image digest. A target that cannot boot without real egress is returned as `unsupported`, not given an exception.
Done when: NodeGoat vulnerable and safe variants boot, report healthy, and return their digests; a target that needs real egress is marked unsupported.

**L2-05 Witness protocol.** Needs: L2-03.
A witness is a small parameterized TypeScript test over a finite `ParamSpace`, executed by Vitest inside the runner image against the target's internal hostname. Define the runner's input format and result artifact format in `packages/judge` and keep them in sync with `ExhibitResult`.
Done when: a hand-written witness family runs every parameter and reports per-parameter results in `familyResults`.

**L2-06 Rules of evidence.** Needs: L2-05.
Implement admissibility in order: schema valid, completes, stable 3 of 3, no egress, within time budget, differential (passes on vulnerable, fails on safe variant when one exists). Record the first rule that rejects. Implement `JudgePort.runWitness` and `runCounterexample`.
Done when: one table test per `AdmissibilityRule` using fixtures; the gate witness is admitted with `vulnPass: true` and `safeVariantFail: true`; a witness that passes on both variants is rejected by `differential`.

**L2-07 Patch verification.** Needs: L2-06.
`JudgePort.verifyPatch`: apply the patch to the vulnerable commit, rebuild, rerun the whole witness family (must fail on every parameter), run the target's test suite, rerun every prosecution counterexample, request a discovery re-scan through the port Lane 1 exposes (fake until integrated). Reject patches over the diff size cap and patches whose only change is special-casing a literal value from the witness's parameters.
Done when: the gate patch flips the whole family; a patch that only special-cases one parameter value is rejected by `literal-only-patch`; an oversized patch is rejected by `diff-too-large`.

**L2-08 Evidence bundles and replay.** Needs: L2-06.
Content-addressed exhibits in an S3-compatible store (MinIO locally), a `BundleManifest`, and `replay(bundle)` which rebuilds from pinned digests and reruns everything, then compares results.
Done when: the gate bundle replays on a second machine with identical admissibility outcomes; tampering with any exhibit byte fails replay with the exhibit id named.

**L2-09 Signer.** Needs: L2-08, P0-10 (key decision).
`apps/signer` holds the cosign key; the API and worker can request a signature over a manifest digest but cannot read the key. Use a team-managed key, not the public keyless flow. Implement `SignerPort`.
Done when: the gate verdict manifest is signed as an in-toto statement and verifies with cosign; a test running as the API's identity cannot read the key material.

### Phase 2 and 3 tasks (Nov 16 to Dec 11)

**L2-10 Second class and corpus coverage.** Boot recipes and differential runs for IDOR witnesses and for Juice Shop and DVNA.
Done when: each corpus app with a safe variant has an admitted hand-written witness for at least one labeled issue.

**L2-11 Hardening pass.** Re-run the containment suite on every change; add egress logging as an exhibit; per-case resource and time reporting into `StageCost`.
Done when: containment suite is a required CI job on the sandbox host runner.

**L2-12 Public verification helper (stretch).** A small command that verifies an attestation against a bundle without access to our systems.

---

## 7. Lane 3: Trial and Courtroom

**Mission:** run the courtroom (Defense, Prosecution, Remedy, Jury, verdict) on top of the Judge, and make it visible and deliverable through the web UI and MCP server.

**Works against fakes for:** `JudgePort` (scripted by fixtures), `CaseFileSource`, `CaseStore`, `EventSink`. This lane must never wait on the sandbox.

**Gate contribution (Nov 15):** the orchestrator drives the gate case through Defense and Remedy against the real Judge on integration day, and writes a `Verdict` that cites its exhibits. Jury is not required for the gate.

### Phase 1 tasks (Nov 3 to Nov 15)

**L3-01 Orchestrator skeleton.** Needs: P0-03, P0-04.
A stage loop driven by Graphile Worker jobs (through the `CaseStore` port), with per-role tool allowlists, turn caps, and token and dollar budgets. A retried stage charges its budget before re-invoking any agent. Global kill switch read from config. Every model call goes through `ModelPort` so tests replay recorded outputs.
Done when: with all fakes, a case moves through every stage; a test proves a retry is charged before the agent is called; exceeding a budget ends the stage with `budget-exhausted` and an `Escalation`.

**L3-02 Agent safety envelope.** Needs: L3-01.
Agents have no shell and no network. Their only tools are role-specific submit tools (submit witness, submit counterexample, submit patch, submit ballot) that validate against contracts. Case-file content is wrapped and labeled as untrusted in every prompt. Output that fails schema validation is inadmissible and recorded, not silently retried.
Done when: a test enumerates each role's tool list and fails if any tool can execute code or reach the network; a replayed agent output that fails schema produces an inadmissible record.

**L3-03 Prompts package.** Needs: none.
Versioned prompt files per role in `packages/prompts`, each with a version id, the untrusted-content wrapper, and the output schema reference. Snapshot tests on structure. Every `Verdict` records prompt versions and model ids.
Done when: changing a prompt without bumping its version fails a test.

**L3-04 Defense.** Needs: L3-02, L3-03.
Reads the `CaseFile`, fills a per-class witness template (the fallback from plan.md risks: the agent fills parameters rather than writing from scratch), submits to the Judge, iterates on rejection reasons up to a cap. Below the escalation floor, no admissible witness is a recorded dismissal. Above the floor, no admissible witness triggers a second attempt with a different model and prompt, and if that fails the case is escalated to human review.
Done when: fake-Judge tests cover admitted on first try, admitted after feedback, dismissed below floor, second attempt above floor, escalated above floor; the planted-instruction case file from L1-07 does not end in a clean dismissal.

**L3-05 Remedy.** Needs: L3-04.
Writes the smallest patch that flips the whole family, within the diff cap, and submits it through `verifyPatch`.
Done when: fake-Judge tests cover accepted, rejected for literal-only, rejected for size, and rejected for suite failure, each producing the right event and stage.

**L3-06 Verdict writer.** Needs: L3-05.
Build the structured `Verdict` first, then generate the plain-language summary from it (never the reverse). No em dashes; no numbers that are not in the structured verdict.
Done when: a test checks every number and exhibit id in the summary appears in the structured verdict; a lint rule on generated text rejects em dashes.

**L3-07 Web UI shell on fixtures.** Needs: P0-05.
React, Vite, TanStack Router and Query. Case file view (docket, exhibits with run logs, verdict stamp) driven by `fixtures/trials/*.events.json` through a fake SSE source. Case-file aesthetic: near-black background, off-white type, one green accent, monospace labels, thin outlined VERIFIED stamp. Keyboard navigable, WCAG AA contrast (check the green against the background), reduced-motion support. Plain-language summary first, technical exhibits one click deeper.
Done when: the gate fixture renders end to end; an automated accessibility check passes on the case view; the escalated fixture renders a clear human-review state.

### Phase 2 tasks (Nov 16 to Nov 25)

**L3-08 Prosecution.** Attacks the claim with its own exhibit: the witness tests the wrong thing, or the path is unreachable under realistic config. On a fix, writes counterexamples drawn from the family's parameter space. Rhetoric without an exhibit is inadmissible.
Done when: fake-Judge tests cover a counterexample that defeats a weak fix and one that fails; on integration day, a deliberately weak fix on the corpus is caught by the real Judge.

**L3-09 Appeals.** Rejected fixes return to Remedy with the Prosecution's counterexample, max 2 rounds, budget charged per round.
Done when: a third appeal is impossible by construction (test), and exhausting appeals produces `not-proven` with exhibits cited.

**L3-10 Live UI on the real API.** Swap the fake SSE source for Lane 1's endpoint; add objections and appeals to the docket.
Done when: the UI shows a live corpus case from the dev stack; disconnect and reconnect resumes from the last `seq`.

### Phase 3 tasks (Nov 30 to Dec 11)

**L3-11 Jury.** Three jurors (security, maintainability, blast radius) on different Claude models with different prompts, parallel and blind, schema-bound ballots citing exhibit ids. Differentiated inputs: different exhibit orderings, and at least one juror sees only the raw Judge results. Jurors decide only non-mechanical questions. Unanimity for critical severity; any split escalates to a human.
Done when: a test proves no ballot question can be "did the test pass" or "did the exploit land"; split ballots produce an `Escalation`; ballots record `inputVariant`.

**L3-12 Calibration evals.** Run full trials on the corpus; compare jury outcomes against labels and against a single-reviewer baseline; measure inter-juror vote correlation, especially on wrong cases; record cost per verdict. Report only measured numbers, with run ids; until then `[metric]`. Do not claim the jury beats a single reviewer unless correlation as well as accuracy supports it, and if it does not, say so and recommend the simpler design.
Done when: `docs/lanes/lane3/calibration.md` is generated from a real run with its run id.

**L3-13 Courtroom visual.** The illustrated courtroom of original characters as the live status visual (Judge as clockwork harness, Defense, Prosecution, five-seat jury box with distinct silhouettes, stenographer for deterministic tools). Jurors carry plain-text nameplates only. No real logos, mascots, or brand characters.
Done when: each `CaseStage` maps to a courtroom state; reduced-motion users get a static version.

**L3-14 MCP server.** One tool that requests a verdict on a change and returns the verdict summary and bundle link, by calling the API.
Done when: an MCP client test requests a verdict on the corpus fixture and gets a schema-valid response.

---

## 8. Schedule, integration days, and gates

Weeks count from Mon Oct 26 (plan.md). Thanksgiving is Thu Nov 26, so week 5 is light.

| Date | Event | Exit criteria |
| --- | --- | --- |
| Wed Nov 4 | Phase 0 done | P0-01 to P0-09 merged; P0-10 owners named |
| Fri Nov 6 | Integration day 1 | All three lanes green on `main` against fakes; worker moves the fixture case through every stage (L1-10 partial) |
| Fri Nov 13 | Integration day 2 | Real discovery produces the gate case file; real Judge admits the hand-written gate witness; orchestrator runs Defense against the real Judge |
| **Sun Nov 15** | **Walking-skeleton gate** | One SQL injection from Semgrep candidate to signed verdict: witness admitted on the differential rule, a patch flips the whole family, bundle replays on a second machine, containment suite green |
| Fri Nov 20 | Integration day 3 | IDOR case files and witnesses; Prosecution and appeals against the real Judge; API and SSE live |
| Wed Nov 25 | Integration day 4 (light) | Second class end to end; a weak fix caught by a counterexample on the corpus |
| Fri Dec 4 | Integration day 5 | Jury, live UI on real cases, GitHub App check run and PR on a test repo |
| Fri Dec 11 | Integration day 6 | Calibration report from real runs, MCP server, pilot packaging; demo rehearsal |
| TBD | Demo | Lock the date; if before Dec 14, GitHub App moves to stretch and evals and attestation move earlier (plan.md) |

If the Nov 15 gate slips: cut from Lane 3's UI and jury work and Lane 1's GitHub App, never from Lane 2's containment or admissibility rules. Move Lane 3 effort onto helping Lane 2 with tests and fixtures, within Lane 2's review.

### End-to-end test owned by the lead

`pnpm e2e` (added in Phase 0 as a placeholder, filled by integration day 2) runs the gate case on the dev stack with real implementations of every port and asserts the gate criteria. It runs on every integration day and nightly once the sandbox host has a CI runner.

---

## 9. PROGRESS.md template

```md
# Lane N progress

Owner: @handle
Contracts version in use: v1.0

## Tasks
| ID | Status (todo, doing, done, blocked) | Branch or PR | Notes |
| --- | --- | --- | --- |
| LN-01 | todo | | |

## Blocked
- LN-xx: what is blocked, what was tried, who can unblock

## Decisions made in this lane
- date: decision, reason

## Metrics from real runs
- metric name: value (run id, date)
```

---

## 10. Risks specific to the three-lane split

| Risk | Mitigation |
| --- | --- |
| Lane 1 is the widest lane (discovery plus platform) | Its Phase 1 platform work is limited to the DB, queue, and worker; API and GitHub App are Phase 2 and 3. If it falls behind, the CLI is the only required entry point for the gate |
| Lane 3 owner is also contracts owner and lead | Contract reviews are batched once per day; Phase 0 is done before Lane 3 starts in earnest; another member is named backup reviewer for additive contract changes |
| Fakes drift from real behavior | Every fake is driven by fixtures; on each integration day, real Judge runs re-record the exhibit-result fixtures, and Lane 3 tests must still pass on the re-recorded set |
| The composition root becomes a dumping ground | `apps/worker` has a lint rule or review check: no logic beyond wiring and config |
| Lockfile conflicts from late dependency adds | Dependencies are pre-approved and installed in Phase 0; new ones go through the lead in a single batched PR per integration day |
| Lane 2 blocks on the Linux host | Lane 2 builds L2-01, L2-05, L2-06 logic, and L2-08 against plain Docker locally while the host is set up; nothing is called hardened until it passes on gVisor |

---

## 11. Open decisions for Adrian

1. Lane owners for Lanes 1 and 2, and a backup contracts reviewer.
2. CodeQL licensing outcome and owner (blocks enabling CodeQL in L1-02; Semgrep plus tree-sitter carries discovery without it).
3. Signing key custody and rotation plan (blocks L2-09).
4. Whether Repro sandbox code is copied in, and the agreement covering it (affects L2-02 starting point).
5. Demo date (decides whether Phase 3 compresses).
6. Whether `docs/plan.md` should be re-synced from the Claude Doc to reflect three lanes, or keep four lanes there with this file as the override.
