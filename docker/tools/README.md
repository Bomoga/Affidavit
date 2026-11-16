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

Disabled in `tools.json` (`enabled: false` is the only switch), and the manifest parser rejects an enabled CodeQL entry. It is blocked on the licensing decision (P0-10) and has no image reference, so the argv builder refuses it regardless. `codeql/Dockerfile` is a stub that cannot build without an explicit bundle URL and checksum. Nothing here pulls, builds or runs CodeQL.

## How each tool is run

All runs are `--network none` in the jail, source mounted read-only at `/src`, results written to the mounted `/out`. Argv is an array for `ToolRunnerPort.run(image, args, mounts)`; no shell strings, and nothing from inside the scanned repo reaches argv.

- Semgrep: only our own rules, mounted at `/rules` (`--config /rules`). Never `--config auto` or registry packs, so a `.semgrep.yml` or `.semgrep/` planted in the repo is never read (a docker test checks this). `--metrics=off`, version check off. Hardened with `--no-git-ignore` (never runs git in the repo, so a hostile `.git/config` cannot execute anything), `--disable-nosem` and `--x-ignore-semgrepignore-files`. `--max-target-bytes=0` removes the silent 1 MB cap. Semgrep's own per-file timeouts stay at their defaults, so a single hostile file cannot stall a run. A file that times out or fails to parse is reported by Semgrep as a SARIF notification while the exit code is still 0; `runTool` surfaces these as `partial: true` with the notifications attached. A very large file is therefore either scanned or reported, never silently dropped. SARIF to `/out/semgrep.sarif`.
- OSV-Scanner: `scan source --offline` against a vendored database mounted read-only at `/tmp/osv-scalibr` (`<dir>/<ecosystem>/all.zip`). `--config` is always our empty `config/osv-scanner.toml`, and `--no-ignore` scans lockfiles a repo `.gitignore` would hide. `--no-call-analysis=all` because call analysis runs the Go toolchain (govulncheck) and Rust build scripts on repo content, and can mark findings "uncalled"; reachability is decided elsewhere. Exit 1 means vulnerabilities were found. Exit 128 means no packages were found and no report is written; `runTool` treats it as an empty result only if discovery's own check finds no lockfile OSV-Scanner could read (`findOsvLockfiles`), and throws `ToolFailedError` otherwise, because a malformed lockfile also exits 128. OSV-Scanner prints extraction errors only to stderr, and `ToolRunnerPort` does not return stderr, so the reason is lost; returning stderr (or a log path) from the port is a question for the lead. OSV-Scanner also exits 1 with a report when it parsed one lockfile and dropped a malformed one, so `--all-packages` makes every parsed lockfile appear as a source, and `runTool` marks the run `partial` for each lockfile the snapshot has (per `findOsvLockfiles`) that is missing from the report. The lockfile name list was checked against the extractors in the pinned 2.7.0 binary. Output is OSV JSON (`--format json`, what the L1-03 normalizer reads) at `/out/osv-scanner.json`.
- gitleaks: `dir /src` with our mandatory `config/gitleaks.toml` (`--config` is always set so a repo `.gitleaks.toml` is never loaded), `--ignore-gitleaks-allow`, `--redact`, `--exit-code 0`, and `--max-archive-depth 3` so secrets inside `.gz`, `.zip` and `.tar` files are found (works offline; a docker test covers a gzip). gitleaks silently skips files that its file-type library recognises as non-text (PDF, ELF, MZ, RTF, PostScript, ar archives, Chrome extensions, zstd, cab, swf, NES ROMs, images, fonts and many more) and exits 0, and UTF-16 text is skipped the same way. Discovery cannot import that library and a header allowlist always lags it, so `runTool` sniffs the first 8 KiB of every file on the host and over-flags: any match in a broad signature table, plus any file that does not start like plain text (NUL bytes, invalid UTF-8, control characters). Each flagged file becomes a notification and the run is `partial`. The kinds are `binary-asset` (a signature that agrees with the extension, such as a real PNG), `binary-header-mismatch` (a signature that does not, such as `%PDF` in a `.txt`; this is the hiding technique), `non-text-header` and `unreadable`. Archives gitleaks can unpack are listed too, because the report cannot say which it managed to read. Residual gap: a file type the library recognises whose header is entirely plain text and is missing from the table would be missed. SARIF to `/out/gitleaks.sarif`.

### gitleaks rules and license

`config/gitleaks.toml` is the default rule set of gitleaks v8.30.1 vendored as a standalone config (222 rules), extracted from the binary inside the pinned image rather than downloaded, with the upstream global `[allowlist]` block removed. That block skips `node_modules`, lockfiles, vendored directories, images, `.gem` files and several value patterns, all of which a hostile repo can use to hide a secret. Accepted gaps: the 26 rule-level allowlists upstream ships stay as shipped, for example `@octokit/auth-token/README.md` for the GitHub token rules, Yocto `.bb`/`.bbappend`/`.bbclass`/`.inc` lines for `generic-api-key`, and per-rule stopwords and value regexes. Removing the global list raises false positives (placeholders such as `${VAR}` are no longer skipped); arraignment scoring is where those are weighed.

License status, stated plainly: gitleaks is published by its authors under the MIT license, and this file is a modified copy of its default configuration. This repository is public and the file is already in it, but it carries no MIT copyright and permission notice yet, and the pinned image does not bundle the license text. Adding the notice is pending a decision by the lead; until then treat the file as not yet cleared for redistribution beyond this repository. The header comment in the file records the origin and the change.

### What reports contain

Secret values are masked in the gitleaks report (`--redact`), so L1-01 cannot take them from there. It must take secret locations from the SARIF regions (file, start and end line and column) and read the values from the snapshot (or the sidecar, see below) to build its redaction map. Semgrep SARIF is the opposite problem: it carries the raw matched source lines, so downstream redaction (L1-01, L1-07) must be applied to those snippets before anything is stored or shown to an agent.

### Notes for the normalizer (L1-03)

- SARIF artifact URIs are absolute container paths such as `/src/src/app.js`, not repo-relative. Strip the `/src/` prefix. Reports from the quarantine pass are rewritten to the same shape, `/src/<original path>`.
- OSV is run with `--all-packages`, so its report lists packages that have no vulnerabilities. The normalizer must make candidates only from entries with vulnerabilities.
- Semgrep exits 0 even when files failed to parse or timed out. Read `partial` and `notifications` on the run result, not the exit code.

## Running tools

Our configs live in `docker/tools/config/` and are mounted read-only at `/tool-config`.

The tools need a writable `/tmp` (and Semgrep a writable `/root/.semgrep`). With a read-only root filesystem these are supplied as scratch mounts through the port (`scratchDir`), so the port needs no extension. Use a new, empty scratch directory and a new, empty output directory for every tool run of every case. `runTool` creates them and refuses ones that already have content (`ScratchNotFreshError`, `OutputNotFreshError`), so results from another case or run can never be mistaken for this one. After the run it requires the report to be a regular, non-empty file holding valid JSON (a planted symlink is refused, and a truncated report is a failure), or throws `ToolOutputMissingError`. The runner's returned output path is not used (see the runner contract).

A failed run never returns a result: any exit code the manifest does not list throws `ToolFailedError` carrying the exit code and the quarantine list, so a missing or partial report cannot be parsed as findings.

The OSV database mount path is where osv-scanner looks for its cache. In the read-only jail used here (no writable `HOME`) it was observed at `/tmp/osv-scalibr`; where that default comes from was not traced. If Lane 2's runner sets `HOME`, `XDG_CACHE_HOME`, `TMPDIR` or `OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY` differently, the database must be mounted at the matching `<dir>/osv-scalibr`; a mismatch makes osv-scanner report no offline database and the run fails.

Paths: `buildInvocation` defaults its config directory, and `loadToolManifest` its manifest, to `docker/tools` found by walking up from the source tree. A deployment that does not ship `docker/tools` next to the code must pass `loadToolManifest(path)` and `ToolRunOptions.configDir` explicitly (apps/worker is the place to wire that). `buildInvocation` is not exported from the package: it does not check the snapshot, so `runTool` is the only entry point.

## Runner contract (Lane 2) and known gaps

`runTool` is tested with `LocalDockerToolRunner`-style runners: plain Docker, the mounts it passes, a returned output path fixed at construction. It does not compare that path with the output directory it passed; it reads the report from the `/out` mount and requires a regular, non-empty, valid JSON file there. Any error a runner throws becomes a `ToolFailedError`.

**Known gap: `GvisorToolRunner` (Lane 2) cannot run these tools as they are.** `packages/sandbox/src/gvisor/mounts.ts` reserves `/tmp` and `/scratch` as container paths, so the scratch mount at `/tmp` is rejected for every tool, and the jail sets `HOME` and `TMPDIR` to `/scratch` and runs as uid 65534. That breaks, at least: the writable `/tmp` the tools need, Semgrep's `/root/.semgrep`, the OSV database path, and writing to the `/out` mount as that uid. This needs Lane 2 and the lead; discovery does not edit Lane 2 code. What the tools need from a runner:

- A writable temp directory and home that the runner provides itself, so discovery does not mount `/tmp` or `/root/.semgrep`. Semgrep needs a writable settings directory (`$HOME/.semgrep`).
- The OSV database where osv-scanner looks. OSV-Scanner 2.7.0 has no flag for it. It honors the environment variable `OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY` (checked on the pinned image: the database is then read from `<dir>/osv-scalibr/<ecosystem>/all.zip`), and otherwise falls back to `$TMPDIR/osv-scalibr`. The port cannot set environment variables, so with `TMPDIR=/scratch` the database would have to sit under `/scratch/osv-scalibr`; a runner that can set the variable is simpler. This is a port question for the lead.
- A uid that can write the `/out` mount and read `/src`, `/rules`, `/tool-config` and the database.
- Allowed roots that cover every host path passed: `configDir`, `rulesDir`, `osvDatabaseDir`, the output and scratch directories, and the derived siblings `<copy>.quarantine` (read-only), `<outputDir>-quarantine` and `<scratchDir>-quarantine`. Paths are normalised before `-quarantine` is appended.
- A timeout must surface as a non-zero exit code (the gVisor runner returns 124 or 137 after its 10 minute limit); `runTool` fails closed on any exit code the manifest does not list.

Open questions for the lead: what `ToolRunnerPort.run` should return as `outputPath`, since both runners ignore the mount path; and stderr is not returned, so tool diagnostics (OSV extraction errors, gitleaks skipping an archive) are lost. `runTool` compensates with its own checks, but returning stderr or a log path would be better.

## Accepted gaps

- Sidecar files are scanned under neutral names (`q0001`), so gitleaks rules or allowlists that match on path see the neutral name, not the real one.
- Git history (packed objects) is not secret-scanned; `.git` is moved aside and its objects are skipped rather than listed per file.
- gitleaks rule-level allowlists, described above, remain.
- `--x-ignore-semgrepignore-files` is an internal, experimental Semgrep flag and may disappear on upgrade. The flag-pin test and the hostile docker test fail loudly if it does.
- An unvendored ecosystem database makes OSV-Scanner fail (exit 127): the offline database must hold every ecosystem the snapshot uses, or the run is a `ToolFailedError`, not a partial result. A repo whose only OSV-readable file is something like `deps.json` or `bom.json` that OSV cannot parse also exits 128 and, because the name is on discovery's lockfile list, fails rather than being partial. Whether such cases should be partial instead is a question for the lead.
- `QuarantinedSnapshot` is nominal at the type level only; JavaScript callers can forge it. `runTool` re-checks that the snapshot is clean before every run.

## Snapshot contract for ingestion (L1-01)

Some repo-controlled files change what a scanner does, and a few have no off switch: gitleaks reads a repo `.gitleaksignore` even with our flags (the docker tests demonstrate this). A hostile repo can also plant `.git/config` to run commands through git. So:

1. Ingestion makes a private copy of the repo for scanning and never scans the original checkout. Files the jailed tools cannot read (mode 000) are invisible to them, so ingestion should fix modes on the copy or record such files as unscanned.
2. It calls `quarantineSnapshot(copyDir)` from `packages/discovery/src/tools`. This moves, at any depth, entries matched by exact name, case-insensitively: `.git`, `.gitignore`, `.gitattributes`, `.gitmodules`, `.gitleaksignore`, `.gitleaks.toml`, `.gitleaksbaseline`, `gitleaks.toml`, `osv-scanner.toml`, `.osv-scanner.toml` and `.semgrepignore`. Only `.git` is moved when it is a directory; a directory that merely has a control name (such as `src/.gitignore/`) stays in place and is scanned, because the scanners act only on files and symlinks with those names. There are no prefix matches, so application code in `.semgrep-lib/` stays and is scanned; `.github`, `.semgrep.yml` and `.semgrep/` stay too (Semgrep never reads them from the target). It is two-phase: everything is found before anything moves, and it refuses to start if the sidecar directory already exists.
3. Nothing is deleted. Moved entries go to a sibling sidecar directory, `<copyDir>.quarantine`, under neutral names (`q0001`, `q0002`, ...). `QuarantinedSnapshot` carries `dir`, `sidecarDir`, `mapping` (neutral name to original path) and `removed` (original paths). Record `removed` as a signal on the case: a repo that plants these files is suspicious. A `QuarantinedSnapshot` can only be created by `quarantineSnapshot`; `runTool` takes it instead of a path and returns the list as `quarantined` on its result.
4. `runTool` makes gitleaks scan the sidecar too, so a secret in a moved file (a `.gitignore` or `osv-scanner.toml` can hold one) is not missed. That second report goes to `<outputDir>-quarantine` with paths mapped back to the originals, and both appear in `reports`. The sidecar still holds the repo's own ignore lists, git metadata and configs: keep it out of any workspace that leaves ingestion, and delete it with the snapshot.
5. `resolveQuarantinedUri(snapshot, uri)` maps a report URI such as `/src/.gitignore` back to the file in the sidecar, so L1-01 can read a quarantined file (for example to build its redaction map). `gitDirExtraContent(snapshot)` lists non-metadata files in a quarantined `.git`; `runTool` already marks Semgrep and OSV results partial for them, and checks loose files in a `.git` directory (not its `objects`) for gitleaks-skipped headers.
6. `runTool(runner, manifest, name, options)` is the only supported way to run a tool. It throws `SnapshotNotCleanError` if any control path is still present, `ScratchNotFreshError` or `OutputNotFreshError` for reused directories, `ToolOutputMissingError` for a missing, empty or non-regular report, and `ToolFailedError` for a failing run.
7. For `BundleManifest.toolVersions`, call `toolVersions(manifest, namesOfToolsThatRan)`. Values are `<version>@<image digest>`. The tool set that ran is known only to the worker (apps/worker), so it must pass it.
8. Symlinks inside the copy are not followed by quarantine, but the scanners may see them. Ingestion should drop or flatten symlinks that point outside the copy.

Inline `nosemgrep` and `gitleaks:allow` comments live in source files, so they are handled by flags, not removal.

## Smoke tests

Unit tests run in plain `pnpm test`. The Docker tests run each image offline against `fixtures/corpus/tool-smoke/`: a benign repo, and a hostile one with planted ignore files, configs and rule files, inline suppressions, a git fsmonitor canary, a file over 1 MB, an unparsable file, secrets under `node_modules`, `vendor` and inside a gzip, a secret in a quarantined `.gitignore`, a malformed lockfile, and a Go module (to prove no Go toolchain runs). They are skipped unless explicitly enabled:

```
AFFIDAVIT_DOCKER_TESTS=1 pnpm --filter @affidavit/discovery test:docker
```

PowerShell: `$env:AFFIDAVIT_DOCKER_TESTS = '1'`, then the same command. The first run pulls the three images.

The jail flags in the test mirror `buildDockerRunArgs` in `packages/testing`, which discovery cannot import. A test pins the exact ordered flag sequence against that file, so drift is caught rather than silent. Fixture files that would be live control files or `.json` data are stored renamed (`dot-` prefix, `.fixture` suffix) and restored in a temp copy.

## Updating a pin

Resolve the new tag with `docker buildx imagetools inspect`, run the image to confirm its version, then update `tools.json` (version, tag, digest, reference, resolvedOn) and re-run both test suites. Keep the CI OSV-Scanner digest in step.
