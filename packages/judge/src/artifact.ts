import type { ParamSpace } from '@affidavit/contracts';

/**
 * The result artifact the witness runner writes inside the jail (L2-05 owns the runner side).
 * The Judge reads it as untrusted bytes: size first, then JSON, then shape, never evaluated.
 *
 *   { "schemaVersion": 1, "results": [{ "paramIndex": 0, "passed": true }, ...] }
 *
 * `paramIndex` indexes the cartesian product of the ParamSpace in order, with the last
 * parameter varying fastest. `results` holds exactly one entry per index.
 */
export const RESULT_ARTIFACT_VERSION = 1;

/** Number of parameter combinations in a family. An empty ParamSpace is one run with no params. */
export function familySize(params: ParamSpace): number {
  return params.reduce((n, p) => n * p.values.length, 1);
}

export type ArtifactParse = { ok: true; results: boolean[] } | { ok: false; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const hasOnlyKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).every((k) => keys.includes(k)) && keys.every((k) => k in v);

/** Parses one result artifact for a family of `size` parameters. Never throws. */
export function parseResultArtifact(raw: string, size: number, maxBytes: number): ArtifactParse {
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes > maxBytes)
    return { ok: false, reason: `artifact is ${bytes} bytes, limit ${maxBytes}` };

  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'artifact is not valid JSON' };
  }
  if (!isRecord(doc) || !hasOnlyKeys(doc, ['schemaVersion', 'results'])) {
    return { ok: false, reason: 'artifact must have exactly schemaVersion and results' };
  }
  if (doc.schemaVersion !== RESULT_ARTIFACT_VERSION) {
    return { ok: false, reason: `unsupported artifact schemaVersion` };
  }
  if (!Array.isArray(doc.results)) return { ok: false, reason: 'results is not an array' };
  if (doc.results.length !== size) {
    return { ok: false, reason: `expected ${size} results, got ${doc.results.length}` };
  }

  const results: (boolean | undefined)[] = new Array<boolean | undefined>(size).fill(undefined);
  for (const entry of doc.results as unknown[]) {
    if (!isRecord(entry) || !hasOnlyKeys(entry, ['paramIndex', 'passed'])) {
      return { ok: false, reason: 'each result must have exactly paramIndex and passed' };
    }
    const { paramIndex, passed } = entry;
    if (typeof paramIndex !== 'number' || !Number.isInteger(paramIndex)) {
      return { ok: false, reason: 'paramIndex is not an integer' };
    }
    if (paramIndex < 0 || paramIndex >= size) {
      return { ok: false, reason: `paramIndex ${paramIndex} out of range` };
    }
    if (typeof passed !== 'boolean') return { ok: false, reason: 'passed is not a boolean' };
    if (results[paramIndex] !== undefined) {
      return { ok: false, reason: `paramIndex ${paramIndex} reported twice` };
    }
    results[paramIndex] = passed;
  }
  return { ok: true, results: results as boolean[] };
}
