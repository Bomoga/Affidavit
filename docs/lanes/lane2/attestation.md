# Verdict attestations (L2-09)

A verdict is signed by signing its evidence bundle's manifest. The manifest already names the verdict (`verdictSha256`), every exhibit by SHA-256, the pinned target images and the tool versions, so one signature covers all of it.

## Verdict manifest v1

The predicate type `https://github.com/Bomoga/Affidavit/blob/main/docs/lanes/lane2/attestation.md#verdict-manifest-v1` names this section.

The signed statement is an in-toto Statement v1:

| Field           | Value                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subject[0]`    | `name`: `affidavit/<caseId>/manifest.json`; `digest.sha256`: SHA-256 of the manifest's canonical JSON, which are exactly the bytes of `manifest.json` in the bundle |
| `predicateType` | the URL above                                                                                                                                                       |
| `predicate`     | the `BundleManifest` itself (canonical JSON, keys sorted)                                                                                                           |

The signer builds the statement itself from a manifest that parses (`manifestStatement` in `@affidavit/evidence`). A caller never chooses the statement, the subject or the predicate type.

The `Attestation` contract holds the statement, `keyId` (`sha256:` and the hex SHA-256 of the public key's DER SubjectPublicKeyInfo, the same digest cosign puts in a bundle's key hint) and `signature`: the Sigstore bundle (v0.3 JSON) that `cosign attest-blob` writes, with a DSSE envelope over the statement.

## No public log

Verdicts are private. The signer runs cosign with a signing config that lists no Fulcio, Rekor or timestamp service (`OFFLINE_SIGNING_CONFIG`), so nothing is uploaded to Sigstore. A bundle with any transparency log entry is refused (`attestationProblem`). Verification therefore uses `--insecure-ignore-tlog`; that is deliberate, not a shortcut. Signing and the full integration suite pass in a network namespace with only loopback.

## Verifying

With the bundle's `manifest.json` and the attestation's `signature` saved as `attestation.sigstore.json`:

```sh
cosign verify-blob-attestation \
  --key affidavit-signer.pub \
  --bundle attestation.sigstore.json \
  --type 'https://github.com/Bomoga/Affidavit/blob/main/docs/lanes/lane2/attestation.md#verdict-manifest-v1' \
  --insecure-ignore-tlog \
  manifest.json
```

`verifyAttestation` in `@affidavit/evidence` does the same, after the structural checks (statement matches the manifest, signed payload matches the statement, key hint matches `keyId`, no log entries). It is the base for the public verification helper (L2-12).

## Public verification (L2-12)

Anyone holding a bundle can check it without access to our systems: no database, store, signer, sandbox or network. They need the bundle tar, the attestation (the `Attestation` JSON), the published public key(s), cosign, and this repository's `@affidavit/evidence` package.

```sh
pnpm --filter @affidavit/evidence verify bundle.tar attestation.json \
  --key affidavit-signer.pub [--key affidavit-signer-2025.pub] \
  [--expect-sha256 <the verdict's bundleSha256>] \
  [--revoked <keyId of a revoked key>]
```

`verifyPublic` (`src/verify.ts`) stops at the first failure:

1. With `--expect-sha256`, the bundle hashes to it, so it is the bundle the verdict names.
2. `openBundle`: every file is listed in the manifest and hashes to its digest, the verdict hashes to `verdictSha256`, and the case file, manifest and verdict agree. A tampered file is named.
3. `manifest.json` is byte for byte the canonical form of the manifest that parsed, so a field the schema would drop cannot ride along unsigned.
4. The attestation parses, its `keyId` is not revoked, and it is one of the given keys. Pass every published key; the attestation names the one that signed (rotation). Pass `--revoked <keyId>` for every key listed as revoked in `docs/keys/README.md`: a revoked key is refused even when its public key is also passed, because a signature carries no trusted timestamp, so one made after the leak cannot be told apart from an older one.
5. `verifyAttestation`: structural checks, then `cosign verify-blob-attestation` offline with that key.

It prints the bundle digest, case, verdict outcome and severity, exhibit count and key id, then `VERIFIED` or `NOT VERIFIED: <reason>`. Exit codes: 0 verified, 1 not verified, 2 usage or unreadable file, 3 cosign not installed (never reported as verified).

Verification checks that the evidence is the evidence we signed. It does not rerun the exhibits; `affidavit replay` with a sandbox host does that.

## The signer service

`apps/signer` is the only process that can use the key.

- It listens on a unix socket only (no TCP port), mode 0660: its own user and a group shared with the API and the worker. One route, `POST /v1/sign`, takes a `BundleManifest` as JSON (1 MiB max) and returns an `Attestation`. Errors say only `signing failed`; no path, key reference or cosign output reaches a client.
- `SignerClient` is the `SignerPort` the API and the worker use. It holds no key, and it rejects an attestation that is not for the manifest it sent.
- cosign runs with an environment of only `PATH`, a throwaway `HOME` and the key password, so no ambient cloud or OIDC credential is used.
- Configuration: `AFFIDAVIT_SIGNER_SOCKET`, `AFFIDAVIT_SIGNER_KEY` (file path or KMS URI), `AFFIDAVIT_SIGNER_PUBLIC_KEY`, `AFFIDAVIT_SIGNER_PASSWORD_FILE` (file keys). The signer refuses to start when a key file or password file is readable by group or others.
- cosign itself is installed pinned by SHA-256 with `docker/sandbox/install-cosign.sh` (v3.1.4).

## Key custody (open decision)

Where the production key lives and how it rotates is still open in `docs/decisions.md` (owner: Lane 2 owner with the lead). Nothing in the code depends on the answer: `AFFIDAVIT_SIGNER_KEY` is any cosign key reference. The options:

1. An encrypted cosign key file readable only by the signer's user, with its password in the team's secret manager. Works today on one host.
2. A cloud KMS or Vault key (`awskms://`, `gcpkms://`, `hashivault://`). The key never leaves the KMS; needs a cloud account and credentials scoped to the signer.

Either way, rotation means a new key pair, the new public key published next to the old ones, and verifiers trying each published key by `keyId`.

## Tests

- `@affidavit/evidence`: statement shape and subject digest against the bundle's own `manifest.json` bytes; every structural refusal (`attestation.test.ts`).
- `@affidavit/signer` unit: the service answers only `POST application/json` with a manifest, never leaks failure detail, the client refuses an attestation for another manifest (`server.test.ts`).
- With cosign installed (`cosign.integration.test.ts`): the gate case's bundle manifest is signed and verifies with cosign; an altered manifest, another key or a flipped signature byte does not; a wrong password fails without echoing it; signing through the service verifies; the signer refuses a group-readable key or password file.
- On the sandbox host (`isolation.integration.test.ts`, Docker): the signer runs as its own user; a process as the API's identity (another uid sharing only the socket's group, even with the key directory mounted) gets `EACCES` on the key, its password and its directory, and still obtains a signature that verifies.

## Results from real runs

- 2026-11-18, owner's workstation: evidence 5/5 attestation unit tests, signer 6/6 unit, 6/6 with cosign v3.1.4 (also inside a network namespace with only loopback), 1/1 isolation in Docker.
- 2026-11-21, sandbox host: `verify.test.ts` 9/9 (1 with real cosign v3.1.4: signature from files alone verifies with an older key also passed, a flipped signature byte fails), also inside a network namespace with only loopback.
