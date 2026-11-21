Read docs/plan.md, then docs/implementation-plan.md section 6 (Lane 2) before working in this package.

# @affidavit/signer

**Owner:** Lane 2 (Judge and Evidence), @Thearius123

**Mission:** Holds the cosign signing key; the API and worker can request a signature but cannot read the key.

## Commands

Run from this directory, or add `--filter @affidavit/signer` from the repo root.

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test` (unit; the cosign tests run too when `cosign` is on PATH)
- `pnpm test:sandbox-host` adds the key isolation test (Docker; sandbox host)
- `pnpm test:e2e` runs Lane 2 end to end on one real NodeGoat case (Judge in gVisor, bundle, this signer, public verify, replay); same env as `docs/lanes/lane2/real-judge-host.md` step 9, plus cosign
- `pnpm start` runs the service (env in `src/main.ts`)
- cosign: `bash docker/sandbox/install-cosign.sh` (pinned v3.1.4)

## Invariants

- The key is never readable by the API or the worker: a file key is mode 0400/0600 for the signer's user only (the signer refuses to start otherwise); the shared group is for the socket.
- The signer builds the in-toto statement itself from a manifest that parses; callers never choose what is signed.
- Nothing is uploaded to Sigstore: cosign runs with `OFFLINE_SIGNING_CONFIG`; an attestation with log entries is refused.
- Errors returned to clients carry no detail.

Format and decisions: `docs/lanes/lane2/attestation.md`.

Root CLAUDE.md rules apply here. Do not add dependencies without asking.
