import { ParamSpace } from '@affidavit/contracts';
import { familySize } from './artifact.js';
import { canonicalJson } from './canonical.js';
import type { JudgePolicy } from './rules.js';

/**
 * CR-T8. A Prosecution counterexample is the family template run over a parameter space the
 * Prosecution chose. Lane 3 writes that space as the first line of the counterexample's code
 * (packages/trial/src/counterexample.ts, `paramsHeader`), so the code, its id and its hash all
 * say what it runs over. `verifyPatch` reads it back here and runs the counterexample over it.
 */
export const COUNTEREXAMPLE_PARAMS_PREFIX = '// affidavit counterexample params: ';

// U+2028 and U+2029 end a line in JavaScript, so a raw one in a value could close the comment and
// run code. Lane 3 escapes them; the header is only accepted in that exact form.
const LINE_SEP = new RegExp(String.fromCharCode(0x2028), 'g');
const PARA_SEP = new RegExp(String.fromCharCode(0x2029), 'g');

/** The header line for a parameter space, byte for byte what Lane 3 writes. */
export function counterexampleParamsHeader(params: ParamSpace): string {
  const json = canonicalJson(params).replace(LINE_SEP, '\\u2028').replace(PARA_SEP, '\\u2029');
  return `${COUNTEREXAMPLE_PARAMS_PREFIX}${json}`;
}

export type CounterexampleParams = { ok: true; params: ParamSpace } | { ok: false; reason: string };

/** True when any object at any depth has an own key named __proto__ (which JSON.parse creates). */
function hasProtoKey(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasProtoKey);
  if (typeof v !== 'object' || v === null) return false;
  return Object.keys(v).some(
    (k) => k === '__proto__' || hasProtoKey((v as Record<string, unknown>)[k]),
  );
}

/**
 * Reads the parameter space a counterexample runs over from its first line. Refused (so the
 * caller fails closed) unless all of these hold:
 *
 * 1. The first line is the prefix plus a JSON value, and code follows it after a `\n`.
 * 2. The JSON parses as the contract `ParamSpace`, with no `__proto__` key at any depth.
 * 3. The line is exactly what `counterexampleParamsHeader` writes for that space (canonical JSON,
 *    separators escaped), so one space has one header and one id.
 * 4. The parameter names are the Defense family's, in the family's order: no new parameter and
 *    no dropped one. Values may differ; that is the point of a counterexample.
 * 5. The space is within the same limits as any family: `maxFamilySize` combinations and
 *    `maxParamsBytes` of canonical JSON.
 *
 * Never throws: hostile input (deep nesting) is a refusal.
 */
export function readCounterexampleParams(
  code: string,
  family: ParamSpace,
  policy: Pick<JudgePolicy, 'maxFamilySize' | 'maxParamsBytes'>,
): CounterexampleParams {
  const end = code.indexOf('\n');
  if (end < 0) return { ok: false, reason: 'no params header line followed by code' };
  const line = code.slice(0, end);
  if (!line.startsWith(COUNTEREXAMPLE_PARAMS_PREFIX)) {
    return { ok: false, reason: 'the first line is not a params header' };
  }
  try {
    const value: unknown = JSON.parse(line.slice(COUNTEREXAMPLE_PARAMS_PREFIX.length));
    if (hasProtoKey(value)) return { ok: false, reason: 'the params contain a __proto__ key' };
    const parsed = ParamSpace.safeParse(value);
    if (!parsed.success) return { ok: false, reason: 'the params are not a ParamSpace' };
    const params = parsed.data;
    if (counterexampleParamsHeader(params) !== line) {
      return { ok: false, reason: 'the params header is not in canonical form' };
    }
    if (params.length !== family.length || params.some((p, i) => p.name !== family[i]?.name)) {
      return { ok: false, reason: 'the params do not name the witness family parameters' };
    }
    if (familySize(params) > policy.maxFamilySize) {
      return { ok: false, reason: 'the params space is over maxFamilySize' };
    }
    if (Buffer.byteLength(canonicalJson(params), 'utf8') > policy.maxParamsBytes) {
      return { ok: false, reason: 'the params are over maxParamsBytes' };
    }
    return { ok: true, params };
  } catch {
    return { ok: false, reason: 'the params header could not be read' };
  }
}
