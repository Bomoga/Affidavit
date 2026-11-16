# tool-smoke

A tiny, harmless repo for the offline tool smoke run (L1-02). It contains an `eval` call for Semgrep, an obviously fake key for gitleaks, and a pinned old `lodash` for OSV-Scanner, matched by a synthetic advisory. The advisory is made up and is not a real vulnerability record.

Files that would otherwise be `.json` carry a `.fixture` suffix, and the smoke test restores their names in a temp copy. `rules/` holds our own rule files, mounted separately from the source.
