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

/** Smallest RSA modulus accepted for a published key. */
export const MIN_RSA_BITS = 2048;

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
 * Why `pem` is not exactly one PEM public key, or undefined when it is. The text must be the
 * SubjectPublicKeyInfo PEM that the key itself exports (one `BEGIN PUBLIC KEY` block, nothing
 * before or after it, line endings aside), so a private key, a second block or stray text is
 * refused rather than silently reduced to the first public key in it. RSA keys need at least
 * `MIN_RSA_BITS` bits.
 */
export function publicKeyProblem(pem: string): string | undefined {
  if (pem.includes('PRIVATE KEY')) return 'is a private key, not a public key';
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    return 'is not a PEM public key';
  }
  const exported = key.export({ type: 'spki', format: 'pem' }) as string;
  const norm = (s: string) => s.replace(/\r\n/g, '\n').trim();
  if (norm(exported) !== norm(pem)) {
    return 'is not exactly one PEM public key block';
  }
  const bits = key.asymmetricKeyDetails?.modulusLength;
  if (key.asymmetricKeyType?.startsWith('rsa') === true && (bits ?? 0) < MIN_RSA_BITS) {
    return `is an RSA key under ${MIN_RSA_BITS} bits`;
  }
  return undefined;
}

/**
 * The first object member name that appears twice in one object of `text`, or undefined.
 * `JSON.parse` keeps the last of duplicate members, so `"status":"revoked","status":"active"`
 * would read as active; the keys file refuses that instead. `text` must already be valid JSON.
 */
export function duplicateJsonMember(text: string): string | undefined {
  let i = 0;
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++;
  };
  const str = (): string => {
    const start = i;
    i++; // opening quote
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (): string | undefined => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const names = new Set<string>();
      ws();
      if (text[i] === '}') {
        i++;
        return undefined;
      }
      for (;;) {
        ws();
        const name = str();
        if (names.has(name)) return name;
        names.add(name);
        ws();
        i++; // colon
        const dup = value();
        if (dup !== undefined) return dup;
        ws();
        if (text[i++] === '}') return undefined;
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') {
        i++;
        return undefined;
      }
      for (;;) {
        const dup = value();
        if (dup !== undefined) return dup;
        ws();
        if (text[i++] === ']') return undefined;
      }
    }
    if (c === '"') {
      str();
      return undefined;
    }
    while (i < text.length && !',]} \t\n\r'.includes(text[i]!)) i++;
    return undefined;
  };
  return value();
}

/**
 * Parses and checks a keys file. Malformed when it is not JSON, repeats a member name in one
 * object, does not match the schema, has a public key that is not exactly one PEM public key
 * (`publicKeyProblem`), a `keyId` that is not the id of its public key, a duplicate key id, a
 * `revokedAt` on a key that is not revoked, or a `retiredAt` or `revokedAt` before `validFrom`.
 */
export function parseKeysFile(text: string): ParsedKeys {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'the keys file is not JSON' };
  }
  const dup = duplicateJsonMember(text);
  if (dup !== undefined) {
    return { ok: false, reason: `the keys file repeats the member ${JSON.stringify(dup)}` };
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
    const problem = publicKeyProblem(key.publicKey);
    if (problem !== undefined) {
      return { ok: false, reason: `the keys file has a publicKey that ${problem} at ${at}` };
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
    if (key.validFrom !== undefined) {
      const from = Date.parse(key.validFrom);
      for (const field of ['retiredAt', 'revokedAt'] as const) {
        const t = key[field];
        if (t !== undefined && Date.parse(t) < from) {
          return { ok: false, reason: `the keys file has ${field} before validFrom at ${at}` };
        }
      }
    }
  }
  return { ok: true, keys: parsed.data.keys };
}
