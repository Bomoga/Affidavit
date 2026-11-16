import { createHash } from 'node:crypto';
import type { CaseId, ExhibitId, ParamSpace } from '@affidavit/contracts';

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
 * Content digest of an executable exhibit: which case it belongs to (caseId), what runs (template)
 * over which family (params). The Judge mints exhibit ids from this, so the same exhibit always
 * gets the same id, and the same code submitted to two cases gets two ids.
 *
 * The recipe is part of the contract with Lane 3 (docs/lanes/lane2/rules-of-evidence.md,
 * "Exhibit ids"), so it can be recomputed without importing this package.
 */
export function exhibitDigest(
  kind: 'witness' | 'counterexample',
  caseId: CaseId,
  template: string,
  params: ParamSpace,
): string {
  return sha256Hex(canonicalJson({ caseId, kind, params, template }));
}

/** Hex digits of the digest kept in an exhibit id. */
export const EXHIBIT_ID_HEX_CHARS = 24;

/** `exhibit-<kind>-<first 24 hex of exhibitDigest>`. */
export function mintExhibitId(
  kind: 'witness' | 'counterexample',
  caseId: CaseId,
  template: string,
  params: ParamSpace,
): ExhibitId {
  const digest = exhibitDigest(kind, caseId, template, params).slice(0, EXHIBIT_ID_HEX_CHARS);
  return `exhibit-${kind}-${digest}` as ExhibitId;
}
