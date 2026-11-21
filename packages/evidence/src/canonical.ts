import { createHash } from 'node:crypto';

/**
 * JSON with object keys sorted at every level, so equal values always serialize to the same bytes.
 * Same recipe as `@affidavit/judge`'s `canonicalJson`, kept here so the bundle format (and a
 * future public verifier, L2-12) does not depend on the Judge.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${entries.join(',')}}`;
}

/** The canonical JSON of `value` as UTF-8 bytes. Every JSON file in a bundle is written this way. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(canonicalJson(value), 'utf8'));
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export const SHA256_HEX = /^[0-9a-f]{64}$/;
