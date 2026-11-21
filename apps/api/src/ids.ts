/**
 * Ids are validated before they reach any path, query or store call. The case id rule is the one
 * the web client and the MCP server already enforce on their side.
 */
export const CASE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
/** A non-negative seq without leading zeros, at most 10 digits. */
const SEQ_RE = /^(0|[1-9][0-9]{0,9})$/;

export function isCaseId(v: unknown): v is string {
  return typeof v === 'string' && CASE_ID_RE.test(v);
}

export function isSha256(v: unknown): v is string {
  return typeof v === 'string' && SHA256_RE.test(v);
}

/** Parses a resume position. `undefined` means absent; `null` means present but malformed. */
export function parseSeq(v: unknown): number | undefined | null {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !SEQ_RE.test(v.trim())) return null;
  const n = Number(v.trim());
  return Number.isSafeInteger(n) && n <= 2_147_483_647 ? n : null;
}
