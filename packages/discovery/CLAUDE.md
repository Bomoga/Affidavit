Read docs/plan.md, then docs/implementation-plan.md section 5 (Lane 1) before working in this package.

# @affidavit/discovery

**Owner:** Lane 1 (Intake and Platform)

**Mission:** Repo ingestion, the map, tool runners, and arraignment scoring.

## Commands

Run from this directory, or add `--filter @affidavit/discovery` from the repo root.

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm test:docker`: the tests that run the real pinned scanner images (`src/tools/tools.docker.test.ts`). They are skipped unless `AFFIDAVIT_DOCKER_TESTS=1`. Bash: `AFFIDAVIT_DOCKER_TESTS=1 pnpm --filter @affidavit/discovery test:docker`. PowerShell: `$env:AFFIDAVIT_DOCKER_TESTS = '1'`, then the same command. Needs Docker; the first run pulls the three pinned images. Containers run with `--network none`.
- `node ../../docker/tools/probe/archive-names.mjs` (from the repo root: `node docker/tools/probe/archive-names.mjs`): rederives which file names the pinned gitleaks drops as archives and compares them with `ARCHIVE_NAME`. Needs Docker, takes about five minutes, exits 0 only when the rule matches gitleaks in both directions (a miss or an over-match exits 1). Rerun it whenever the gitleaks pin in `docker/tools/tools.json` changes. Its two pure helpers are unit tested in `src/tools/probe.test.ts`.

## Scanner wrappers (`src/tools/`)

Semgrep, OSV-Scanner and gitleaks run as pinned Docker images (`docker/tools/tools.json`, always `image@sha256:...`) through `ToolRunnerPort`. CodeQL is disabled and has no image. `docker/tools/README.md` has the full explanation; the pieces are:

- `manifest.ts`, `invocations.ts`: load the manifest and build the argv and mounts for each tool.
- `quarantine.ts`: copies the repo to a scan snapshot, moves tool-control paths (`.git`, ignore files, config) into a sidecar and keeps a neutral-name mapping back to the original paths.
- `run.ts`: `runTool` runs a tool and fails closed (typed `ToolFailedError`, `ToolOutputMissingError`). For gitleaks it adds a sidecar pass and a windows pass, then maps every report path back to `/src/<original path>`. Report text (`message.text`) is rewritten too, so no internal `qNNNN` or `wNNNN/pNNNN` name reaches a report.
- `unscannable.ts`: decides on the host what gitleaks will skip or cut through (it exits 0 either way).
- `windows.ts`: overlapping windows under 100,000 bytes for large text files and archive-named files. `maxWindowBytes` must be a finite number of at least 0; anything else throws `RangeError` before a tool runs.

## Coverage notifications

`ToolRunResult.notifications` holds coverage losses; any notification makes the result `partial`. A partial result means "incomplete", never "clean". Kinds (`id`):

- Semgrep: the tool's own notification ids, and `git-dir-extra-content` (content inside a quarantined `.git`).
- OSV-Scanner: `lockfile-not-in-report`, `git-dir-extra-content`.
- gitleaks: `binary-header-mismatch`, `non-text-content`, `unreadable`, `skipped-file-type`, `archive-name-mismatch`, `chunk-split-risk`, `multiline-split-risk`, and from the windows pass `window-skipped` (a file or window could not be written or may still be skipped) and `windows-budget-exceeded` (the byte budget ran out).

An `archive-name-mismatch` message says the file is scanned in a window only when it really was windowed. Otherwise (a PDF, executable or other skipped signature, a window write failure, a quarantined sidecar file) it says the content is NOT scanned. Image, audio and video files are not coverage losses and are listed in `binaryMediaFiles` only. The tools layer does not scan inside them for UTF-16 text or text past a chunk cut, so ingestion fails closed on them: every media file (judged by its leading bytes with `signatureClass`, whatever its name) is left out of the workspace with exclusion reason `media-file`, and a normal repo keeps `status: 'ok'`.

## The map (`src/map/`, L1-05)

`buildMap({ root })` reads the redacted workspace with `web-tree-sitter` (grammars load from the installed `tree-sitter-javascript` and `tree-sitter-typescript` wasm files; no network) and returns `{ routes, dataAccess, coverage }`. `reachabilityFor(map, candidates)` then answers per candidate. `routeInfoOf(path)` makes the contract `RouteInfo` for a reaching path. Entry points are exported from the package index.

Files: `parse.ts` (tree-sitter to plain objects; comments dropped; depth and node caps), `prepass.ts` (functions, name uses, module specifiers), `values.ts` and `engine.ts` (the abstract interpreter), `routes.ts` (router events to a route table; auth guards), `reach.ts` (reachability), `index.ts` (file walk, limits, public API).

What it does: runs the repo's modules in an abstract interpreter (never real code: `require` resolves only to files already in the analysis set, and nothing is evaluated). Values are sets of strings, objects, closures, Express routers and package members. It follows `require` and `import` between files, `module.exports`, `exports.x`, destructuring, classes and `extends`, `this.x = ...` constructors, `new`, and `.call/.apply/.bind`. Express: `app.get/post/put/delete/patch/options/head/all`, `router.*`, `app.route(p).get(...)`, `app.use` (with or without a path), mounted routers with prefixes, middleware in registration order. `RouteInfo.middleware` is the chain in front of the handler without application-wide `app.use(fn)` middleware (that is `MapRoute.appMiddleware`); labels are identifier characters only (`isLoggedIn`, `bodyParser.json()`), never free text.

What it approximates (all documented here on purpose):

- Branches: both are taken. Loops run once, except `for...of` over an array literal of strings (up to 64 elements), which runs once per element so a route in the loop gets its real path. A path part it cannot reduce to a string is rendered as `${name}` and `pathDynamic` is true; `x || 'a'` with an untracked `x` also counts as dynamic.
- Calls: repo functions are inlined with the argument values (memoized by argument shape and a mutation counter: any write to an object, array or function property, to an existing variable or to a module-level declaration makes earlier results unusable, so a mutation between two identical-looking calls is never missed; bounded depth; at most 256 runs per function; a function already running twice up the stack is not run a third time, and when that cut has arguments the running ones do not, the `recursion-cutoff` limit is reported. Writes through functions the map cannot see, such as `Object.assign` on a repo object, are not tracked). A function value passed to any call gets a call edge from the caller and is analyzed later with untracked parameters. Functions never entered are run once at the end with untracked parameters (a "sweep"), so their calls and data access are seen. Callbacks run after the code that created them, not at the call.
- Property access on unknown values gives nothing; there is no flow through object spreads of unknown values, getters, `Proxy`, prototype chains other than `F.prototype.x = ...` and classes, or computed keys that are not literal strings.
- A route registration on a receiver it cannot tie to `express()` or `Router()` is kept only when the receiver is named like a router (`app`, `router`, `routes`, `api`, `server`, ...) and the call shape matches; it is listed with `mounted: 'orphan'` and recorded as a `unresolved-router` leak.
- Auth: repo middleware counts as a guard only by a strict body shape and never by name: `next` is its third parameter, called once, never aliased or passed on; no try/catch; the test is one identity read (`req.user`, `req.session.userId`, `req.session.passport.user`, a zero-argument `req.isAuthenticated()`, `ctx.state.user`, optionally negated, nothing else in the condition; a bare `req.isAuthenticated` is a function and `req.session.id` exists for every session, so neither counts; a write to the chain the test reads, such as `req.user = req.user || guest`, makes the guard uncertain); and the other branch returns or throws a redirect, 401 or 403 (`if (id) return next(); deny`, `if (!id) deny; return next()`, the `else` forms, `id ? next() : deny`). Anything else that reads an identity, can deny and can call `next` is uncertain (`'unknown'`). A presence-only Authorization header check is never enough. A package's middleware counts only for an allowlist of known guard packages and members (`express-jwt`, `passport.authenticate`, `connect-ensure-login`, `express-openid-connect` `auth`/`requiresAuth`, `express-oauth2-jwt-bearer`, `express-basic-auth`); any other package whose name looks like auth (`jwt.decode`) is uncertain. Even then every argument must be a literal and no object may have a spread, a computed key, a disabling key (`credentialsRequired`, `optional`, `.unless`, ...) or any literal `false` value other than passport's `session`; options in a variable or a call give uncertain. `passport.authenticate('anonymous')` alone authenticates nobody (no guard, not uncertain); a strategy list containing `anonymous`, or one that is not a literal, is uncertain. The final handler is never judged. `authRequired` is `true` only when a proven guard is on the chain, `false` when every middleware is resolved or a known benign package and none is a guard, `'unknown'` otherwise (a guard on a path it cannot pin down, a guard that may pass first, a name that looks like auth on code that is not, an unresolved item, or a cut path or scope list). It is a heuristic: a check inside the handler is not seen (CR-10).
- Data access: Mongo collection methods on `db.collection('x')` values and Mongoose models, SQL `query/execute/raw/exec/run/all/get/prepare` on known SQL packages or receivers named like a database handle, `eval` and `new Function`, and `child_process` calls with a non-literal command. Only code the interpreter entered is listed.

Reachability answers (three-valued, matching `Candidate.reachability`):

- `reachable`: a route mounted under an `express()` application reaches the innermost function that holds the candidate's lines. The result carries the route, the middleware and the function path (shortest first, up to 5).
- `unreachable`: only when the whole analysis is complete (no skipped or partly parsed file, no limit hit, no `dynamic-dispatch`, `unresolved-handler`, `unresolved-router` or `code-eval` leak), no dynamic require could have loaded the file, no code handed to a package (from any function that is not provably dead: objects and arrays included, decorated classes, `.call`/`.apply` registrations) reaches it, and neither the function nor any named function around it is referenced by name anywhere (an assigned property `o.v = x` counts as a reference to `v`, since it may run a setter; a function with no name anywhere around it never qualifies; getters, setters and the names the language or libraries call for you, `toString`, `valueOf`, `toJSON`, `then`, `catch`, `finally`, `inspect`, `handleEvent`, `constructor` and `Symbol.*`, are always treated as referenced). Code run by start-up code (an IIFE, a function called at module level) and not reached from a route is `unknown` (`startup-code`). In practice `unreachable` means dead code.
- `unknown` for everything else, always with a `reason` (`route-not-mounted`, `external-entry`, `referenced-unresolved`, `repo-incomplete`, `file-incomplete`, `startup-code`, `file-not-analyzed`, `no-enclosing-function`, `dynamic-require`, `invalid-location`). `unknown` is not `unreachable`: L1-06 must route a high-score `unknown` candidate to trial or review, never to a dismissal. Module-level lines are `unknown` (they run at load, not per request).
- A `use` registration (an error handler, a catch-all middleware) is a reachability entry with method `USE`; it is not listed in `routes`.

Untrusted input: comments never leave the parser; string contents appear only as route paths (capped at 200 characters after mounts too, and reduced to URL path characters; a cut path is marked dynamic) and the dynamic-path marker; every label and name is restricted to identifier characters; `f` maps are prototype-free and user-controlled names only key `Map`s. Bounds (all in `MapLimits`, reported in `coverage` when hit): files, bytes, syntax nodes, tree depth, directory depth, call depth, interpreter steps, runs per function, wall-clock time, parse time. Memo keys for calls are lossless (long strings by length and hash, arrays and objects by identity). Files and directories whose names contain control or bidirectional characters are not read and are reported under a reduced name (`unsafe-name`). Text cut at a leaf cap makes the file incomplete (`text-limit`); a string cut at 512 characters is marked dynamic. Files are opened with `O_NOFOLLOW` where the platform has it and sized on the opened handle; on Windows `O_NOFOLLOW` does not exist, and a directory swapped for a link between the walk and the read is not detected, so the workspace must not be writable by anything untrusted while the map runs (ingestion's private workspace is). Skipped names are always reported reduced. Symbolic links, `node_modules`, `.git`, `vendor`, `dist` and similar directories are not read and are listed in `coverage.skipped`.

Tests: `src/map/map.test.ts` (patterns and hostile inputs, offline). `src/map/map.nodegoat.test.ts` runs the map on the pinned NodeGoat checkout and compares it with `fixtures/corpus/map/nodegoat-routes.json.fixture` and the corpus labels. It is skipped unless `AFFIDAVIT_CORPUS_NETWORK=1` (fetches and verifies the pinned commit with git, like the corpus network tests and the L1-04 regression) or `AFFIDAVIT_MAP_NODEGOAT_DIR=<checkout>`. Bash: `AFFIDAVIT_CORPUS_NETWORK=1 pnpm --filter @affidavit/discovery exec vitest run map.nodegoat`. PowerShell: `$env:AFFIDAVIT_CORPUS_NETWORK = '1'`, then the same command.

A string or template key (`o['go']()`, `{ 'go': f }`) counts as a reference to the name. A computed call it cannot resolve is a `dynamic-dispatch` leak. A router passed to a package other than `http`/`https`/`supertest` is an `unresolved-router` leak. Nothing is skipped without a reported limit: arguments and array elements are always all evaluated; what is kept is capped (`value-set-cap`), as are the route walk (`routes`, `time`), the sweep (`sweep`) and the directory listing (`entries`).

Not covered yet: Koa, Fastify, Hapi, Apollo, NestJS and Next route registration as routes (code handed to those packages is `external-entry`, so it is `unknown`, never `unreachable`; a decorated class's methods are entries), dead code that only other dead code refers to, request-time reachability of module-level code, and IDOR-specific path facts beyond the auth flag.

## Arraignment (`src/arraign/`, L1-06)

`arraign({ candidates, reachability, dataAccess, negativeControls, config })` is a pure function (no clock, no I/O, input order does not matter). It fills `reachability`, `score` and `scoreInputs` on each candidate and splits them into `toTrial` (highest score first), `dismissed` (contract `Dismissal`, each with a reason and a detail) and `review`.

- `scoreFacts` is the scoring function. Recorded inputs, each in 0..1: `reachability` (reachable 1, unknown 0.5, unreachable 0), `sinkType` (`SINK_WEIGHTS`: code execution 1, SQL and `$where` 0.9, Mongo operator and IDOR data access 0.7, unclassified 0.5, dependency 0.4), `noAuthOnPath` (no guard 1, unknown 0.5, proven guard 0; always 0.5 for `idor`, which needs a signed-in attacker anyway), `toolAgreement` (`1 - 0.5^tools`). Score is the weighted sum with `SCORE_WEIGHTS` (0.4, 0.3, 0.1, 0.2), rounded to four decimals. The weights are design constants, not measurements.
- `sinkClassOf`: from our own rule id, raised (never lowered) by a map data-access call inside the candidate's lines; OSV is `dependency`.
- Dismissal precedence: corpus negative control, then `osv-no-path` (an OSV candidate the map does not show `reachable`; it never goes to trial), then `unreachable`, then `below-threshold` (only when reachability is known and `dismissBelow` is above 0). `unknown` is never dismissed. A candidate with no map answer is `unknown`.
- F3: a candidate whose score is at or above `escalationFloor` is never dismissed. If a dismissal rule matches it, it goes to `review` with the reason it would have had (`wouldDismiss`). The worker must hand `review` to a person or to trial, never drop it.
- Config: `arraignConfigFrom(process.env)` reads `AFFIDAVIT_ESCALATION_FLOOR` (default 0.7) and `AFFIDAVIT_DISMISS_BELOW` (default 0, off). Both must be in 0..1 and the threshold may not be above the floor. The floor goes into every `CaseFile.escalationFloor`.

Root CLAUDE.md rules apply here. Do not add dependencies without asking.

## Libraries still to come (notes, not installed)

- A SARIF parser (TBD)
