# normalize

Golden inputs for the L1-03 normalizer (`packages/discovery/src/normalize/`).

- `repo/`: a small deliberately unsafe app (SQL concatenation, a `$where` NoSQL pattern, an IDOR lookup), four files with awkward names (`100%.js`, `a%20b.js`, `a#b.js`, `é.js`) and a lockfile. Names Windows cannot hold (`a\b.js`, `a#b?.js`) are covered by synthetic SARIF in the tests only. `.fixture` suffixes are dropped when it is copied for a run. Nothing here is a secret or a real vulnerability record.
- `rules/semgrep/`: test-only Semgrep rules with CWE metadata. These are not the product rules (L1-04).
- `osv-advisories/`: two synthetic advisories, one with `database_specific.cwe_ids` and one without. The real OSV database is not vendored yet, so these stand in for it.
- `recorded/semgrep.sarif.fixture` and `recorded/osv-*.json.fixture`: real output of the pinned Semgrep 1.184.0 and OSV-Scanner 2.7.0 images, run offline through `runTool` against `repo/` with the rules and advisories above. Recorded with `packages/discovery/src/normalize/record.docker.test.ts` (needs Docker; see the header of that file). The OSV reports are one per advisory only because the recorder packs a single advisory per database.
- `recorded/codeql.sarif`: **hand-written and unverified, not a tool run.** CodeQL is disabled pending the licensing decision and is never pulled or run. The file follows the SARIF 2.1.0 shape CodeQL is documented to emit (rules in `tool.extensions[]`, results pointing at them with `rule.{id,index,toolComponent}`, relative `%SRCROOT%` URIs, `external/cwe/cwe-NNN` tags), but it has not been checked against real CodeQL output. Replace it with a real sample once CodeQL is licensed.
- `golden/normalized.golden.json.fixture`: expected output of `normalizeReports` over all of the above. Regenerate with `AFFIDAVIT_UPDATE_GOLDEN=1 pnpm --filter @affidavit/discovery exec vitest run normalize.test` and review the diff.
