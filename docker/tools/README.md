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

Off by default behind `AFFIDAVIT_ENABLE_CODEQL` (manifest metadata only; no code reads it), and blocked on the licensing decision (P0-10). `tools.json` has no reference for it, so the argv builder refuses it whatever is set. `codeql/Dockerfile` is a stub that cannot build without an explicit bundle URL and checksum. Nothing here pulls, builds or runs CodeQL.

## How each tool is run

All runs are `--network none` in the jail, source mounted read-only at `/src`, results written to the mounted `/out`. Argv is an array for `ToolRunnerPort.run(image, args, mounts)`; no shell strings, and nothing from inside the scanned repo reaches argv.

- Semgrep: only our own rules, mounted at `/rules` (`--config /rules`). Never `--config auto` or registry packs. `--metrics=off`, version check off. Hardened with `--no-git-ignore` (never runs git in the repo, so a hostile `.git/config` cannot execute anything), `--disable-nosem` and `--x-ignore-semgrepignore-files`. SARIF to `/out/semgrep.sarif`.
- OSV-Scanner: `scan source --offline` against a vendored database mounted read-only at `/tmp/osv-scalibr` (`<dir>/<ecosystem>/all.zip`). `--config` is always our empty `config/osv-scanner.toml`, and `--no-ignore` scans lockfiles a repo `.gitignore` would hide. Exit code 1 means vulnerabilities were found and is a normal result. Output is OSV JSON (`--format json`, what the L1-03 normalizer reads) at `/out/osv-scanner.json`.
- gitleaks: `dir /src` with our mandatory `config/gitleaks.toml` (extends the default rules; `--config` is always set so a repo `.gitleaks.toml` is never loaded), `--ignore-gitleaks-allow`, `--redact`, `--exit-code 0`. SARIF to `/out/gitleaks.sarif`.

Secret values are masked in the gitleaks report. Semgrep SARIF is different: it carries the raw matched source lines, so downstream redaction (L1-01, L1-07) must be applied to snippets before anything is stored or shown to an agent.

Our configs live in `docker/tools/config/` and are mounted read-only at `/tool-config`.

The tools need a writable `/tmp` (and Semgrep a writable `/root/.semgrep`). With a read-only root filesystem these are supplied as scratch mounts through the port (`scratchDir`), so the port needs no extension. Use a new, empty scratch directory for every tool run of every case; `runTool` creates the subdirectories and refuses a directory that already has content. Never share scratch or output directories between cases.

## Snapshot contract for ingestion (L1-01)

Some repo-controlled files change what a scanner does, and a few have no off switch: gitleaks reads a repo `.gitleaksignore` even with our flags (the docker tests demonstrate this). A hostile repo can also plant `.git/config` to run commands through git. So:

1. Ingestion makes a private copy of the repo for scanning and never scans the original checkout.
2. It calls `quarantineToolControlPaths(copyDir)` from `packages/discovery/src/tools`. This deletes, at any depth: `.git`, `.gitignore`, `.gitattributes`, `.gitmodules`, `.gitleaks*`, `gitleaks.toml`, `osv-scanner.toml`, `.osv-scanner.toml` and `.semgrep*` (names matched case-insensitively; `.github` is kept). It returns the removed paths relative to the copy. Record them as a signal on the case: a repo that plants these files is suspicious. It mutates the directory, so only ever pass the copy.
3. `runTool(runner, manifest, name, options)` is the only supported way to run a tool. It throws `SnapshotNotCleanError` if any control path is still present and `ScratchNotFreshError` if the scratch directory is reused. `buildInvocation` alone does not look at the filesystem.
4. Symlinks inside the copy are not followed by the quarantine step, but the scanners may see them. Ingestion should drop or flatten symlinks that point outside the copy.

Inline `nosemgrep` and `gitleaks:allow` comments live in source files, so they are handled by flags, not removal.

## Smoke tests

Unit tests run in plain `pnpm test`. The Docker tests run each image offline against `fixtures/corpus/tool-smoke/`: a benign repo, and a hostile one with planted ignore files, configs, inline suppressions and a git fsmonitor canary. They are skipped unless explicitly enabled:

```
AFFIDAVIT_DOCKER_TESTS=1 pnpm --filter @affidavit/discovery test:docker
```

PowerShell: `$env:AFFIDAVIT_DOCKER_TESTS = '1'`, then the same command. The first run pulls the three images.

The jail flags in the test mirror `buildDockerRunArgs` in `packages/testing`, which discovery cannot import. A test pins the flag set against that file, so drift is caught rather than silent. Fixture files that would be live control files or `.json` data are stored renamed (`dot-` prefix, `.fixture` suffix) and restored in a temp copy.

## Updating a pin

Resolve the new tag with `docker buildx imagetools inspect`, run the image to confirm its version, then update `tools.json` (version, tag, digest, reference, resolvedOn) and re-run both test suites. Keep the CI OSV-Scanner digest in step.
