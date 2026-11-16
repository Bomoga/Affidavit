# tool-smoke

Data for the offline tool tests (L1-02). Nothing here is a real secret or a real vulnerability record, and nothing runs on its own: the tests in `packages/discovery/src/tools/` copy these trees to a temp directory first.

- `repo/`: a benign repo. An `eval` call for Semgrep, an obviously fake key for gitleaks, and a pinned old `lodash` for OSV-Scanner.
- `hostile/`: a repo that tries to silence or abuse the scanners. It plants ignore files and configs for every tool (`.gitignore`, `.gitleaksignore`, `.gitleaks.toml`, `osv-scanner.toml`, `.semgrepignore` at the root and nested, `.semgrep.yml` and a `.semgrep/` rule directory), a `.git/config` whose `core.fsmonitor` writes a canary file, inline `nosemgrep` and `gitleaks:allow` comments, secrets under `node_modules/` and `vendor/` (paths the upstream gitleaks config skips), a fake key inside the planted `.gitignore`, an unparsable JavaScript file, a Go module (to show no Go toolchain runs), and a second, malformed lockfile in `extra/`. The test adds files that are too large or binary to store here: a file over 1 MB, a gzip with a secret inside, a PDF and a UTF-16 file with secrets, and loose files inside the planted `.git`.
- `rules/semgrep/`: our own Semgrep rule, mounted separately from the source.
- `rules/gitleaks/affidavit-fixture.toml`: one extra gitleaks rule for the fake key. The test appends it to the vendored `docker/tools/config/gitleaks.toml`.
- `osv-advisories/`: two synthetic advisories (npm and Go) that the test packs into an offline OSV database.

Naming: files that would be live control files are stored with a `dot-` prefix (`dot-git`, `dot-gitignore`, ...), and files that would be `.json` data or that git would ignore (`node_modules`) carry a `.fixture` suffix. The tests restore the real names in the temp copy. This keeps planted control files inert inside this repository, and keeps `packages/testing` from treating the `.json` data as contract fixtures.
