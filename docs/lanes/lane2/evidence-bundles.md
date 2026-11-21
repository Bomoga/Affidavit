# Evidence bundles and replay (L2-08)

Code: `packages/evidence`. A bundle holds everything needed to check a verdict again: the case
file, every exhibit as it was submitted, the result the Judge recorded for it, and the verdict.
`replay` checks the bundle's integrity, reruns every exhibit through a Judge, and compares the
admissibility outcomes with the recorded ones.

## Layout (format version 1)

A bundle is a tar of regular files. Every JSON file is canonical JSON (keys sorted at every level,
no whitespace), and the tar is written with fixed metadata (mode 0644, uid and gid 0, mtime 0, files
in name order), so the same evidence always gives the same bytes and the same digest.

| File                 | Content                                                                 | Covered by                                               |
| -------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------- |
| `manifest.json`      | `BundleManifest` (contracts v1.0)                                       | the bundle digest, and from L2-09 the signed attestation |
| `casefile.json`      | the `CaseFile`                                                          | manifest `exhibits` entry with id `casefile`             |
| `exhibits/<id>.json` | one exhibit record (below), filed under the exhibit id the Judge minted | manifest `exhibits` entry with that id                   |
| `verdict.json`       | the `Verdict` without `bundleSha256`                                    | manifest `verdictSha256`                                 |

The bundle's address is the SHA-256 of the tar bytes. That is the value a verdict's
`bundleSha256` takes and the key `GET /bundles/:sha256` uses. A verdict cannot contain the digest
of a bundle that contains it, so `verdict.json` is the verdict with `bundleSha256` removed, and
`verdictSha256` covers every other field.

`manifest.toolVersions` always carries `affidavit-bundle: "1"`, the format version. Callers add
the versions of what produced the evidence (runner image, Judge, scanners).

`manifest.targetDigests` pins `vulnerable` and, when the case has one, `safe`. A bundle is never
built for an unpinned target. `patched` is never pinned: verifyPatch rebuilds it from the
vulnerable commit plus the patch.

### Exhibit records

```ts
{ schemaVersion: 1, kind: 'witness',        witness,        result: ExhibitResult }
{ schemaVersion: 1, kind: 'counterexample', witnessExhibitId, counterexample, result: ExhibitResult }
{ schemaVersion: 1, kind: 'patch',          witnessExhibitId, counterexampleExhibitIds, patch, result: VerifyResult }
```

The submission is stored exactly as submitted, even when malformed, so replay reaches the same
`schema` rejection. A counterexample and a patch name the witness exhibit they ran against, so
replay calls the Judge the same way. The record is filed under the id in its result
(`exhibitId`, or `patchExhibitId` for a patch).

Contracts v1.0 has no digest field for the case file or for each result, so the case file is
listed in `exhibits` under the id `casefile`, and each result is stored inside its exhibit record,
where the exhibit's digest covers it. `manifest.results` lists the exhibits whose result replay
must reproduce, which is every exhibit. A v1.1 contract could give these their own fields; see
"Open questions".

## Integrity check (`openBundle`)

Before anything runs, and failing with `BundleIntegrityError` naming the exhibit:

1. When a digest is expected (loading by address, or from a signed attestation), the tar must hash
   to it.
2. The tar is read in memory, never extracted to disk. Only regular files with safe relative names
   are accepted; links, directories, devices, `..`, absolute names and duplicates are refused, and
   there are caps on entry count, entry size and total size.
3. The manifest parses and has format version 1.
4. Every manifest entry is filed at its expected path, is present, and hashes to its digest. Every
   file in the tar is listed (only `manifest.json` and `verdict.json` are listed by other fields).
5. The verdict hashes to `verdictSha256`.
6. The case file, manifest and verdict name the same case, and the case file's image digests, when
   present, equal the manifest's. Replay uses the manifest's digests.
7. Each record holds the result for its own id, every reference resolves to a record of the right
   kind, `results` lists every record exactly once, and every exhibit the verdict cites is present.

Changing any byte of an exhibit fails step 4 with that exhibit's id. Rewriting a record and its
manifest digest together fails at step 1 when the bundle digest is checked, and from L2-09 the
signature check.

## Replay

`replay(bytes, { judge })` runs the integrity check, then reruns every exhibit in manifest order
through the given `JudgePort`, handing it the case file pinned to the manifest's digests:

- witness: `runWitness(caseFile, witness, ['vulnerable', 'safe'])` (`safe` only when the case has
  one; the Judge adds it anyway);
- counterexample: `runCounterexample(caseFile, witness, counterexample)`;
- patch: `verifyPatch(caseFile, patch, witness, counterexamples)`.

It compares the admissibility outcome, not timings:

- `ExhibitResult`: `exhibitId`, `admissible`, `rejectedBy`, `passed`, `vulnPass`,
  `safeVariantFail`, `familyResults`, and each run's `variant`, `attempt` and `passed`.
- `VerifyResult`: every field except `schemaVersion`.

Durations and output digests differ between machines without the outcome changing, so they are
not compared. The report lists each exhibit as `match`, `mismatch` (with the differing fields) or
`error` (the Judge threw). It is `ok` only when integrity holds and every exhibit matches.

`affidavit replay <bundle>` calls `replayBundle(path)`. Without a Judge it checks integrity only and
returns `REPLAY_EXIT.NOT_RERUN` (2), never success. A sandbox host Judge whose targets boot from
the pinned digests arrives with the L2-04 wiring (`TargetProvider` over boot recipes).

## Stores

`EvidenceStore` (contracts) has three implementations. Every read checks that the bytes hash to
their address and throws `EvidenceCorruptError` when they do not.

- `MemoryEvidenceStore`: tests and one-shot tools.
- `FsEvidenceStore`: `<root>/<2 hex>/<sha256>`, written to a temporary name and renamed, read
  without following symlinks.
- `S3EvidenceStore`: any S3-compatible service, at `<prefix>sha256/<sha256>`. The prefix is per
  tenant (`tenants/<tenantId>/`), one store instance per tenant. Uploads carry
  `x-amz-checksum-sha256`, so the service itself refuses bytes that do not match the address.

`storeBundle` puts every file of the bundle under its own digest and the tar under the bundle
digest; `loadBundle` gets the tar by digest and opens it.

## Evidence

- Unit tests (`pnpm --filter @affidavit/evidence test`): determinism, refusals when building,
  every integrity step, a single flipped byte at many offsets of an exhibit naming that exhibit,
  replay matching, mismatching by field, ignoring timings, Judge failure, the CLI entry point, and
  the three stores (S3 against an in-memory fake).
- Sandbox host (`pnpm --filter @affidavit/evidence test:sandbox-host`): the real Judge with the
  gVisor jail records an admissible witness, a witness rejected by the differential rule and an
  admissible counterexample against stub targets; a fresh Judge on fresh targets and case networks
  replays the bundle to the same outcomes, through `replay` and through `replayBundle`; a bundle
  whose witness code was changed is refused with that exhibit's id before anything runs. 3 of 3 on
  the owner's workstation (2026-11-17).
- S3 (`pnpm --filter @affidavit/evidence test:s3`, needs `AFFIDAVIT_S3_ENDPOINT`,
  `AFFIDAVIT_S3_ACCESS_KEY`, `AFFIDAVIT_S3_SECRET_KEY`): a bundle stored and loaded under a tenant
  prefix, the service refusing an upload whose checksum does not match, and an object replaced
  behind the store being caught on read. 3 of 3 on 2026-11-17 against MinIO 2025-04-22
  (`bitnamilegacy/minio@sha256:50cec18ac4184af4671a78aedd5554942c8ae105d51a465fa82037949046da01`;
  `minio/minio` is no longer pullable from Docker Hub).

## Not done yet

- **Second machine.** The gate needs the bundle to replay on another machine. So far the replay
  ran on the same host with a fresh Judge, fresh targets and fresh networks. This waits on the
  shared sandbox host (P0-10).
- **Real targets from digests.** Replay pins the case file to the manifest digests, but the
  `TargetProvider` that boots those images is the L2-04 wiring. Until then the sandbox-host test
  uses stub targets.
- **Patches.** Patch records and `verifyPatch` replay are implemented and unit tested;
  `verifyPatch` itself is in PR #17, so there is no sandbox-host patch replay yet.
- **Run logs.** `RunRecord` carries stdout and stderr digests, but `JudgePort` does not return the
  logs, so they are not in the bundle.
- **Signature.** L2-09 signs the manifest digest; `replay` will then check the attestation before
  trusting the manifest.

## Open questions for the lead

- Contracts v1.1 could add `caseFileSha256` and a digest per result to `BundleManifest`, instead of
  filing the case file as exhibit `casefile` and results inside exhibit records.
- `apps/cli` maps every non-zero `replayBundle` code to exit 1. `NOT_RERUN` (2) might map better to
  "not implemented" until the sandbox Judge is wired; that is a Lane 1 change.
