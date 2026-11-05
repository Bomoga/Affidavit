# Decisions and open prerequisites

Status as of Nov 5, 2026. Items here come from `docs/plan.md` (Human prerequisites) and `docs/implementation-plan.md` (P0-10 and section 11). An item with no owner is open: do not assume it is settled. Fill in the owner, the date, and the outcome here when it is decided.

## P0-10 blockers

| Item | Blocks | Owner | Needed by | Status |
| --- | --- | --- | --- | --- |
| Linux sandbox host (cloud VM or spare machine) for gVisor | L2-02 and everything after it in Lane 2 | unassigned | Before L2-02 starts | Open |
| Anthropic Console dev key with a monthly spend limit | Any real model call in Lane 3 (fakes cover tests until then) | unassigned | Before the first real trial run | Open |
| Repro code reuse: confirm copying is fine and which agreement covers it | L2-02 starting point | unassigned | Before L2-02 starts | Open |
| Licensing: CodeQL CLI terms and Semgrep rules license, decision recorded here | Enabling CodeQL in L1-02 | unassigned | plan.md says before week 2 (Nov 2), so this is overdue | Open |
| Signing key custody and rotation plan (team-managed cosign key, held where the API cannot read it) | L2-09 | unassigned | Before the first signed verdict | Open |
| Demo date | Whether Phase 3 compresses | Adrian | Unknown | Open |

Until the licensing decision lands, the default is the one plan.md already states: Semgrep with our own rules plus tree-sitter reachability carries discovery, and CodeQL stays behind a disabled flag.

## Other open decisions (implementation-plan section 11)

1. Lane owners for Lanes 1 and 2, and a backup contracts reviewer. CODEOWNERS lists @Bomoga for every path until owners are named.
2. Whether `docs/plan.md` is re-synced from the Claude Doc to reflect three lanes, or keeps four lanes with `docs/implementation-plan.md` as the override. Current state: the implementation plan wins, as its header says.

## Decisions made

- 2026-11-05: Contracts v1.0 resolves the Lane 3 contracts draft: four-level severity, prompt-id keyed `promptVersions` and `modelIds`, per-question ballots, `Witness.sha256`, optional `Verdict.severity`. See `packages/contracts/CHANGELOG.md`.
- 2026-11-05: Internal packages export TypeScript source (`exports` points at `src/index.ts`) and `tsc` runs with `noEmit`. Real builds arrive with the apps that need them.
- 2026-11-05: Dependency versions are pinned exactly, and the pnpm release-age gate stays on. Versions published inside the gate window were replaced by the newest older release instead of adding exclusions.
- 2026-11-05: Dependency install scripts stay disabled except esbuild. Native tree-sitter builds are not used; Lane 1 loads grammars through `web-tree-sitter` (wasm).
- 2026-11-05: `.claude/settings.json` does not allow `docker run` or `docker build` without a prompt. Substring deny patterns cannot make raw docker safe (a security review flagged `-v /:/host` style bypasses). Lane 2 should add a fixed wrapper script (argv from `buildDockerRunArgs`, images allowlisted by digest, mounts restricted to the workspace) and allow only that. This differs from P0-06 as written in the implementation plan.
