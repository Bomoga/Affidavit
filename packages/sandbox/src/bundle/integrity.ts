import { createHash } from 'node:crypto';

/** Hash algorithms a lockfile `integrity` string may name (Subresource Integrity, as npm writes it). */
export type HashAlgo = 'sha1' | 'sha256' | 'sha384' | 'sha512';

const DIGEST_BYTES: Readonly<Record<HashAlgo, number>> = {
  sha1: 20,
  sha256: 32,
  sha384: 48,
  sha512: 64,
};

export interface IntegrityHash {
  algo: HashAlgo;
  /** Lowercase hex of the digest. */
  hex: string;
}

const TOKEN = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/;

/**
 * Parses an npm `integrity` value (`sha512-<base64>`, possibly several space-separated hashes).
 * Null when it is missing, malformed, carries SRI options, or a digest has the wrong length or a
 * non-canonical base64 encoding. Every hash it returns is checked against the bytes; npm itself
 * picks one, we require all of them to match.
 */
export function parseIntegrity(value: unknown): IntegrityHash[] | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return null;
  const out: IntegrityHash[] = [];
  for (const token of value.trim().split(/\s+/)) {
    const m = TOKEN.exec(token);
    if (m === null) return null;
    const algo = m[1] as HashAlgo;
    const b64 = m[2] as string;
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length !== DIGEST_BYTES[algo] || bytes.toString('base64') !== b64) return null;
    out.push({ algo, hex: bytes.toString('hex') });
  }
  return out.length === 0 ? null : out;
}

export const digestHex = (algo: HashAlgo, data: Buffer): string =>
  createHash(algo).update(data).digest('hex');

/** Null when every hash in `integrity` matches `data`, else the first algorithm that does not. */
export function integrityMismatch(
  integrity: readonly IntegrityHash[],
  data: Buffer,
): string | null {
  for (const h of integrity) {
    if (digestHex(h.algo, data) !== h.hex) return h.algo;
  }
  return null;
}

export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const SHA512_HEX = /^[0-9a-f]{128}$/;

/** sha256 over the canonical JSON of a value (keys sorted at every level, no whitespace). */
export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
