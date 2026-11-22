# Published signing keys

This directory is a lead path (root `CLAUDE.md`, repo layout). The lead writes or approves every change here. Lane 2 proposes entries; it does not publish them alone.

`keys.json` here is the file public verifiers pass to `pnpm --filter @affidavit/evidence verify ... --keys docs/keys/keys.json` (`docs/lanes/lane2/attestation.md`, "Public verification"). It holds public keys only, never a private key, password or credential. It does not exist yet: no production signing key has been generated (`docs/decisions.md`, P0-10, "Signing key custody and rotation plan"). The first entry is added when that decision is made.

## Format (schema version 1)

```json
{
  "schemaVersion": 1,
  "keys": [
    {
      "keyId": "sha256:<64 lowercase hex>",
      "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
      "status": "active",
      "validFrom": "2026-12-01T00:00:00Z"
    },
    {
      "keyId": "sha256:<64 lowercase hex>",
      "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
      "status": "revoked",
      "validFrom": "2026-11-25T00:00:00Z",
      "revokedAt": "2026-11-30T12:00:00Z"
    }
  ]
}
```

| Field       | Required | Meaning                                                                                                                                                                                                         |
| ----------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keyId`     | yes      | `sha256:` and the hex SHA-256 of the key's DER SubjectPublicKeyInfo, exactly what `publicKeyId` in `@affidavit/evidence` computes and what an attestation's `keyId` holds. Must be the id of `publicKey`.       |
| `publicKey` | yes      | The PEM public key, as cosign writes `cosign.pub`.                                                                                                                                                              |
| `status`    | yes      | `active`: signatures by this key are accepted. `revoked`: never accepted. A key retired by rotation but never compromised stays `active`, so its older verdicts still verify.                                   |
| `validFrom` | no       | When the key started signing. Informational.                                                                                                                                                                    |
| `retiredAt` | no       | When the key stopped signing new verdicts (rotation). Informational.                                                                                                                                            |
| `revokedAt` | no       | When the key was revoked. Only allowed with `status: "revoked"`. Informational: a revoked key is refused whatever this date says, because signatures carry no trusted timestamp, so a forgery can be backdated. |

`verify` reads the file and exits 2 (usage) when it is missing, unreadable, larger than 1 MiB, not JSON, or malformed: an unknown field, an unknown status, an empty `keys` list, a public key that does not parse, a `keyId` that is not its key's id, the same `keyId` twice, or `revokedAt` on a key that is not revoked. So "no list", "unreadable list" and "nothing revoked" never look the same. The parser is `parseKeysFile` in `packages/evidence/src/keys.ts`.

A verifier may also pass `--revoked <keyId>` (repeatable) to refuse a key on top of the file, for a revocation heard of before this file is updated.

## Changing this file

- Rotation: add the new key as `active`, add `retiredAt` to the old one, keep the old one `active`.
- Compromise: set the key's `status` to `revoked` and add `revokedAt`. Never delete a revoked entry, so `verify` keeps saying the key is revoked rather than unknown.
- Every change is a reviewed PR approved by the lead.
