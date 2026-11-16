import {
  Exhibit,
  ParamSpace,
  Witness,
  type CaseFile,
  type ExhibitId,
  type WitnessId,
} from '@affidavit/contracts';
import { canonicalJson, sha256Hex } from './canonical.js';
import type { SubmissionCheck } from './envelope.js';
import { witnessSha256 } from './witness.js';

type Json = ParamSpace[number]['values'][number];

/**
 * What the Prosecution agent may submit: a choice per parameter name of the Defense witness
 * family. It never supplies code, an id, a hash, an author, or a kind. Values are picked by index
 * into the family's declared values, or given as new values for a declared parameter name.
 */
export interface CounterexampleChoice {
  name: string;
  indices?: number[];
  values?: Json[];
}
export interface CounterexampleSubmission {
  choices: CounterexampleChoice[];
}

/** Caps on what an agent can ask the Judge to run. Placeholders, tuned once real runs exist. */
export interface ParamLimits {
  /** Largest product of the counterexample's parameter space (the Judge's maxFamilySize). */
  maxFamilySize: number;
  /** Largest canonical JSON size of one new value, in characters. */
  maxValueChars: number;
}
export const DEFAULT_PARAM_LIMITS: ParamLimits = { maxFamilySize: 64, maxValueChars: 1024 };

const MAX_CHOICES = 32;
const MAX_ENTRIES = 256;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Shape check for the submit_counterexample tool. Hand-written because the submission is not a
 * contract object (the contract has no per-parameter choice type); the resolved ParamSpace is
 * validated against the contract `ParamSpace` schema in `resolveCounterexample`. Unknown keys are
 * dropped, so an agent cannot set an id, hash, author, kind, or code. A prose-only objection has
 * no `choices`, so it fails here and is recorded as inadmissible by the orchestrator.
 */
export function checkCounterexampleSubmission(
  value: unknown,
): SubmissionCheck<CounterexampleSubmission> {
  const errors: string[] = [];
  if (!isPlainObject(value) || !Array.isArray(value.choices)) {
    return { ok: false, errors: ['choices: a counterexample is a list of parameter choices'] };
  }
  if (value.choices.length < 1 || value.choices.length > MAX_CHOICES) {
    errors.push(`choices: expected 1 to ${MAX_CHOICES} entries`);
  }
  const choices: CounterexampleChoice[] = [];
  value.choices.slice(0, MAX_CHOICES).forEach((raw: unknown, i) => {
    if (!isPlainObject(raw) || typeof raw.name !== 'string' || raw.name.length === 0) {
      errors.push(`choices.${i}.name: expected a non-empty string`);
      return;
    }
    const choice: CounterexampleChoice = { name: raw.name };
    if (raw.indices !== undefined) {
      if (
        !Array.isArray(raw.indices) ||
        raw.indices.length > MAX_ENTRIES ||
        !raw.indices.every((n) => Number.isInteger(n) && (n as number) >= 0)
      ) {
        errors.push(`choices.${i}.indices: expected a list of non-negative integers`);
        return;
      }
      choice.indices = raw.indices as number[];
    }
    if (raw.values !== undefined) {
      if (!Array.isArray(raw.values) || raw.values.length > MAX_ENTRIES) {
        errors.push(`choices.${i}.values: expected a list of JSON values`);
        return;
      }
      choice.values = raw.values as Json[];
    }
    if ((choice.indices?.length ?? 0) + (choice.values?.length ?? 0) === 0) {
      errors.push(`choices.${i}: choose at least one index or value`);
      return;
    }
    choices.push(choice);
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { choices } };
}

function kindOf(v: unknown): string {
  if (v === null) return 'null';
  return Array.isArray(v) ? 'array' : typeof v;
}

export type ResolvedCounterexample =
  { ok: true; params: ParamSpace; newValues: number } | { ok: false; errors: string[] };

/**
 * The rule for a counterexample's parameters. A counterexample is sent to the Judge only if all
 * of these hold; otherwise it is recorded as inadmissible (`schema`) and never run.
 *
 * 1. Every chosen name is a parameter name the Defense witness family declares, and no name is
 *    chosen twice. There are no new parameter names and no new attack classes.
 * 2. An index must point at one of that parameter's declared values.
 * 3. A new value must be JSON, no longer than `maxValueChars` when written canonically, and of a
 *    JSON kind (string, number, boolean, null, array, object) the family already uses for that
 *    parameter. It stays inside the family's shape; it only extends the values.
 * 4. Values are de-duplicated. A parameter the agent does not choose keeps all its declared values.
 * 5. The whole counterexample space (the product of every parameter's values) is at most
 *    `maxFamilySize`, like any family the Judge will run.
 * 6. The result must parse as the contract `ParamSpace`.
 *
 * The parameter order is the family's, so the Judge's `paramIndex` order matches.
 */
export function resolveCounterexample(
  family: ParamSpace,
  submission: CounterexampleSubmission,
  limits: ParamLimits = DEFAULT_PARAM_LIMITS,
): ResolvedCounterexample {
  const errors: string[] = [];
  const declared = new Set(family.map((p) => p.name));
  const chosen = new Map<string, CounterexampleChoice>();
  for (const c of submission.choices) {
    if (!declared.has(c.name)) {
      errors.push(
        `parameter ${JSON.stringify(c.name)} is not declared by the witness family (declared: ${family.map((p) => p.name).join(', ')})`,
      );
    } else if (chosen.has(c.name)) {
      errors.push(`parameter ${JSON.stringify(c.name)} is chosen more than once`);
    } else chosen.set(c.name, c);
  }

  let newValues = 0;
  const params: ParamSpace = family.map((p) => {
    const c = chosen.get(p.name);
    if (!c) return { name: p.name, values: [...p.values] };
    const kinds = new Set(p.values.map(kindOf));
    const declaredKeys = new Set(p.values.map((v) => canonicalJson(v)));
    const seen = new Set<string>();
    const values: Json[] = [];
    const add = (v: Json, key: string): void => {
      if (seen.has(key)) return;
      seen.add(key);
      values.push(v);
    };
    for (const i of c.indices ?? []) {
      const v = p.values[i];
      if (v === undefined) {
        errors.push(`${p.name}: index ${i} is outside the ${p.values.length} declared values`);
      } else add(v, canonicalJson(v));
    }
    for (const v of c.values ?? []) {
      let key: string;
      try {
        key = canonicalJson(v);
      } catch {
        errors.push(`${p.name}: a value could not be read as JSON`);
        continue;
      }
      if (!declaredKeys.has(key)) {
        if (key.length > limits.maxValueChars) {
          errors.push(`${p.name}: a new value is over ${limits.maxValueChars} characters`);
          continue;
        }
        if (!kinds.has(kindOf(v))) {
          errors.push(
            `${p.name}: a new ${kindOf(v)} value, but the family declares ${[...kinds].join(' or ')} values`,
          );
          continue;
        }
        if (!seen.has(key)) newValues++;
      }
      add(v, key);
    }
    return { name: p.name, values };
  });

  if (errors.length === 0) {
    const size = params.reduce((n, p) => n * p.values.length, 1);
    if (size > limits.maxFamilySize) {
      errors.push(
        `the counterexample space has ${size} combinations; the cap is ${limits.maxFamilySize}`,
      );
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const parsed = ParamSpace.safeParse(params);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `params: ${i.message}`) };
  }
  return { ok: true, params: parsed.data, newValues };
}

/**
 * The first line of a counterexample's code: the chosen parameter space, as one comment line, so
 * the code (and so its id and hash) says what it runs over. U+2028 and U+2029 end a line in
 * JavaScript, so they are escaped; otherwise a string value could close the comment and run code.
 */
const LINE_SEP = new RegExp(String.fromCharCode(0x2028), 'g');
const PARA_SEP = new RegExp(String.fromCharCode(0x2029), 'g');

export function paramsHeader(params: ParamSpace): string {
  const json = canonicalJson(params).replace(LINE_SEP, '\\u2028').replace(PARA_SEP, '\\u2029');
  return `// affidavit counterexample params: ${json}`;
}

/** Code is the family template plus the chosen parameters, never agent text. */
export function counterexampleCode(template: string, params: ParamSpace): string {
  return `${paramsHeader(params)}\n${template}`;
}

/** Judge id recipe (docs/lanes/lane2/rules-of-evidence.md, "Exhibit ids") for a counterexample. */
export function counterexampleExhibitId(
  caseId: CaseFile['id'],
  code: string,
  params: ParamSpace,
): ExhibitId {
  const digest = sha256Hex(
    canonicalJson({ caseId, kind: 'counterexample', params, template: code }),
  );
  return `exhibit-counterexample-${digest.slice(0, 24)}` as ExhibitId;
}

export interface BuiltCounterexample {
  /** The contract counterexample exhibit. Every field is set here. */
  exhibit: Exhibit;
  /**
   * The witness handed to `runCounterexample` alongside the exhibit. The Judge runs a
   * counterexample over the ParamSpace of that witness, so this carries the counterexample's
   * chosen space. Authored by `prosecution`; the Defense witness itself is never altered.
   */
  witness: Witness;
}

/**
 * Builds the contract counterexample Exhibit and its carrier Witness. Id, case, kind, author, code,
 * hash, and schema version are all computed here; none comes from the agent.
 */
export function buildCounterexample(
  caseFile: CaseFile,
  family: Witness,
  params: ParamSpace,
): BuiltCounterexample {
  const code = counterexampleCode(family.template, params);
  const exhibit = Exhibit.parse({
    schemaVersion: 1,
    id: counterexampleExhibitId(caseFile.id, code, params),
    caseId: caseFile.id,
    kind: 'counterexample',
    author: 'prosecution',
    code,
    sha256: sha256Hex(code),
  });
  const sha256 = witnessSha256(family.template, params);
  const witness = Witness.parse({
    schemaVersion: 1,
    id: `witness-${sha256Hex(canonicalJson({ caseId: caseFile.id, from: family.id, sha256 })).slice(0, 24)}` as WitnessId,
    caseId: caseFile.id,
    cls: family.cls,
    template: family.template,
    params,
    author: 'prosecution',
    sha256,
  });
  return { exhibit, witness };
}
