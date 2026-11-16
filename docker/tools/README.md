# docker/tools

Pinned scanner images for discovery. `tools.json` is the single source of truth: every image is referenced as `image@sha256:...`, never by tag alone. The loader, argv builders and the `BundleManifest.toolVersions` map live in `packages/discovery/src/tools/`.

| Tool        | Version | Reference                                                                                            | State    |
| ----------- | ------- | ---------------------------------------------------------------------------------------------------- | -------- |
| Semgrep     | 1.184.0 | `docker.io/semgrep/semgrep@sha256:cc1b68266f267878b39739373ea9985b9a78e5d64497dd875c8de100b22695ed`  | enabled  |
| OSV-Scanner | 2.7.0   | `ghcr.io/google/osv-scanner@sha256:4f3b7e2c64b9d38a5febc5a7e4a3dfef1d1362f726dea7a2ef4762b46469fcd0` | enabled  |
| gitleaks    | 8.30.1  | `ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f`  | enabled  |
| CodeQL      | n/a     | none                                                                                                 | disabled |

Digests are multi-platform index digests resolved on 2026-11-15 with `docker buildx imagetools inspect <image>:<tag>`; each version was confirmed by running the image. OSV-Scanner's digest matches the one already pinned in `.github/workflows/ci.yml` (a test keeps them equal).

## CodeQL

Off by default behind `AFFIDAVIT_ENABLE_CODEQL`, and blocked on the licensing decision (P0-10). `tools.json` has no reference for it, so the argv builder refuses it regardless of the flag. `codeql/Dockerfile` is a stub that cannot build without an explicit bundle URL and checksum. Nothing here pulls, builds or runs CodeQL.

## How each tool is run

All runs are `--network none` in the jail, source mounted read-only at `/src`, results written to the mounted `/out`. Argv is an array for `ToolRunnerPort.run(image, args, mounts)`; no shell strings.

- Semgrep: only our own rules, mounted at `/rules` (`--config /rules`). Never `--config auto` or registry packs. `--metrics=off`, version check off. SARIF to `/out/semgrep.sarif`.
- OSV-Scanner: `scan source --offline` against a vendored database mounted read-only at `/tmp/osv-scalibr` (`<dir>/<ecosystem>/all.zip`). Exit code 1 means vulnerabilities were found and is a normal result. SARIF to `/out/osv-scanner.sarif`.
- gitleaks: `dir /src --redact --exit-code 0`, so secret values are masked in the report and findings are not failures. Optional config file from `/rules`. SARIF to `/out/gitleaks.sarif`.

The tools need a writable `/tmp` (and Semgrep a writable `/root/.semgrep`). With a read-only root filesystem these are supplied as scratch mounts through the port (`scratchDir`), so the port needs no extension. Whatever runs these must create `scratchSubdirs` first.

## Smoke tests

Unit tests run in plain `pnpm test`. The Docker smoke test runs each image offline against `fixtures/corpus/tool-smoke/` and is skipped unless explicitly enabled:

```
AFFIDAVIT_DOCKER_TESTS=1 pnpm --filter @affidavit/discovery test:docker
```

PowerShell: `$env:AFFIDAVIT_DOCKER_TESTS = '1'`, then the same command. The first run pulls the three images.

## Updating a pin

Resolve the new tag with `docker buildx imagetools inspect`, run the image to confirm its version, then update `tools.json` (version, tag, digest, reference, resolvedOn) and re-run both test suites. Keep the CI OSV-Scanner digest in step.
