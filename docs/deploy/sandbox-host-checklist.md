# Sandbox host and CI runner checklist (P0-10)

Status: **draft for the lead and the Lane 2 owner**. This is a checklist to confirm or provision, not a record that anything was done. I created, bought and logged in to nothing. The authoritative step list is `docs/lanes/lane2/real-judge-host.md` ("On the host, in order"); this page adds what to decide before those steps.

## What exists today (per Lane 2 PROGRESS.md, not rerun by me)

The Lane 2 owner ran the real sandbox-host suites on a personal Fedora workstation on 2026-11-16 and 2026-11-21: signer e2e 4 of 4, judge `test:sandbox-host` 130 of 130, sandbox `test:sandbox-host` 546 of 546. No shared host and no CI runner exists. That blocks Lane 2 sign-off.

## Decide first

- [ ] **Host.** Which machine runs the sandbox, Judge and signer? The workstation is acceptable for the demo only. `key-custody.md` explains why a signing key on the same host as untrusted code is a risk, and what must change before an outside pilot.
- [ ] **Separate signing host** before any outside pilot, or a KMS key (a code change, see `key-custody.md`).
- [ ] **Who administers it** and who has root.
- [ ] **CI runner.** A self-hosted runner with gVisor, or manual runs only. Untrusted repo content must never reach a runner that holds secrets. Cost: [metric].

## Host requirements

- [ ] Linux with Docker. Lane 2 ran Docker 29.9.3 and gVisor release-20261109.0, runtime `runsc-affidavit`.
- [ ] gVisor installed and both runtimes registered: `docker/sandbox/install-gvisor.sh`, then `docker/sandbox/setup-runsc-audit.sh` (as root).
- [ ] cosign on PATH: `docker/sandbox/install-cosign.sh`.
- [ ] Node 24 and pnpm 11; `pnpm install --frozen-lockfile`.
- [ ] A quota'd Judge work root and a separate evidence directory, neither inside the other.
- [ ] Egress deny verified for the jail (the egress guard and containment suite).
- [ ] NodeGoat trees fetched and verified: `packages/corpus/scripts/fetch-pinned.mjs nodegoat` and `nodegoat safe`.
- [ ] Dependency bundle built by a human on a networked host, manifest and `packages/sandbox/bundle-exclusions.json` reviewed, `bundleSha256` set in `docker/sandbox/dependency-bundles/pins.json`. The pin is set per the Lane 2 notes. The exclusion list review is Adrian's.
- [ ] Runner and patch-apply images built; ids recorded as `AFFIDAVIT_WITNESS_RUNNER_IMAGE` and `AFFIDAVIT_PATCH_APPLY_IMAGE`.
- [ ] Signer started with its socket outside the work root, evidence root and bundle store.

## Checks before sign-off (run on the host, report any not run as not run)

- [ ] `pnpm --filter @affidavit/judge containment`
- [ ] `pnpm --filter @affidavit/sandbox test:sandbox-host`
- [ ] `pnpm --filter @affidavit/judge test:sandbox-host`
- [ ] `pnpm --filter @affidavit/signer test:e2e`
- [ ] The real-port walking-skeleton run in `docs/implementation-plan.md` section 8: Semgrep candidate to signed verdict, differential admission, family flip, replay on a second machine, containment suite. Not run by anyone yet.

## Still open on the code side (from `real-judge-host.md`)

No stage seals a bundle yet (CR-11, second half). `runAddedTests` returns null. Targets live in memory, so a worker restart reboots them. The worker with real wiring has not run on the host.

## Decision needed

Which host for the demo, and whether the demo may use the signing key on the workstation (revoked afterward, with nothing shown outside as proof).
