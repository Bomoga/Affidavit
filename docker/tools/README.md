# docker/tools

Pinned scanner images for discovery. `tools.json` is the single source of truth: every image is referenced as `image@sha256:...`, never by tag alone. The loader, argv builders, snapshot quarantine and the `BundleManifest.toolVersions` map live in `packages/discovery/src/tools/`.

| Tool        | Version | Reference                                                                                            | State    |
| ----------- | ------- | ---------------------------------------------------------------------------------------------------- | -------- |
| Semgrep     | 1.184.0 | `docker.io/semgrep/semgrep@sha256:cc1b68266f267878b39739373ea9985b9a78e5d64497dd875c8de100b22695ed`  | enabled  |
| OSV-Scanner | 2.7.0   | `ghcr.io/google/osv-scanner@sha256:4f3b7e2c64b9d38a5febc5a7e4a3dfef1d1362f726dea7a2ef4762b46469fcd0` | enabled  |
| gitleaks    | 8.30.1  | `ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f`  | enabled  |
| CodeQL      | n/a     | none                                                                                                 | disabled |

Digests are multi-platform index digests resolved on 2026-11-15 with `docker buildx imagetools inspect <image>:<tag>`; each version was confirmed by running the image. OSV-Scanner's digest matches the one already pinned in `.github/workflows/ci.yml` (a test keeps them equal).

## CodeQL

Disabled in `tools.json` (`enabled: false` is the only switch) and blocked on the licensing decision (P0-10). It has no image reference, so the argv builder refuses it regardless. `codeql/Dockerfile` is a stub that cannot build without an explicit bundle URL and checksum. Nothing here pulls, builds or runs CodeQL.

## How each tool is run

All runs are `--network none` in the jail, source mounted read-only at `/src`, results written to the mounted `/out`. Argv is an array for `ToolRunnerPort.run(image, args, mounts)`; no shell strings, and nothing from inside the scanned repo reaches argv.

- Semgrep: only our own rules, mounted at `/rules` (`--config /rules`). Never `--config auto` or registry packs. `--metrics=off`, version check off. Hardened with `--no-git-ignore` (never runs git in the repo, so a hostile `.git/config` cannot execute anything), `--disable-nosem` and `--x-ignore-semgrepignore-files`. It cannot silently give up on a target: `--max-target-bytes=0` (the default skips files over 1 MB with exit 0 and no notice), `--timeout=0` and `--timeout-threshold=0`. Because Semgrep itself no longer times out, the runner must enforce a wall-clock limit on the container (the port has none; this is a request for Lane 2's runner). SARIF to `/out/semgrep.sarif`.
- OSV-Scanner: `scan source --offline` against a vendored database mounted read-only at `/tmp/osv-scalibr` (`<dir>/<ecosystem>/all.zip`). `--config` is always our empty `config/osv-scanner.toml`, and `--no-ignore` scans lockfiles a repo `.gitignore` would hide. `--no-call-analysis=all` because call analysis runs the Go toolchain (govulncheck) and Rust build scripts on repo content, and can mark findings "uncalled"; reachability is decided elsewhere. Exit 1 means vulnerabilities were found; exit 128 means no packages were found, writes no report, and is reported by `runTool` as an empty result. Output is OSV JSON (`--format json`, what the L1-03 normalizer reads) at `/out/osv-scanner.json`.
- gitleaks: `dir /src` with our mandatory `config/gitleaks.toml` (`--config` is always set so a repo `.gitleaks.toml` is never loaded), `--ignore-gitleaks-allow`, `--redact`, `--exit-code 0`. SARIF to `/out/gitleaks.sarif`.

### gitleaks rules and license

`config/gitleaks.toml` is the default rule set of gitleaks v8.30.1 vendored as a standalone config (222 rules), extracted from the binary inside the pinned image rather than downloaded, with the upstream global `[allowlist]` block removed. That block skips `node_modules`, lockfiles, vendored directories, images, `.gem` files and several value patterns, all of which a hostile repo can use to hide a secret. gitleaks is distributed under the MIT license by its authors; the pinned image does not bundle the license text, so verify and add the upstream notice before redistributing this file outside the repository. Accepted gaps: the 26 rule-level allowlists upstream ships stay as shipped, for example `@octokit/auth-token/README.md` for the GitHub token rules, Yocto `.bb`/`.bbappend`/`.bbclass`/`.inc` lines for `generic-api-key`, and per-rule stopwords and value regexes. Removing the global list raises false positives (placeholders such as `${VAR}` are no longer skipped); arraignment scoring is where those are weighed.

### What reports contain

Secret values are masked in the gitleaks report (`--redact`), so L1-01 cannot take them from there. It must take secret locations from the SARIF regions (file, start and end line and column) and read the values from the quarantined snapshot to build its redaction map. Semgrep SARIF is the opposite problem: it carries the raw matched source lines, so downstream redaction (L1-01, L1-07) must be applied to those snippets before anything is stored or shown to an agent.

Our configs live in `docker/tools/config/` and are mounted read-only at `/tool-config`.

The tools need a writable `/tmp` (and Semgrep a writable `/root/.semgrep`). With a read-only root filesystem these are supplied as scratch mounts through the port (`scratchDir`), so the port needs no extension. Use a new, empty scratch directory and a new, empty output directory for every tool run of every case. `runTool` creates them and refuses ones that already have content (`ScratchNotFreshError`, `OutputNotFreshError`), so results from another case or run can never be mistaken for this one. After the run it also requires the report to be a regular, non-empty file (a planted symlink is refused) or throws `ToolOutputMissingError`.

The OSV database mount path is where osv-scanner looks for its cache. In the read-only jail used here (no writable `HOME`) it was observed at `/tmp/osv-scalibr`; where that default comes from was not traced. If Lane 2's runner sets `HOME`, `XDG_CACHE_HOME`, `TMPDIR` or `OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY` differently, the database must be mounted at the matching `<dir>/osv-scalibr`; the docker tests catch a mismatch because osv-scanner then reports no offline database.

Paths: `buildInvocation` defaults its config directory, and `loadToolManifest` its manifest, to `docker/tools` found by walking up from the source tree. A deployment that does not ship `docker/tools` next to the code must pass `loadToolManifest(path)` and `ToolRunOptions.configDir` explicitly (apps/worker is the place to wire that).

## Snapshot contract for ingestion (L1-01)

Some repo-controlled files change what a scanner does, and a few have no off switch: gitleaks reads a repo `.gitleaksignore` even with our flags (the docker tests demonstrate this). A hostile repo can also plant `.git/config` to run commands through git. So:

1. Ingestion makes a private copy of the repo for scanning and never scans the original checkout.
2. It calls `quarantineSnapshot(copyDir)` from `packages/discovery/src/tools`. This deletes, at any depth, files matched by exact name, case-insensitively: `.git`, `.gitignore`, `.gitattributes`, `.gitmodules`, `.gitleaksignore`, `.gitleaks.toml`, `.gitleaksbaseline`, `gitleaks.toml`, `osv-scanner.toml`, `.osv-scanner.toml`, `.semgrepignore`, `.semgrep.yml`, `.semgrep.yaml` and a `.semgrep` entry. There are no prefix matches, so application code in `.semgrep-lib/` or `.gitleaks-fixtures/` stays and is scanned; `.github` stays too. A `.semgrep/` directory is deleted only if it holds nothing but YAML; otherwise `ControlDirectoryHoldsCodeError` is thrown and nothing is hidden. Names are read as raw bytes, so non-UTF-8 names are handled, and a failed removal fails the call. It mutates the directory, so only ever pass the copy.
3. `quarantineSnapshot` returns a `QuarantinedSnapshot` holding the directory and `removed`, the removed paths relative to the copy. Record them as a signal on the case: a repo that plants these files is suspicious. `runTool` takes the `QuarantinedSnapshot` (not a bare path) and returns the same list as `quarantined` on its result, so the list cannot be dropped.
4. `runTool(runner, manifest, name, options)` is the only supported way to run a tool. It throws `SnapshotNotCleanError` if any control path is still present, `ScratchNotFreshError` or `OutputNotFreshError` for reused directories, and `ToolOutputMissingError` for a missing, empty or non-regular report. `buildInvocation` alone does not look at the filesystem.
5. For `BundleManifest.toolVersions`, call `toolVersions(manifest, namesOfToolsThatRan)`. Values are `<version>@<image digest>`. The tool set that ran is known only to the worker (apps/worker), so it must pass it; calling with no names lists every enabled tool.
6. Symlinks inside the copy are not followed by the quarantine step, but the scanners may see them. Ingestion should drop or flatten symlinks that point outside the copy.

Inline `nosemgrep` and `gitleaks:allow` comments live in source files, so they are handled by flags, not removal.

## Smoke tests

Unit tests run in plain `pnpm test`. The Docker tests run each image offline against `fixtures/corpus/tool-smoke/`: a benign repo, and a hostile one with planted ignore files, configs, inline suppressions, a git fsmonitor canary, a file over 1 MB, secrets under `node_modules` and `vendor`, and a Go module (to prove no Go toolchain runs). They are skipped unless explicitly enabled:

```
AFFIDAVIT_DOCKER_TESTS=1 pnpm --filter @affidavit/discovery test:docker
```

PowerShell: `$env:AFFIDAVIT_DOCKER_TESTS = '1'`, then the same command. The first run pulls the three images.

The jail flags in the test mirror `buildDockerRunArgs` in `packages/testing`, which discovery cannot import. A test pins the flag set against that file, so drift is caught rather than silent. Fixture files that would be live control files or `.json` data are stored renamed (`dot-` prefix, `.fixture` suffix) and restored in a temp copy.

## Updating a pin

Resolve the new tag with `docker buildx imagetools inspect`, run the image to confirm its version, then update `tools.json` (version, tag, digest, reference, resolvedOn) and re-run both test suites. Keep the CI OSV-Scanner digest in step.
