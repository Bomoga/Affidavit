Read docs/plan.md, then docs/implementation-plan.md section 5 (Lane 1) before working in this package.

# @affidavit/discovery

**Owner:** Lane 1 (Intake and Platform)

**Mission:** Repo ingestion, the map, tool runners, and arraignment scoring.

## Commands

Run from this directory, or add `--filter @affidavit/discovery` from the repo root.

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm test:docker`: the tests that run the real pinned scanner images (`src/tools/tools.docker.test.ts`). They are skipped unless `AFFIDAVIT_DOCKER_TESTS=1`. Bash: `AFFIDAVIT_DOCKER_TESTS=1 pnpm --filter @affidavit/discovery test:docker`. PowerShell: `$env:AFFIDAVIT_DOCKER_TESTS = '1'`, then the same command. Needs Docker; the first run pulls the three pinned images. Containers run with `--network none`.
- `node ../../docker/tools/probe/archive-names.mjs` (from the repo root: `node docker/tools/probe/archive-names.mjs`): rederives which file names the pinned gitleaks drops as archives and compares them with `ARCHIVE_NAME`. Needs Docker, takes about five minutes, exits 0 only when the rule matches gitleaks in both directions (a miss or an over-match exits 1). Rerun it whenever the gitleaks pin in `docker/tools/tools.json` changes. Its two pure helpers are unit tested in `src/tools/probe.test.ts`.

## Scanner wrappers (`src/tools/`)

Semgrep, OSV-Scanner and gitleaks run as pinned Docker images (`docker/tools/tools.json`, always `image@sha256:...`) through `ToolRunnerPort`. CodeQL is disabled and has no image. `docker/tools/README.md` has the full explanation; the pieces are:

- `manifest.ts`, `invocations.ts`: load the manifest and build the argv and mounts for each tool.
- `quarantine.ts`: copies the repo to a scan snapshot, moves tool-control paths (`.git`, ignore files, config) into a sidecar and keeps a neutral-name mapping back to the original paths.
- `run.ts`: `runTool` runs a tool and fails closed (typed `ToolFailedError`, `ToolOutputMissingError`). For gitleaks it adds a sidecar pass and a windows pass, then maps every report path back to `/src/<original path>`. Report text (`message.text`) is rewritten too, so no internal `qNNNN` or `wNNNN/pNNNN` name reaches a report.
- `unscannable.ts`: decides on the host what gitleaks will skip or cut through (it exits 0 either way).
- `windows.ts`: overlapping windows under 100,000 bytes for large text files and archive-named files. `maxWindowBytes` must be a finite number of at least 0; anything else throws `RangeError` before a tool runs.

## Coverage notifications

`ToolRunResult.notifications` holds coverage losses; any notification makes the result `partial`. A partial result means "incomplete", never "clean". Kinds (`id`):

- Semgrep: the tool's own notification ids, and `git-dir-extra-content` (content inside a quarantined `.git`).
- OSV-Scanner: `lockfile-not-in-report`, `git-dir-extra-content`.
- gitleaks: `binary-header-mismatch`, `non-text-content`, `unreadable`, `skipped-file-type`, `archive-name-mismatch`, `chunk-split-risk`, `multiline-split-risk`, and from the windows pass `window-skipped` (a file or window could not be written or may still be skipped) and `windows-budget-exceeded` (the byte budget ran out).

An `archive-name-mismatch` message says the file is scanned in a window only when it really was windowed. Otherwise (a PDF, executable or other skipped signature, a window write failure, a quarantined sidecar file) it says the content is NOT scanned. Image, audio and video files are not coverage losses and are listed in `binaryMediaFiles` only.

Root CLAUDE.md rules apply here. Do not add dependencies without asking.

## Libraries still to come (notes, not installed)

- tree-sitter
- A SARIF parser (TBD)
