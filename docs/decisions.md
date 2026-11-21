# Decisions and open prerequisites

Status as of Nov 5, 2026. Items here come from `docs/plan.md` (Human prerequisites) and `docs/implementation-plan.md` (P0-10 and section 11). An item with no owner is open: do not assume it is settled. Fill in the owner, the date, and the outcome here when it is decided.

## P0-10 blockers

| Item | Blocks | Owner | Needed by | Status |
| --- | --- | --- | --- | --- |
| Linux sandbox host (cloud VM or spare machine) for gVisor | L2-02 and everything after it in Lane 2 | @Thearius123 | Before L2-02 starts | In progress: Lane 2 owner's Fedora 44 workstation, gVisor setup started 2026-11-14. A shared host for CI and the demo is still open |
| Anthropic Console dev key with a monthly spend limit | Any real model call in Lane 3 (fakes cover tests until then) | unassigned | Before the first real trial run | Open |
| Repro code reuse: confirm copying is fine and which agreement covers it | L2-02 starting point | unassigned | Before L2-02 starts | Open |
| Licensing: CodeQL CLI terms and Semgrep rules license, decision recorded here | Enabling CodeQL in L1-02 | unassigned | plan.md says before week 2 (Nov 2), so this is overdue | Open |
| Signing key custody and rotation plan (team-managed cosign key, held where the API cannot read it) | L2-09 | unassigned | Before the first signed verdict | Open |
| Demo date | Whether Phase 3 compresses | Adrian | Unknown | Open |

Until the licensing decision lands, the default is the one plan.md already states: Semgrep with our own rules plus tree-sitter reachability carries discovery, and CodeQL stays behind a disabled flag.

## Other open decisions (implementation-plan section 11)

1. Lane owner for Lane 1, and a backup contracts reviewer. Lane 2 was claimed by @Thearius123 on 2026-11-14. CODEOWNERS lists @Bomoga for every other path until owners are named.
2. Whether `docs/plan.md` is re-synced from the Claude Doc to reflect three lanes, or keeps four lanes with `docs/implementation-plan.md` as the override. Current state: the implementation plan wins, as its header says.

## Decisions made

- 2026-11-05: Contracts v1.0 resolves the Lane 3 contracts draft: four-level severity, prompt-id keyed `promptVersions` and `modelIds`, per-question ballots, `Witness.sha256`, optional `Verdict.severity`. See `packages/contracts/CHANGELOG.md`.
- 2026-11-05: Internal packages export TypeScript source (`exports` points at `src/index.ts`) and `tsc` runs with `noEmit`. Real builds arrive with the apps that need them.
- 2026-11-05: Dependency versions are pinned exactly, and the pnpm release-age gate stays on. Versions published inside the gate window were replaced by the newest older release instead of adding exclusions.
- 2026-11-05: Dependency install scripts stay disabled except esbuild. Native tree-sitter builds are not used; Lane 1 loads grammars through `web-tree-sitter` (wasm).
- 2026-11-05: `.claude/settings.json` does not allow `docker run` or `docker build` without a prompt. Substring deny patterns cannot make raw docker safe (a security review flagged `-v /:/host` style bypasses). Lane 2 should add a fixed wrapper script (argv from `buildDockerRunArgs`, images allowlisted by digest, mounts restricted to the workspace) and allow only that. This differs from P0-06 as written in the implementation plan.
- 2026-11-20 (lead, L2-04c, PR stacked on #46): NodeGoat gets its dependencies through a pinned dependency bundle, built outside the jail from the corpus lockfile and mounted read only into the boot build. An egress exception was declined, and so was a js-yaml-style shortcut. The bundle is built by a human on a networked host (`packages/sandbox/scripts/build-dependency-bundle.ts`, `npm cache add --ignore-scripts`, every lockfile hash checked), never by the Judge or an agent path. It is content addressed (sha256 of the tar, pinned in `docker/sandbox/dependency-bundles/pins.json`), and the build fails closed on a mismatch. It has separate, individually hashed production and dev sections, so the runtime image mounts production only and the suite build mounts both (review of #46: without dev dependencies no real patch could pass the suite). A package that needs a lifecycle script makes its section `unsupported`, by name. Details: `docs/lanes/lane2/boot-recipes.md`, "Dependency bundles".

## Decisions made 2026-11-20 (Adrian)

- CR-1 approved: contracts v1.1 adds the `verify-result` trial event (PR #52, hardening in #53). The VERIFIED stamp rests only on a Judge `verify-result`.
- PR #46 (L2-10): patch verification fails closed. When the target's test suite cannot run, the patch is rejected with a rejection rule, never passed with only `suitePassed: false`. Owner: Lane 2.
- CR-T8: resolved inside Lane 2. `verifyPatch` (PR #17) reads the counterexample parameter header that Lane 3 writes, so ids and runs match what Prosecution submitted. No contract change.
- PR #18 (L2-04): both requests declined. No egress exception for dependency fetch (a target that needs one is marked unsupported, per plan.md) and no `js-yaml` dependency. Owner: Lane 2 to rework.
- PR #51 (L1-07): the new fixture `nodegoat-nosqli-where-001.json` is accepted in place of regenerating `nodegoat-sqli-001.json`. Caveat on record: it was built without a full ingestion, so its empty `redactions` prove nothing about secrets. Follow-ups: L1-01 ingestion on NodeGoat (font files, lockfile chunk split) and moving Lane 3 tests to the new fixture.
- 2026-11-20: NodeGoat dependencies come from a pinned dependency bundle built outside the jail by a human-run step (lifecycle scripts disabled, every tarball hash-checked against the lockfile, production and dev sections hashed separately), mounted read-only into a jailed offline install. No egress exception. Lane 2 PR #55.
- 2026-11-20: NodeGoat dev packages that cannot be installed without scripts or from git (cypress, nodemon, grunt-if) go on an explicit exclusion list that is part of the bundle digest and printed in every build result. The list is a security-relevant item the lead reviews before the bundle pin is set (pins.json stays null until then). This was chosen by the assistant while the lead was away, following the lead's earlier recommendation; reverse it if the lead disagrees.
- 2026-11-20: While the lead is away, the assistant merges a PR into main only when its independent reviewer says MERGE-READY with no open findings, CI is green and it is based on main. The only input still needed from the lead is the Anthropic API key (ANTHROPIC_API_KEY, with a spend limit).
- 2026-11-21 (#55 re-review, decided by the reviewer while the lead was away): dependency bundles allow a `prepare` script in a registry tarball package, since npm runs `prepare` only for the root project and git or folder sources and the install uses `--ignore-scripts`. Each such package is recorded `prepareScriptIgnored: true` in the manifest. `preinstall`, `install`, `postinstall`, `binding.gyp` and any git, file or URL source stay refused. NodeGoat's own suite runs no meaningful tests (no `test/unit`, Gruntfile `force`), so on NodeGoat the patch evidence is the family rerun plus counterexamples, not the suite.
