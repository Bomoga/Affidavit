import { createPublicKey } from 'node:crypto';
import { z } from 'zod';
import { publicKeyId } from './attestation.js';

/**
 * The published signing keys file (format in docs/keys/README.md). `verify` reads it and refuses
 * to run without it, so a revoked key cannot be forgotten: "no list", "unreadable list" and
 * "nothing revoked" are three different things, and only the last one verifies.
 */

/** A key id as `publicKeyId` makes it: the SHA-256 of the key's DER SubjectPublicKeyInfo. */
export const KEY_ID = /^sha256:[0-9a-f]{64}$/;

/** Largest keys file read. */
export const MAX_KEYS_FILE_BYTES = 1024 * 1024;

const Timestamp = z.iso.datetime({ offset: true });

const PublishedKeyShape = z.strictObject({
  keyId: z.string().regex(KEY_ID),
  /** PEM SubjectPublicKeyInfo, as cosign writes `cosign.pub`. */
  publicKey: z.string().min(1),
  /** `active`: its signatures are accepted. `revoked`: never accepted, whatever their date. */
  status: z.enum(['active', 'revoked']),
  /** When the key was first used. Informational: a signature carries no trusted time. */
  validFrom: Timestamp.optional(),
  /** When the key stopped signing new verdicts (rotation). Informational. */
  retiredAt: Timestamp.optional(),
  /** When the key was revoked. Informational; only valid with status `revoked`. */
  revokedAt: Timestamp.optional(),
});

export type PublishedKey = z.infer<typeof PublishedKeyShape>;

const KeysFileShape = z.strictObject({
  schemaVersion: z.literal(1),
  keys: z.array(PublishedKeyShape).min(1),
});

export type KeysFile = z.infer<typeof KeysFileShape>;

export type ParsedKeys = { ok: true; keys: PublishedKey[] } | { ok: false; reason: string };

/**
 * Parses and checks a keys file. Malformed when it is not JSON, does not match the schema, has a
 * public key that does not parse, a `keyId` that is not the id of its public key, a duplicate key
 * id, or a `revokedAt` on a key that is not revoked.
 */
export function parseKeysFile(text: string): ParsedKeys {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'the keys file is not JSON' };
  }
  const parsed = KeysFileShape.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where =
      issue === undefined || issue.path.length === 0
        ? ''
        : ` at ${issue.path.map(String).join('.')}`;
    return { ok: false, reason: `the keys file is not a keys file${where}` };
  }
  const seen = new Set<string>();
  for (const [i, key] of parsed.data.keys.entries()) {
    const at = `keys.${i}`;
    try {
      createPublicKey(key.publicKey);
    } catch {
      return { ok: false, reason: `the keys file has a public key that is not PEM at ${at}` };
    }
    if (publicKeyId(key.publicKey) !== key.keyId) {
      return { ok: false, reason: `the keys file has a keyId that is not its key's id at ${at}` };
    }
    if (seen.has(key.keyId)) {
      return { ok: false, reason: `the keys file lists ${key.keyId} twice` };
    }
    seen.add(key.keyId);
    if (key.revokedAt !== undefined && key.status !== 'revoked') {
      return {
        ok: false,
        reason: `the keys file has revokedAt on a key that is not revoked at ${at}`,
      };
    }
  }
  return { ok: true, keys: parsed.data.keys };
}
