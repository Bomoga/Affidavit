# Signing key custody and rotation: proposal

Status: **proposal for the lead**, not a decision. It answers the open P0-10 item "Signing key custody and rotation plan" in `docs/decisions.md`, which blocks the first real signed verdict. That item has no owner yet (`docs/decisions.md` lists it as unassigned); this proposal assumes the Lane 2 owner and the lead take it, and the lead names the owner when deciding. `docs/decisions.md` and `docs/keys/` are lead paths: the lead writes or approves every change to them, and Lane 2 only proposes.

## What plan.md requires

- A team-managed cosign key, never Sigstore's public keyless flow (verdicts are private and must not reach a public transparency log).
- The key lives where the API process cannot read it: a compromised API can ask for a signature but cannot forge one or copy the key.
- Storage and rotation decided before the first signed verdict.

The first two already hold in code and tests (L2-09): only `apps/signer` touches the key, over a unix socket, and `isolation.integration.test.ts` shows a process with the API's identity gets `EACCES` on the key, its password and its directory.

## Proposal

**For the MVP and the demo: an encrypted cosign key file on the signer's host (option 1 in `attestation.md`).** Move to a cloud KMS key (option 2) only when there is a cloud account and a hosted deployment.

Moving to KMS is a code change, not only a configuration change. `AFFIDAVIT_SIGNER_KEY` already accepts a KMS URI, but `apps/signer/src/cosign.ts` runs cosign with only `PATH`, a throwaway `HOME` and `COSIGN_PASSWORD`, so KMS credentials (`AWS_*`, `GOOGLE_APPLICATION_CREDENTIALS`, `VAULT_ADDR` and `VAULT_TOKEN`, or files under `~/.aws`) never reach it, and signing would fail. The change needed: an explicit, fixed allowlist of credential variables for the chosen provider, passed from the signer's own environment to the cosign subprocess only, plus a test that nothing outside the allowlist is passed. It must not widen anything else: the jail and the witness runner keep holding no credential, and the API and the worker still never see the credential, the key reference or cosign output.

| Point                       | Proposal                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key type                    | ECDSA P-256 made with `cosign generate-key-pair`, the private key encrypted with a password                                                                                                                                                                                                                                                       |
| Where the signer runs       | See "Which host" below. For the demo only: the current sandbox host. Before any outside pilot: a separate signing host that runs no target code                                                                                                                                                                                                   |
| Who generates it            | The key's owner (named by the lead), on the signing host, with the lead present or informed. Never on a laptop that syncs files to a cloud drive                                                                                                                                                                                                  |
| Where the private key lives | One file, mode 0400, owned by a dedicated `affidavit-signer` user. No other user in that user's group. The signer refuses group or world readable key and password files already                                                                                                                                                                  |
| Where the password lives    | The team's secret manager (to be named by the lead), and on the host only as a mode 0400 file for the signer user. Never in the repo, `.env`, chat or CI logs                                                                                                                                                                                     |
| Backup                      | The encrypted key file plus its password, stored as separate entries in the secret manager, so losing the host does not lose the key. Two people can restore it: the lead and the key's owner                                                                                                                                                     |
| Public key                  | Published by the lead in `docs/keys/keys.json` (format in `docs/keys/README.md`): `keyId`, the PEM public key, `status` (`active` or `revoked`) and the dates `validFrom`, `retiredAt` and `revokedAt`. `verify` (L2-12) requires this file (`--keys`), picks the key by the attestation's `keyId`, and refuses any key whose status is `revoked` |
| Who can request signatures  | The API and the worker, through the socket group. They never get the key path, password or cosign output                                                                                                                                                                                                                                          |

The keys file, its format (`docs/keys/README.md`) and `verify --keys` come with PR #77.

Two gaps in the signer's own file checks, held by process until the code adds them: `apps/signer` checks only that the key and password files are not readable by group or others. It does not check that they are owned by the signer's user, and it follows symlinks (`stat`, not `lstat`). So whoever sets up the host must make sure both are regular files owned by `affidavit-signer`, not links.

## Which host

`docs/decisions.md` records the sandbox host as the Lane 2 owner's personal workstation, which also runs untrusted target code and witnesses under gVisor. A signing key on that machine is one gVisor escape away from a forger: code that breaks out of the jail runs as a user on the same host, and from there a local privilege escalation reaches the `affidavit-signer` user's files.

- **Demo:** accept that risk, on the condition that nothing signed by this key is shown to an outside party as proof, and that the key is revoked (not just retired) when the demo is over.
- **Before any outside pilot:** generate a new key on a separate signing host that runs no target code, no sandbox and no witness runner, or move to a KMS key. The lead names that host.

## Rotation

- **Planned:** one new key per year, or before a pilot with an outside party, whichever comes first. The old key stays in `docs/keys/keys.json` with `status: "active"` and a `retiredAt`: it signs nothing new, and its signatures stay valid because the key was never exposed. Once the new key has signed its first verdict, the old private key is destroyed: the file on the host and every backup copy of it and its password in the secret manager. The lead records the destruction date in the decision record.
- **On suspected compromise** (key file or password exposed, host compromised): stop the signer, generate a new key, publish it, and set the old one's `status` to `revoked` with a `revokedAt` in `docs/keys/keys.json`.

The dates (`validFrom`, `retiredAt`, `revokedAt`, the destruction date) let anyone tell a key that was retired and destroyed in good order from one that was compromised. They do not date signatures: verdicts are signed without a timestamp authority (nothing goes to Sigstore), so a signature cannot prove _when_ it was made. If a retired key leaks later, it is treated as a compromise: revoked, and its verdicts handled as below. If all copies were destroyed on the recorded date and a leak is reported after it, the report names a copy that should not exist, which is itself a finding.

## After a compromise

A signature by a revoked key could be a forgery made after the leak, so `verify` refuses revoked keys outright (`attestation.md`, "Public verification"). Verdicts the team still stands behind are re-signed with the new key. Rules:

- Re-signing is only for a bundle whose `bundleSha256` was recorded before the compromise (the verdict row in the database and the evidence store address, both written when the verdict was made). The bundle in the store must hash to that recorded value, and the recording must predate the earliest time the key could have leaked. A bundle with no such record is not re-signed: a forger with the old key could have planted it, and re-signing would turn a forged bundle into a valid one.
- That rule holds only if the database and the evidence store were outside the compromise. Whoever could change them could record a forged bundle's `bundleSha256` with an earlier date. On the demo workstation the signer, the database and the store may share one host, so a host compromise there covers all three: then no stored verdict is re-signed, and each case is rerun from scratch instead.
- Re-signing a manifest changes nothing in the bundle, so `bundleSha256` stays the same.
- **There is no tooling for this yet.** It needs a re-sign job in Lane 2 (read each recorded `bundleSha256`, load and check the bundle, sign its manifest with the new key, store the new attestation) and a way to list the verdicts signed by a given `keyId`. It is not built; until it is, a compromise leaves the old verdicts unverifiable.

## Needs from the lead

1. Accept or change the proposal above.
2. Name the key's owner (P0-10 is unassigned).
3. Name the secret manager the team uses for the password and the backup.
4. Accept the demo-only use of the sandbox host, or name a separate signing host now.
5. Decide when the move to a KMS key happens (suggested: with the first hosted deployment), knowing it needs the signer change above.

Then the key's owner generates the key on the agreed host, proposes the `docs/keys/keys.json` entry for the lead to publish, and the lead records the decision in `docs/decisions.md`.
