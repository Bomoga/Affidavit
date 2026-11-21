# Signing key custody and rotation: proposal

Status: **proposal for the lead**, not a decision. It answers the open P0-10 item "Signing key custody and rotation plan" in `docs/decisions.md` (owner: Lane 2 owner with the lead), which blocks the first real signed verdict. Nothing in the code waits on it: `AFFIDAVIT_SIGNER_KEY` takes any cosign key reference (`attestation.md`, "Key custody").

## What plan.md requires

- A team-managed cosign key, never Sigstore's public keyless flow (verdicts are private and must not reach a public transparency log).
- The key lives where the API process cannot read it: a compromised API can ask for a signature but cannot forge one or copy the key.
- Storage and rotation decided before the first signed verdict.

The first two already hold in code and tests (L2-09): only `apps/signer` touches the key, over a unix socket, and `isolation.integration.test.ts` shows a process with the API's identity gets `EACCES` on the key, its password and its directory.

## Proposal

**For the MVP and the demo: an encrypted cosign key file on the signer's host (option 1 in `attestation.md`).** Move to a cloud KMS key (option 2) only when there is a cloud account and a hosted deployment; the switch is a configuration change, not a code change.

| Point                       | Proposal                                                                                                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key type                    | ECDSA P-256 made with `cosign generate-key-pair`, the private key encrypted with a password                                                                                                                                                   |
| Who generates it            | The Lane 2 owner, on the signer's host, with the lead present or informed. Never on a laptop that syncs files to a cloud drive                                                                                                                |
| Where the private key lives | One file, mode 0400, owned by a dedicated `affidavit-signer` user. No other user in that user's group. The signer refuses group or world readable key and password files already                                                              |
| Where the password lives    | The team's secret manager (to be named by the lead), and on the host only as a mode 0400 file for the signer user. Never in the repo, `.env`, chat or CI logs                                                                                 |
| Backup                      | The encrypted key file plus its password, stored separately in the secret manager, so losing the host does not lose the key. Two people can restore it: the lead and the Lane 2 owner                                                         |
| Public key                  | Published in the repo at `docs/keys/affidavit-signer-<YYYY>-<n>.pub` with its `keyId` and validity dates in `docs/keys/README.md`. Anyone verifying (L2-12) passes every published key; the attestation's `keyId` selects the one that signed |
| Who can request signatures  | The API and the worker, through the socket group. They never get the key path, password or cosign output                                                                                                                                      |

## Rotation

- **Planned:** one new key per year, or before a pilot with an outside party, whichever comes first. The old public key stays published, marked "retired": it signs nothing new, and its signatures stay valid because the key was never exposed (a signing date could not be proven anyway, see below). The old private key is destroyed after the new one signs its first verdict.
- **On suspected compromise** (key file or password exposed, host compromised): stop the signer, generate a new key, publish it, and mark the old one **revoked** in `docs/keys/README.md`.

One limit to know: verdicts are signed without a timestamp authority (nothing goes to Sigstore), so a signature cannot prove _when_ it was made. After a revocation, a signature by the old key could be a forgery made after the leak. So on compromise, every stored verdict signed by the revoked key is re-signed with the new key: the bundles are kept in the evidence store, and re-signing a manifest changes nothing in the bundle. The verifier should then refuse revoked keys outright. That last part (a revoked-keys list read by `verify`) is a small follow-up in `@affidavit/evidence` once this proposal is accepted.

## Needs from the lead

1. Accept or change the proposal above.
2. Name the secret manager the team uses for the password and the backup.
3. Decide when the move to a KMS key happens (suggested: with the first hosted deployment).

Then Lane 2 generates the key on the sandbox host, publishes the public key and records the decision in `docs/decisions.md`.
