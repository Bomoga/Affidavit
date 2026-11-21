# Lane 3 contract requests

Requests for changes to `packages/contracts`. Lane 3 does not edit contracts; each request goes to the lead through the protocol in `docs/implementation-plan.md` section 3.4. Until a request merges, Lane 3 code works against the current version and degrades honestly.

## CR-1: a trial event that carries the Judge's patch verification

- Raised by: L3-07 (web case view, PR 10). Affects L3-05, L3-06, L3-10, L1-12 (SSE).
- Contracts version: v1.0.
- Status: landed in contracts v1.1 (see `packages/contracts/CHANGELOG.md`).
- Kind: additive (new enum member at the end of `TrialEventType`, new union member in `TrialEvent`). Minor bump.

### Problem

`TrialEventType` in v1.0 has no event for the outcome of `JudgePort.verifyPatch`. A `VerifyResult` exists as a schema, but nothing in the event stream carries one. So a client that reads only the stream (the web UI over SSE, the CLI) can never learn that the Judge accepted a patch. It only sees the patch `exhibit-submitted`, the `verify` stage entered and exited, and then a `verdict-written` that claims `proven-fixed`.

The case view's VERIFIED stamp must rest on Judge evidence, not on the verdict's own claim. The rule is: every cited witness was admitted by the Judge, and the patch the Judge accepted is cited. Without a verification event, the stamp cannot show on `fixtures/trials/nodegoat-sqli-001.events.json`, even though that fixture describes a fixed case.

### Proposed change

```ts
// TrialEventType: append
'verify-result',

// TrialEvent: add
event('verify-result', z.object({ result: VerifyResult })),
```

Emitted by actor `judge` in stage `verify`, once per `verifyPatch` call (so appeals produce one per round).

Fixtures to update in the same PR: `fixtures/trials/nodegoat-sqli-001.events.json` gains a `verify-result` event between the `verify` stage-entered and stage-exited events, with a passing `VerifyResult` for `exhibit-patch-001`. The SSE fixture tests in Lane 1 pick it up automatically.

### Resolution (v1.1)

`packages/trial` records one `verify-result` (actor `judge`, stage `verify`) per `verifyPatch` call Remedy made, before the verdict. `buildCaseView(events)` in `apps/web` reads those events, counts only ones recorded by the Judge in `verify`, and the `verifyResults` input below is removed. A missing or failing check still renders `unverified`. The CLI renders the new event on one sanitized line.

### What Lane 3 did before v1.1

`buildCaseView(events, { verifyResults })` in `apps/web` accepts `VerifyResult` values from outside the stream. With none supplied, a `proven-fixed` verdict renders as `unverified` with the reason "The record has no Judge result accepting a patch for this case." It does not invent events or trust the verdict's claim. When CR-1 lands, the model reads `verify-result` events and the extra input can go.

## CR-2: a read endpoint for a case's exhibit content

- Raised by: L3-13 (web trial terminal). Asks Lane 1 (`apps/api`), with a contracts addition in `api.ts`.
- Contracts version: v1.1.
- Status: open.
- Kind: additive (new route and response schema). Minor bump.

### Problem

The event stream carries exhibit ids only, never the witness code or the patch diff. The API has `GET /cases/:id`, `GET /cases/:id/events` and `GET /cases/:id/verdict`, but nothing that serves an `Exhibit`. So the live terminal cannot show the patch a Remedy agent filed, how many files it touched, or its lines changed.

### Proposed change

`GET /cases/:id/exhibits` returning `Exhibit[]` (the existing schema in `evidence.ts`), one per exhibit the case's events name, or `GET /cases/:id/exhibits/:exhibitId` returning one `Exhibit`. Read-only, same auth as the other case reads. Content is untrusted repo-derived data and is rendered as plain text.

### What Lane 3 does meanwhile

`buildTerminalView(events, content)` takes exhibit content as an optional input. Fixture cases read it from `fixtures/exhibits/<slug>.exhibits.json` through `getCaseExhibits(slug)` in `apps/web/src/app/data.ts`. A live case passes none, so the diff panel is empty and the Remedy bubble says the patch content is not in the record. Nothing is inferred from the patch id.
