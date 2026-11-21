# Real Judge on a sandbox host (CR-11, L2-12 target provider)

For the lead. What the Linux sandbox host needs to run one real NodeGoat case end to end through `createRealJudge` (`packages/judge/src/jail/real.ts`), in order. Nothing in this note was run on that host yet: the branch was written and unit tested on Windows, where gVisor does not run. The sandbox-host test `packages/judge/src/jail/real.integration.test.ts` is written and skips itself, with the reason in its title, until every input below exists. No numbers here are measurements.

## What changed

- **`CaseTargets`** (`jail/targets.ts`) is the real `TargetProvider`. Given a case file it resolves the vulnerable tree and, when the case file has a `safeVariant`, the safe tree; builds both images with the L2-04 split build (`buildTarget`, which stages the tree and derives the recipe with `deriveRecipe`) and the case's pinned dependency bundle; checks that the safe recipe shows the witness the same surface (port, health route, sidecar names, stub aliases); boots each on its own case network under gVisor and waits for health; and only then records both image IDs. Every failure tears down every case network the boot made (target, sidecars, anonymous volumes) and returns a typed `CaseBootFailure` (`unsupported` or `boot-failed`, with the variant and step). Docker errors are outcomes, not exceptions. A case with a safe variant is never served with only its vulnerable target.
- **Digests without a contract change.** The stored case file stays immutable. `CaseTargets.bind` returns a copy with `target.imageDigest` and `safeVariant.imageDigest` set to the booted images, and the Judge runs on that copy, so `BootedTargets` still serves a variant only for the exact image the evidence names. `boot(...).digests` is the value for `BundleManifest.targetDigests`; `dependencyBundles(caseFile)` gives the bundle digests for `toolVersions`.
- **`CaseBoundJudge`** wraps the Judge: every `JudgePort` call binds the case first. A boot failure throws `CaseBootError` before any witness runs. The worker already turns a thrown Judge error into a failed stage attempt and then a review flag, so a high-score case is never dismissed because its target would not boot.
- **Patch workbench.** `JailedPatchWorkbench` now takes a per-case registry (`targets: (caseFile) => Promise<BootedTargets>`), a per-case bundle and an async source lookup, so the patched target is registered next to that case's vulnerable and safe targets and two cases can verify patches at once. Nothing else in the workbench changed (jailed `git apply --numstat` and apply, manifest check, patched build and boot, suite build with dev dependencies, `npm test`, family rerun and counterexamples through the Judge).
- **`createRealJudge(config)`** assembles `Judge` + `JailExecutor` + `CaseTargets` + `JailedPatchWorkbench` + the evidence store + the signer client from a typed `RealJudgeConfig`. It runs `checkRealJudgePrerequisites` first and throws `RealJudgePrerequisiteError` listing everything missing at once. Messages name the config field and the worker variable, never a value; bundle errors have their paths replaced by `<bundle>` and `<bundle store>`. The evidence store and signer client are passed in already built (`FsEvidenceStore`, `SignerClient`), because `@affidavit/judge` does not depend on `@affidavit/evidence` or `apps/signer` (evidence already devDepends on judge; no new dependency was added).

- **Review of #61 fixes.** A safe variant that is the vulnerable tree is refused as `unsupported` at `compare` before any witness runs: the same directory, the same content (`fingerprintSourceTree`, a SHA-256 over the tree as staging sees it, symlinks never followed), or the same built image. The startup check resolves every symlink (`realpath`, case-insensitive on Windows and macOS) before it checks that `workRoot` and `evidenceRoot` do not contain one another in either direction, that the evidence store is not under a dependency bundle store, and that `signerSocket` is not under `workRoot`, `evidenceRoot` or a bundle store. A boot whose teardown failed keeps the case tracked (`caseIds`), and the next boot or `release` retries the teardown before anything else.
- **Startup sweep.** `createRealJudge` calls `CaseTargets.sweepOrphans()` (`sweepCaseResources` in `packages/sandbox`) after the check passes. It removes every container and case network labelled `affidavit.sandbox.run` that a previous worker run left. It also removes another live process's jails, so run one Affidavit process per Docker host, or set `sweepOrphans: false` on a shared host. A sweep that cannot finish blocks startup.

## What still cannot run

- **Without the bundle, NodeGoat does not build.** `docker/sandbox/dependency-bundles/pins.json` has `bundleSha256: null` for NodeGoat. Until a human builds, reviews and pins the bundle, `createRealJudge` with a NodeGoat bundle configured refuses to start ("no bundleSha256 for nodegoat"), and with none configured every NodeGoat case is `unsupported` at build (a dependency fetch). That covers the witness boot, the patched target and the suite image alike.
- **verifyPatch needs Lane 1's `RescanPort`.** Only `FakeRescan` exists. Without `config.rescan`, `verifyPatch` throws (fail closed) and the startup report carries a note.
- **No stage seals a bundle.** `createRealJudge` returns the evidence store and the signer client for that; the sealing stage is still open (CR-11, second half).
- **Targets live in process memory.** A worker restart forgets the booted targets; the next Judge call boots again. The image IDs are expected to be stable for the same inputs, but that is not checked here, so evidence from before and after a restart may name different digests (each result is still tied to the image it ran against).
- **`runAddedTests`** still returns null (unchanged from L2-07).

## On the host, in order

1. **gVisor runtimes, as root:** `docker/sandbox/install-gvisor.sh`, then `docker/sandbox/setup-runsc-audit.sh` (registers `runsc` and `runsc-affidavit` in `/etc/docker/daemon.json` and creates `/var/lib/affidavit-runsc`). The startup check reads the daemon config for both runtime names; pass `dockerDaemonConfig` if Docker reads another file.
2. **cosign** for the signer: `bash docker/sandbox/install-cosign.sh`.
3. **Repository:** `pnpm install --frozen-lockfile`.
4. **NodeGoat trees** (verified: commit, tree and archive hash; the safe tree gets the corpus patch):
   - `node packages/corpus/scripts/fetch-pinned.mjs nodegoat` (to `packages/corpus/data/src/nodegoat`)
   - `node packages/corpus/scripts/fetch-pinned.mjs nodegoat safe` (to `packages/corpus/data/src/nodegoat-safe`)
5. **Dependency bundle, human-run, on a networked host, never in a jail** (`boot-recipes.md`, "Dependency bundles"):
   - `pnpm --filter @affidavit/sandbox bundle:build --app nodegoat --checkout packages/corpus/data/src/nodegoat --out <bundle store>`
   - A human reviews `<sha256>.json` (the manifest) and `packages/sandbox/bundle-exclusions.json`, then sets `bundleSha256` for NodeGoat in `docker/sandbox/dependency-bundles/pins.json` and commits it for review.
   - Copy `<sha256>.tar` into the bundle store on the sandbox host. The store must be a real directory the bundle resolves inside.
6. **Images:** `pnpm --filter @affidavit/judge runner-image` and `pnpm --filter @affidavit/judge patch-apply-image`. Each prints an image ID (`sha256:<64 hex>`). Both builds use the network on the host by design (reviewed `networkByDesign` entries in the egress guard); the images then run with none.
7. **Directories:** a quota'd Judge work root (its own filesystem or quota, `boot-recipes.md`, host setup) and an evidence directory, in separate trees (neither inside the other).
8. **Signer:** start `apps/signer` (`pnpm --filter @affidavit/signer start`, env in `apps/signer/src/main.ts`) and note its socket.
9. **Run the sandbox-host test** (one file at a time, it checks global Docker state):

   ```
   export AFFIDAVIT_SANDBOX_HOST=1
   export AFFIDAVIT_NODEGOAT_DIR="$PWD/packages/corpus/data/src/nodegoat"
   export AFFIDAVIT_NODEGOAT_SAFE_DIR="$PWD/packages/corpus/data/src/nodegoat-safe"
   export AFFIDAVIT_DEPENDENCY_BUNDLE_ROOT=<bundle store>
   export AFFIDAVIT_NODEGOAT_BUNDLE=<bundle store>/<sha256>.tar
   pnpm --filter @affidavit/judge exec vitest run src/jail/real.integration.test.ts
   ```

   It boots both variants from a case file with no `imageDigest`, admits the gate `$where` witness on the differential rule, verifies the corpus safe patch (family flips; NodeGoat's suite passes vacuously, see `boot-recipes.md`), releases, and checks that no labelled container or network is left. The full Lane 2 host suites are `pnpm --filter @affidavit/sandbox test:sandbox-host` and `pnpm --filter @affidavit/judge test:sandbox-host` (the latter includes this file and `nodegoat.integration.test.ts`). Run `pnpm --filter @affidavit/judge containment` too, since `src/jail` changed.

10. **Worker** (after Lane 1 wires `createRealJudge`, see below): the variables in `docs/lanes/lane1/real-wiring.md` (PR #60), plus `AFFIDAVIT_PATCH_APPLY_IMAGE`, `AFFIDAVIT_DEPENDENCY_BUNDLE_ROOT` and the two NodeGoat tree paths.

## Requests for the lead and Lane 1 (not done here; no Lane 1 or contracts file was edited)

- **CR-11, where the boot happens.** This branch answers it as option (b) without a contract change: the Judge (Lane 2) boots per case, and the digest is a Judge-owned record (`CaseTargets.boot(...).digests`), not a field of the immutable case file. If the lead wants it in the audit trail, the smallest change is a `TrialEvent` for "targets booted" carrying the per-variant digests and bundle digests; that is a contracts change and is only requested here.
- **Worker wiring (Lane 1, `apps/worker/src/real/components.ts`).** Replace `new Judge(new JailExecutor({ targets: new BootedTargets() }))` with `createRealJudge({...})`, mapping: `AFFIDAVIT_JUDGE_WORK_ROOT` to `workRoot`, `AFFIDAVIT_WITNESS_RUNNER_IMAGE` to `runnerImage`, a new `AFFIDAVIT_PATCH_APPLY_IMAGE` to `applyImage`, `AFFIDAVIT_EVIDENCE_DIR` to `evidenceRoot` plus `new FsEvidenceStore(...)` as `evidence`, `AFFIDAVIT_SIGNER_SOCKET` to `signerSocket` plus `new SignerClient(...)` as `signer`, a `SourceResolver` (`directorySources` over the fetch-pinned trees, or one on the corpus loader), and `dependencyBundles: [{ app: 'nodegoat', repo, path: AFFIDAVIT_NODEGOAT_BUNDLE, storeRoot: AFFIDAVIT_DEPENDENCY_BUNDLE_ROOT }]`. Call `release(caseId)` when a case reaches a verdict or a review flag, and `close()` on shutdown. `createRealJudge`'s own check can replace the Judge part of `checkPrerequisites`.
- **`AFFIDAVIT_NODEGOAT_BUNDLE` is a file, not a directory.** PR #60's `checkPrerequisites` tests it with `isDirectory`; the bundle is the `<sha256>.tar` file inside the store (`pinnedDependencyBundle`). As written, a correct value would be refused there.
- **Which safe variant (CR-1).** `CaseFile.safeVariant` is a `TargetRef` (repo, commit, variant) and does not say which corpus safe variant (which patches) it means. `directorySources` keys trees by repo, commit and variant, so one safe tree per commit. NodeGoat has one safe variant today; a second would need the case file, or the resolver, to name it.
- **Rescan port.** `verifyPatch` needs Lane 1's `RescanPort` in `config.rescan`.
