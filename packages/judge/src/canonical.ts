import { createHash } from 'node:crypto';
import type { ParamSpace } from '@affidavit/contracts';

/** JSON with object keys sorted at every level, so equal values always hash the same. */
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

/**
 * Content digest of an executable exhibit: what runs (template) over which family (params).
 * The Judge mints exhibit ids from this, so the same witness always gets the same id.
 */
export function exhibitDigest(
  kind: 'witness' | 'counterexample',
  template: string,
  params: ParamSpace,
): string {
  return sha256Hex(canonicalJson({ kind, template, params }));
}
