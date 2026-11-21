# rescan

Inputs for the L1-17 discovery re-scan (`packages/discovery/src/rescan/`), the Lane 1 `RescanPort` that the Judge's `verifyPatch` calls on a patched tree.

The trees are the normalizer repo (`../normalize/repo`) with `src/routes.js` replaced:

- `patched/src/routes.js.fixture`: the `$where` sink at line 15 is fixed (the request value is parsed to an integer and passed as a plain filter). Everything after it moves down one line. The SQL and IDOR sinks are left alone.
- `shifted/src/routes.js.fixture`: two lines added at the top and nothing fixed, so every finding in the file moves down two lines.

SARIF:

- `vulnerable`: the real recording `../normalize/recorded/semgrep.sarif.fixture` (pinned Semgrep 1.184.0, test rules in `../normalize/rules/semgrep`).
- `derived/semgrep-patched.sarif.fixture` and `derived/semgrep-shifted.sarif.fixture`: **derived by hand from that recording, not tool runs.** `patched` drops the `affidavit.normalize.nosql-where` result and moves the later `src/routes.js` results down one line; `shifted` moves every `src/routes.js` result down two lines. Nothing else changed. Replace them with real runs: `packages/discovery/src/rescan/rescan.docker.test.ts` runs the re-scan on the pinned image against these trees and, with `AFFIDAVIT_RECORD_DIR`, writes the raw SARIF of each run (needs Docker; see the header of that file).

Nothing here is a secret or a real vulnerability record.
