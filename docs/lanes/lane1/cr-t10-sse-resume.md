# CR-T10 resolved: SSE resume wire format (L1-12)

Status: resolved by Lane 1 in L1-12 (`apps/api`). Raised by Lane 3 in `docs/lanes/lane3/contract-requests-trial.md`. This is the API's documented behaviour; it changes no contract schema. The lead may copy it into the `ApiRoutes.caseEvents` comment.

## The format

- **`id:` field.** Every message carries `id: <seq>`, the `TrialEvent.seq` of the event in its `data:` field. `data:` is one line of JSON (one `TrialEvent`). There is no `event:` field.
- **Resume.** The client sends the last seq it has applied, as the `Last-Event-ID` header or as the `after` query parameter (`GET /cases/:id/events?after=12`). The server sends only events with a greater seq. If both are present the larger wins. With neither, the stream starts at seq 0. A malformed value (anything but a non-negative integer without leading zeros) is 400 `invalid-resume-position`.
- **Contiguity.** Seqs are per case, start at 0 and are sent in order without gaps in normal operation. One exception: a writer that allocated a seq (`CaseStore.nextSeq`) and died before emitting leaves a permanent hole. The server holds events past a hole for 5 s, then skips it, so the client then sees one jump.
- **End of stream.** The server closes cleanly once the case has been at a terminal stage for 2 s with nothing new, or after 30 minutes (the client resumes). A case the caller cannot see is a 404 before the stream starts.

## Web client check

`apps/web` (`createTrialStream` with `createSseTransport`) was run, unchanged, against this server, with the server forcing a close every 120 ms while a case was being written. It completed the full 19-event nodegoat stream with no gaps and no duplicates in all three setups: `applyResume` setting `Last-Event-ID`, `applyResume` setting `?after`, and no `applyResume` (replay from 0, client dedupes). No change to `apps/web` was made.

## Follow-ups for Lane 3 (not edited by Lane 1)

1. `apps/web/src/app/source.tsx` builds `createSseTransport` without `applyResume`, so every reconnect replays the whole stream. Suggested default: `({ headers }, seq) => headers.set('Last-Event-ID', String(seq))`. The header is allowed by the API's CORS preflight.
2. The client treats a seq that is not exactly last + 1 as a gap and reconnects from the last applied seq. Against a permanent hole the server re-sends the same jump, so the client loops until `maxAttempts` and shows `disconnected`. Suggested: after reconnecting at the same position, accept a forward jump (or count it in `gapCount` and continue).
3. `createSseTransport` uses `credentials: 'omit'`. That works with dev auth (no credential). With GitHub auth the session is a cookie, so the live UI needs `credentials: 'include'` and the API origin's cookies.
4. `apps/mcp` sends `Authorization: Bearer <AFFIDAVIT_API_TOKEN>`. The API has no token provider yet: it works with dev auth (the header is ignored), not with GitHub auth. A Lane 1 follow-up adds an API token provider.
