# normalize

Golden inputs for the L1-03 normalizer (`packages/discovery/src/normalize/`).

- `repo/`: a small deliberately unsafe app (SQL concatenation, a `$where` NoSQL pattern, an IDOR lookup) and a lockfile. `.fixture` suffixes are dropped when it is copied for a run. Nothing here is a secret or a real vulnerability record.
- `rules/semgrep/`: test-only Semgrep rules with CWE metadata. These are not the product rules (L1-04).
- `osv-advisories/`: two synthetic advisories, one with `database_specific.cwe_ids` and one without. The real OSV database is not vendored yet, so these stand in for it.
- `recorded/semgrep.sarif.fixture` and `recorded/osv-*.json.fixture`: real output of the pinned Semgrep 1.184.0 and OSV-Scanner 2.7.0 images, run offline through `runTool` against `repo/` with the rules and advisories above. Recorded with `packages/discovery/src/normalize/record.docker.test.ts` (needs Docker; see the header of that file). The OSV reports are one per advisory only because the recorder packs a single advisory per database.
- `recorded/codeql.sarif`: **hand-written, not a tool run.** CodeQL is disabled pending the licensing decision and is never pulled or run. The file follows the SARIF 2.1.0 shape CodeQL emits (relative `%SRCROOT%` URIs, `external/cwe/cwe-NNN` rule tags) so the SARIF path is covered.
- `golden/normalized.golden.json.fixture`: expected output of `normalizeReports` over all of the above. Regenerate with `AFFIDAVIT_UPDATE_GOLDEN=1 pnpm --filter @affidavit/discovery exec vitest run normalize.test` and review the diff.
