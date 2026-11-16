import { createHash } from 'node:crypto';

/**
 * Canonical JSON: no whitespace, object keys sorted at every level, array order kept. Matches the
 * recipe in docs/lanes/lane2/rules-of-evidence.md ("Exhibit ids") so ids computed here agree with
 * the ones the Judge mints, without importing Lane 2 code.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${entries.join(',')}}`;
}

export function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Hash of anything an agent returned, for naming a rejected submission. Never throws. */
export function digestOf(value: unknown): string {
  try {
    return sha256Hex(canonicalJson(value));
  } catch {
    return sha256Hex('unhashable');
  }
}
