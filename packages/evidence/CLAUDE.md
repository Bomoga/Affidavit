Read docs/plan.md, then docs/implementation-plan.md section 6 (Lane 2) before working in this package.

# @affidavit/evidence

**Owner:** Lane 2 (Judge and Evidence), @Thearius123

**Mission:** Evidence bundles, replay, and signing.

## Commands

Run from this directory, or add `--filter @affidavit/evidence` from the repo root.

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm test:sandbox-host` (replay through the real gVisor jail; sandbox host only)
- `pnpm test:s3` (S3 store against MinIO; needs `AFFIDAVIT_S3_ENDPOINT`, `AFFIDAVIT_S3_ACCESS_KEY`, `AFFIDAVIT_S3_SECRET_KEY`)

## Invariants

- Bundle bytes are untrusted until `openBundle` has checked every digest. Never extract a bundle to disk, never run anything from it before that check.
- A bundle is deterministic: same evidence, same bytes. Do not add timestamps or host details to it outside `createdAt` and `toolVersions`.
- Replay compares admissibility outcomes, never timings. It never reports success without rerunning.
- Every store read checks the bytes against their address.

Layout and rules: `docs/lanes/lane2/evidence-bundles.md`.

## Libraries

- `tar-stream` (bundles), `@aws-sdk/client-s3` (S3 store), `zod` (exhibit records).
- Sigstore cosign (CLI, verification in `attestation.ts`), hand-rolled in-toto statement (contracts). See `docs/lanes/lane2/attestation.md`.

Root CLAUDE.md rules apply here. Do not add dependencies without asking.
